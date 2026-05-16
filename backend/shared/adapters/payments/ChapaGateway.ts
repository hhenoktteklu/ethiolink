// EthioLink — Chapa payment gateway adapter.
//
// Phase 10 first commit. Concrete `PaymentGateway` implementation
// against Chapa (https://chapa.co), an Ethiopian payments aggregator
// reaching Telebirr, CBE Birr, Amole, M-Pesa Ethiopia, Visa, and
// Mastercard from a single REST API. Chapa is the recommended
// first provider for EthioLink because its sandbox + signing model
// fit the redirect-then-confirm shape the `PaymentGateway` port
// already expects.
//
// This commit is adapter-only:
//
//   * `authorize` — POSTs `/v1/transaction/initialize`, returns a
//     PENDING `PaymentAuthorization` with `redirectUrl`. The handler
//     layer surfaces the redirect URL to the mobile client (in a
//     later commit); for now, no call site routes here yet —
//     `paymentGatewayFactory` only constructs the Chapa gateway
//     when the env opts in (`PAYMENTS_PROVIDER = "chapa"`), and the
//     existing appointment / featuring Lambdas still hand-construct
//     `CashGateway` + `MockOnlineGateway` per Phase 9's wiring. The
//     follow-up "Phase 10: route online appointments through Chapa"
//     commit threads the factory through.
//
//   * `verify` — GETs `/v1/transaction/verify/:tx_ref`, returns a
//     terminal `PaymentAuthorization`. Webhook handler (Phase 10
//     commit 3) issues this after the Chapa callback so we never
//     trust the webhook payload directly.
//
// Wire shape (Chapa public API, current as of May 2026):
//
//   `authorize` request:
//     POST {apiBaseUrl}/v1/transaction/initialize
//     Authorization: Bearer <secretKey>
//     Content-Type: application/json
//     {
//       "amount": "500",                     // string-encoded ETB
//       "currency": "ETB",
//       "email": "u_<userId>@payments.ethiolink.local",
//       "first_name": "...",                 // optional, see below
//       "tx_ref": "feat-<subscriptionId>-<idem8>",
//       "callback_url": "<webhook-url>",
//       "return_url": "<deep-link-or-config>",
//       "customization": {
//         "title": "EthioLink",
//         "description": "Featured listing (FEATURING_30D)"
//       }
//     }
//
//   `authorize` success (200):
//     { "status": "success", "data": { "checkout_url": "https://..." } }
//
//   `verify` request:
//     GET {apiBaseUrl}/v1/transaction/verify/<tx_ref>
//     Authorization: Bearer <secretKey>
//
//   `verify` success / failure (200):
//     { "status": "success", "data": { "status": "success" | "pending" |
//                                       "failed", "tx_ref": "...",
//                                       "amount": "500", ... } }
//
// Outcome mapping:
//
//   * `authorize` 2xx with `data.checkout_url` →
//     `status: 'PENDING'`, `redirectUrl: data.checkout_url`,
//     `providerRef: tx_ref`.
//   * `authorize` 4xx → throw `PaymentGatewayError('CHAPA_INVALID_REQUEST',
//     <message>)`. The handler layer maps to 502 / 500 with a stable
//     code so a future incident report can grep this string.
//   * `authorize` 5xx / network / timeout →
//     `PaymentGatewayError('CHAPA_UNAVAILABLE', <message>)`.
//   * `verify` 2xx + `data.status === 'success'` → SUCCEEDED.
//   * `verify` 2xx + `data.status === 'failed'`  → FAILED with
//     `errorCode: 'CHAPA_DECLINED'`.
//   * `verify` 2xx + `data.status === 'pending'` → PENDING (the
//     webhook landed before Chapa's own state settled; the caller
//     no-ops and waits for the next webhook).
//   * `verify` non-2xx / network → same `CHAPA_UNAVAILABLE` throw
//     as `authorize`.
//
// Transport seam:
//   The gateway depends on `ChapaHttpTransport`, not `fetch`
//   directly, so the test suite injects a `FakeChapaHttpTransport`
//   that scripts responses without a network round-trip. Production
//   passes `defaultFetchChapaHttpTransport()` which uses Node 20's
//   global `fetch` with an `AbortController`-driven timeout.
//
// Idempotency:
//   Chapa keys idempotency off `tx_ref` (their term for the
//   client-side transaction reference). The caller's `idempotencyKey`
//   feeds into `tx_ref` via `paymentGatewayFactory` so a retry of
//   the same `authorize` call collapses to the same Chapa
//   transaction. The gateway itself does not generate `tx_ref` —
//   that's the service-layer's job (it has access to the
//   appointment / subscription id needed for the slug). The
//   adapter accepts `tx_ref` as part of the input metadata when
//   the upstream service supplies one (Phase 10 commit 2 widens
//   the input shape); this commit ships the adapter against the
//   already-narrow `PaymentAuthorizationInput` and synthesizes a
//   default `tx_ref` from the appointment / subscription id +
//   `idempotencyKey`. Both call sites already pass an
//   `idempotencyKey` so the synthesized ref is stable across
//   retries.

import type {
    AppointmentAuthorizationInput,
    FeaturingAuthorizationInput,
    PaymentAuthorization,
    PaymentAuthorizationInput,
    PaymentGateway,
} from './PaymentGateway.js';
import { PaymentGatewayError } from './PaymentGateway.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration the gateway consumes. Mirrors the shape that
 * `loadConfig.buildChapaProviderConfig` produces, but is defined
 * here so the adapter doesn't depend on `loadConfig.ts` — the
 * same direction the SMS / Telegram adapters follow.
 *
 * The factory (`paymentGatewayFactory.ts`) constructs the gateway
 * only when this config is non-null; the gateway throws if asked
 * to operate with an empty secret key so a programming error is
 * loud rather than silent.
 */
export interface ChapaProviderConfig {
    /** Chapa REST API base. No trailing slash required; the gateway normalizes. Defaults to `https://api.chapa.co`. */
    readonly apiBaseUrl: string;
    /** Chapa secret key (`CHASECK_…`). Plain in dev; resolved from Secrets Manager in prod via `loadSecretsThenConfig`. */
    readonly secretKey: string;
    /** ARN of the Secrets Manager secret holding the secret key, when set. Empty in dev. Adapter does not consume; passthrough for visibility. */
    readonly secretKeySecretArn: string;
    /** Webhook signing secret. Resolved alongside `secretKey`. Adapter does not consume — only the webhook handler does — recorded here for parity with the config block. */
    readonly webhookSecret: string;
    /** ARN of the Secrets Manager secret holding the webhook secret, when set. */
    readonly webhookSecretSecretArn: string;
    /** Default return URL passed to Chapa as `return_url`. The mobile client deep-links back via this URL after the user completes / cancels at Chapa's hosted checkout. */
    readonly returnUrl: string;
    /** HTTP request timeout in milliseconds. Default 12000 (12s). */
    readonly timeoutMs: number;
    /** Provider identifier echoed on the authorization result + persisted to `payment_intents.provider`. Always `'CHAPA'`. */
    readonly providerName: 'CHAPA';
}

/**
 * Options accepted by {@link ChapaHttpTransport.request}. The
 * gateway builds these from the configured + input data and hands
 * them off to the transport.
 */
export interface ChapaHttpRequestOptions {
    /** HTTP method. The gateway uses POST + GET only. */
    readonly method: 'GET' | 'POST';
    /** Parsed JSON body, or `undefined` for GET. */
    readonly body?: unknown;
    /** Request headers. The transport passes these through unchanged. */
    readonly headers: Record<string, string>;
    /** Per-request timeout in milliseconds. */
    readonly timeoutMs: number;
}

/**
 * Response shape the transport returns. Same parse contract as the
 * SMS gateway's `SmsHttpResponse` — JSON when parseable, raw
 * string otherwise, `null` when the body is empty. The gateway is
 * the only place that interprets these.
 */
export interface ChapaHttpResponse {
    readonly status: number;
    readonly body: unknown;
}

/** Transport seam between the gateway and `fetch`. */
export interface ChapaHttpTransport {
    request(
        url: string,
        options: ChapaHttpRequestOptions,
    ): Promise<ChapaHttpResponse>;
}

// ---------------------------------------------------------------------------
// Typed errors — subclasses of PaymentGatewayError
// ---------------------------------------------------------------------------

/**
 * Chapa rejected the request shape (bad amount, missing field,
 * unauthorized — i.e. 4xx). Distinct from `CHAPA_UNAVAILABLE` so
 * the booking / featuring service can decide whether to retry
 * (`UNAVAILABLE` → maybe; `INVALID_REQUEST` → never).
 */
export class ChapaInvalidRequestError extends PaymentGatewayError {
    public readonly status: number;
    constructor(status: number, message: string) {
        super('CHAPA_INVALID_REQUEST', message);
        this.name = 'ChapaInvalidRequestError';
        this.status = status;
    }
}

/**
 * Chapa is unreachable (5xx, network error, timeout). The service
 * layer leaves the `payment_intents` row PENDING / `subscriptions`
 * row PENDING_PAYMENT so the sweep can recover them. A future
 * retry job (post-MVP) can re-attempt against this error class.
 */
export class ChapaUnavailableError extends PaymentGatewayError {
    constructor(message: string) {
        super('CHAPA_UNAVAILABLE', message);
        this.name = 'ChapaUnavailableError';
    }
}

/**
 * Chapa returned a successful HTTP response but with `status =
 * 'failed'` in the body — i.e. a hard upstream rejection of the
 * transaction (insufficient funds, declined card, fraud rule).
 * Surfaces from `verify`; `authorize` doesn't reach this branch
 * because `initialize` never returns 'failed' on the wire.
 *
 * The error class is thrown only for `verify` because `verify`
 * has no `PaymentAuthorization` shape to return — wait, it does.
 * Reconsidered: `verify` returns the `PaymentAuthorization` with
 * `status: 'FAILED'`. This class stays for `authorize`-side
 * future use only (e.g. a Chapa quirk where they 200 with a
 * failed body); for the MVP commit it isn't thrown. Kept exported
 * for callers that want to discriminate on it.
 */
export class ChapaDeclinedError extends PaymentGatewayError {
    constructor(message: string) {
        super('CHAPA_DECLINED', message);
        this.name = 'ChapaDeclinedError';
    }
}

// ---------------------------------------------------------------------------
// Default fetch-based transport
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 12000;

/**
 * Production transport. Uses Node 20's global `fetch` with an
 * `AbortController`-driven timeout. Parses the response body as
 * JSON when possible; falls back to the raw text when JSON
 * parsing fails (so a Chapa 5xx HTML page still surfaces in
 * `rawResponse` rather than crashing the gateway).
 */
export function defaultFetchChapaHttpTransport(): ChapaHttpTransport {
    return {
        async request(url, options) {
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(),
                options.timeoutMs,
            );
            try {
                const init: RequestInit = {
                    method: options.method,
                    headers: options.headers,
                    signal: controller.signal,
                };
                if (options.method !== 'GET' && options.body !== undefined) {
                    init.body = JSON.stringify(options.body);
                }
                const response = await fetch(url, init);
                const text = await response.text();
                let parsed: unknown = null;
                if (text) {
                    try {
                        parsed = JSON.parse(text);
                    } catch {
                        parsed = text;
                    }
                }
                return { status: response.status, body: parsed };
            } finally {
                clearTimeout(timer);
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory used by `paymentGatewayFactory` to construct the gateway
 * from `AppConfig.chapaProvider`. Throws when the config is null —
 * the caller checks first, but the throw makes a programming
 * error loud.
 */
export function createChapaGateway(
    config: ChapaProviderConfig | null,
    transport: ChapaHttpTransport = defaultFetchChapaHttpTransport(),
): ChapaGateway {
    if (!config) {
        throw new PaymentGatewayError(
            'CHAPA_NOT_CONFIGURED',
            'Chapa provider config is missing. Set PAYMENTS_PROVIDER=chapa, ' +
                'CHAPA_SECRET_KEY (or CHAPA_SECRET_KEY_SECRET_ARN), and ' +
                'CHAPA_WEBHOOK_SECRET (or CHAPA_WEBHOOK_SECRET_SECRET_ARN).',
        );
    }
    if (!config.secretKey || config.secretKey.trim() === '') {
        throw new PaymentGatewayError(
            'CHAPA_NOT_CONFIGURED',
            'Chapa secret key is empty. Resolve CHAPA_SECRET_KEY before constructing the gateway.',
        );
    }
    return new ChapaGateway(config, transport);
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export class ChapaGateway implements PaymentGateway {
    public readonly provider = 'CHAPA' as const;

    private readonly config: ChapaProviderConfig;
    private readonly transport: ChapaHttpTransport;

    constructor(
        config: ChapaProviderConfig,
        transport: ChapaHttpTransport = defaultFetchChapaHttpTransport(),
    ) {
        this.config = config;
        this.transport = transport;
    }

    async authorize(
        input: PaymentAuthorizationInput,
    ): Promise<PaymentAuthorization> {
        const txRef = synthesizeTxRef(input);
        const amountString = formatAmountEtb(input.amountEtb);
        const url = `${normalizeBase(this.config.apiBaseUrl)}/v1/transaction/initialize`;
        const customerEmail = syntheticEmailForInput(input);

        const requestBody: Record<string, unknown> = {
            amount: amountString,
            currency: 'ETB',
            email: customerEmail,
            tx_ref: txRef,
            return_url: this.config.returnUrl,
            customization: {
                title: 'EthioLink',
                description: describePurpose(input),
            },
        };

        const authorizedAt = new Date().toISOString();
        const response = await this.requestWithErrors(
            url,
            {
                method: 'POST',
                body: requestBody,
                headers: this.authHeaders(),
                timeoutMs: this.config.timeoutMs,
            },
        );

        const checkoutUrl = extractCheckoutUrl(response.body);
        if (response.status >= 400) {
            throw new ChapaInvalidRequestError(
                response.status,
                describeUpstreamError(response.body, response.status),
            );
        }
        if (!checkoutUrl) {
            // Successful HTTP status but the body didn't carry a
            // checkout URL. Treat as upstream unavailability — Chapa
            // has changed its API shape, which is recoverable by
            // retry once it stabilises.
            throw new ChapaUnavailableError(
                'Chapa initialize returned no checkout URL. Body: ' +
                    safeStringify(response.body),
            );
        }

        return Object.freeze<PaymentAuthorization>({
            status: 'PENDING',
            provider: 'CHAPA',
            providerRef: txRef,
            rawResponse: response.body,
            errorCode: null,
            errorMessage: null,
            authorizedAt,
            redirectUrl: checkoutUrl,
        });
    }

    async verify(providerRef: string): Promise<PaymentAuthorization> {
        if (!providerRef || providerRef.trim() === '') {
            throw new PaymentGatewayError(
                'CHAPA_INVALID_REQUEST',
                'verify(providerRef) called with empty providerRef.',
            );
        }
        const url = `${normalizeBase(this.config.apiBaseUrl)}/v1/transaction/verify/${encodeURIComponent(providerRef)}`;
        const authorizedAt = new Date().toISOString();
        const response = await this.requestWithErrors(url, {
            method: 'GET',
            headers: this.authHeaders(),
            timeoutMs: this.config.timeoutMs,
        });

        if (response.status >= 400) {
            throw new ChapaInvalidRequestError(
                response.status,
                describeUpstreamError(response.body, response.status),
            );
        }

        const inner = extractVerifyData(response.body);
        switch (inner.status) {
            case 'success':
                return Object.freeze<PaymentAuthorization>({
                    status: 'SUCCEEDED',
                    provider: 'CHAPA',
                    providerRef,
                    rawResponse: response.body,
                    errorCode: null,
                    errorMessage: null,
                    authorizedAt,
                    redirectUrl: null,
                });
            case 'failed':
                return Object.freeze<PaymentAuthorization>({
                    status: 'FAILED',
                    provider: 'CHAPA',
                    providerRef,
                    rawResponse: response.body,
                    errorCode: 'CHAPA_DECLINED',
                    errorMessage:
                        inner.message ?? 'Chapa reported the transaction failed.',
                    authorizedAt,
                    redirectUrl: null,
                });
            case 'pending':
                return Object.freeze<PaymentAuthorization>({
                    status: 'PENDING',
                    provider: 'CHAPA',
                    providerRef,
                    rawResponse: response.body,
                    errorCode: null,
                    errorMessage: null,
                    authorizedAt,
                    redirectUrl: null,
                });
            default:
                throw new ChapaUnavailableError(
                    `Chapa verify returned unknown status: ${String(
                        inner.status,
                    )}. Body: ${safeStringify(response.body)}`,
                );
        }
    }

    // ----- internals --------------------------------------------------------

    private authHeaders(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.config.secretKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
    }

    /**
     * Wrap transport calls so network / timeout / unparseable
     * responses surface as typed `ChapaUnavailableError`. HTTP
     * status interpretation happens in the caller (different paths
     * map 4xx vs 5xx differently — `authorize` throws on 4xx;
     * `verify` returns FAILED on body-level "failed" but throws on
     * 4xx HTTP status because that's a Chapa config / auth error,
     * not a transaction outcome).
     */
    private async requestWithErrors(
        url: string,
        options: ChapaHttpRequestOptions,
    ): Promise<ChapaHttpResponse> {
        try {
            const response = await this.transport.request(url, options);
            if (response.status >= 500) {
                throw new ChapaUnavailableError(
                    `Chapa returned HTTP ${response.status}. Body: ${safeStringify(
                        response.body,
                    )}`,
                );
            }
            return response;
        } catch (err) {
            if (err instanceof PaymentGatewayError) {
                throw err;
            }
            // AbortController-driven timeout surfaces as a DOMException
            // with name `AbortError`; network failures as `TypeError` /
            // `Error` with various messages. Treat them uniformly.
            const detail = err instanceof Error ? err.message : String(err);
            throw new ChapaUnavailableError(
                `Chapa transport error against ${url}: ${detail}`,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers — kept module-private; surfaced for the test suite via export
// ---------------------------------------------------------------------------

const TX_REF_MAX_LEN = 100; // Chapa accepts up to ~127 chars; cap defensively.

/**
 * Build a Chapa `tx_ref` from the input metadata. Stable for a
 * given `(targetId, idempotencyKey)` pair so retries collapse on
 * the upstream side.
 *
 * Shape:  `apt-<appointmentId>-<idem8>`  (APPOINTMENT)
 *         `feat-<subscriptionId>-<idem8>` (FEATURING)
 *
 * Both branches truncate to `TX_REF_MAX_LEN` so a future longer
 * id type doesn't blow past Chapa's limit.
 */
export function synthesizeTxRef(input: PaymentAuthorizationInput): string {
    const idem = (input.idempotencyKey ?? '').replace(/-/g, '').slice(0, 8) ||
        'noidem00';
    const base = input.purpose === 'APPOINTMENT'
        ? `apt-${(input as AppointmentAuthorizationInput).appointmentId}-${idem}`
        : `feat-${(input as FeaturingAuthorizationInput).featuringSubscriptionId}-${idem}`;
    return base.slice(0, TX_REF_MAX_LEN);
}

/**
 * Synthetic email for the Chapa customer field. Chapa requires
 * a non-empty `email` on the initialize call; some EthioLink
 * customers signed up via SMS-only flow and have `users.email = NULL`.
 * The synthetic address routes nowhere — receipts go to Chapa's
 * own confirmation surface, not this address.
 */
export function syntheticEmailForInput(
    input: PaymentAuthorizationInput,
): string {
    const subject = input.purpose === 'APPOINTMENT'
        ? `apt-${(input as AppointmentAuthorizationInput).appointmentId}`
        : `feat-${(input as FeaturingAuthorizationInput).featuringSubscriptionId}`;
    return `${subject}@payments.ethiolink.local`;
}

function describePurpose(input: PaymentAuthorizationInput): string {
    if (input.purpose === 'APPOINTMENT') {
        return 'Appointment booking on EthioLink';
    }
    return 'EthioLink featured listing';
}

/**
 * Format an ETB amount for Chapa. Chapa accepts string-encoded
 * decimals; `toFixed(2)` is the safest round-trip representation
 * to avoid the upstream parser choking on `Number.EPSILON`-style
 * artefacts.
 */
export function formatAmountEtb(amountEtb: number): string {
    if (!Number.isFinite(amountEtb) || amountEtb < 0) {
        throw new PaymentGatewayError(
            'CHAPA_INVALID_REQUEST',
            `amountEtb must be a non-negative finite number, got ${amountEtb}`,
        );
    }
    return amountEtb.toFixed(2);
}

function normalizeBase(url: string): string {
    return url.replace(/\/+$/, '');
}

function safeStringify(value: unknown): string {
    if (value === null || value === undefined) return String(value);
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return Object.prototype.toString.call(value);
    }
}

function extractCheckoutUrl(body: unknown): string | null {
    if (typeof body !== 'object' || body === null) return null;
    const outer = body as Record<string, unknown>;
    const data = outer.data;
    if (typeof data !== 'object' || data === null) return null;
    const checkoutUrl = (data as Record<string, unknown>).checkout_url;
    return typeof checkoutUrl === 'string' && checkoutUrl.length > 0
        ? checkoutUrl
        : null;
}

interface VerifyInner {
    readonly status: 'success' | 'failed' | 'pending' | string;
    readonly message?: string;
}

function extractVerifyData(body: unknown): VerifyInner {
    if (typeof body !== 'object' || body === null) {
        return { status: 'unknown' };
    }
    const outer = body as Record<string, unknown>;
    const data = outer.data;
    if (typeof data !== 'object' || data === null) {
        return { status: 'unknown' };
    }
    const inner = data as Record<string, unknown>;
    const status = typeof inner.status === 'string' ? inner.status : 'unknown';
    const message = typeof inner.message === 'string' ? inner.message : undefined;
    return { status, message };
}

function describeUpstreamError(body: unknown, statusCode: number): string {
    if (typeof body === 'object' && body !== null) {
        const obj = body as Record<string, unknown>;
        const message = obj.message;
        if (typeof message === 'string' && message.length > 0) {
            return `Chapa HTTP ${statusCode}: ${message}`;
        }
    }
    return `Chapa HTTP ${statusCode}: ${safeStringify(body)}`;
}
