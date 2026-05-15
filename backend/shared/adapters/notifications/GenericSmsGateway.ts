// EthioLink — generic SMS notification gateway.
//
// First Phase 9 commit on the "real SMS provider" track. Provider-
// agnostic skeleton implementing the `NotificationGateway` port; the
// operator wires a concrete Ethiopian SMS provider (AfroMessage,
// EthioTelecom, etc.) by passing the provider's `apiBaseUrl` +
// `apiKey` + `senderId` via `SmsProviderConfig` at gateway
// construction time. Until the operator opts in, the gateway is
// dormant — the `dispatcherFactory` is not switched in this commit,
// so `MockNotificationGateway` remains the production default.
//
// Why "generic" rather than a vendor-specific class:
//
//   * The operator has not yet committed to a single provider. The
//     Phase 9 task doc (`docs/tasks/PHASE_9_POST_MVP.md`) recommends
//     AfroMessage as a starting point but leaves the decision to the
//     operator. A `GenericSmsGateway` shipped today fits any
//     Ethiopian REST provider whose API shape matches the common
//     `{ to, from, message }` body pattern (AfroMessage, ethio-tel
//     resellers, Twilio-compatible gateways). When the operator
//     does pick a provider, the only changes will be:
//       1. Set `SMS_PROVIDER_API_BASE_URL` to the chosen vendor.
//       2. (Optionally) subclass this gateway with vendor-specific
//          quirks (e.g. status-code interpretation, retry headers).
//       3. Wire the gateway into the dispatcher.
//     The interface itself stays.
//
//   * Adapter parity with the payments port. `MockOnlineGateway`
//     ships today as the placeholder for Telebirr / Chapa / CBE Birr
//     — same shape: one port, one mock, one real adapter (or one
//     generic + per-provider subclasses) when the provider is
//     selected.
//
// Wire shape:
//
//   Request:
//     POST {apiBaseUrl}/v1/send
//     Authorization: Bearer <apiKey>
//     Content-Type: application/json
//     {
//       "to": "+251911000001",
//       "from": "<senderId>",
//       "message": "<rendered.body>",
//       "clientReference": "<idempotencyKey?>"
//     }
//
//   Successful response (HTTP 2xx):
//     {
//       "messageId": "msg-<vendor-issued-id>",
//       "status": "queued" | "sent" | ...
//     }
//
//   The shape is the lowest-common-denominator between the
//   documented Ethiopian SMS REST APIs and the broader
//   Twilio-compatible space. When the operator picks a vendor
//   whose API deviates (e.g. nests the message id under a
//   `data.id` field), the right move is to subclass this gateway
//   and override `extractProviderRef`.
//
// Outcome mapping:
//
//   * 2xx                 → `status: 'SENT'`, `providerRef =
//                            extractProviderRef(body)` (may be null
//                            when vendor doesn't return one).
//   * 4xx                 → `status: 'FAILED'` with
//                            `errorCode = 'SMS_PROVIDER_REJECTED'`.
//                            The dispatcher persists the row; no
//                            throw — the booking flow continues.
//                            The customer didn't get their SMS,
//                            but the system stays consistent.
//   * 5xx                 → throw `SmsProviderUnavailableError`.
//                            The dispatcher catches the base
//                            `NotificationGatewayError`, persists
//                            `FAILED`, and continues. A future
//                            retry job (post-MVP) ignores rows
//                            with `errorCode = 'SMS_PROVIDER_UNAVAILABLE'`
//                            because those are infrastructure-level
//                            failures the operator should debug.
//   * timeout / network   → throw `SmsProviderUnavailableError`.
//                            Same handling as 5xx.
//
// Transport seam:
//
//   The gateway depends on the `SmsHttpTransport` interface, not
//   `fetch` directly, so tests can inject a `FakeSmsHttpTransport`
//   that scripts responses without a network round-trip. Production
//   passes `defaultFetchSmsHttpTransport()` which uses Node 20's
//   global `fetch` with an `AbortController`-driven timeout.
//
//   The transport itself does the JSON parse + status extraction
//   so the gateway logic stays linear. Anything the transport
//   can't parse (non-JSON body) is preserved as a string in
//   `SmsHttpResponse.body` so the gateway can write it verbatim
//   into `rawResponse` for debugging.
//
// Idempotency:
//
//   `input.idempotencyKey` is forwarded as the `clientReference`
//   request field. Vendors that support idempotent send (most
//   modern Ethiopian providers do) will dedupe on this; vendors
//   that don't will ignore the field. Either way the gateway-side
//   behavior is identical.

import type {
    NotificationGateway,
    NotificationSendInput,
    NotificationSendResult,
} from './NotificationGateway.js';
import { NotificationGatewayError } from './NotificationGateway.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the generic SMS gateway. Structurally
 * identical to `AppConfig.smsProvider` in `loadConfig.ts` so a
 * loaded config can be passed directly to
 * {@link createGenericSmsGateway} with no adaptation; the type
 * is defined here (not imported from `loadConfig`) so the
 * adapter does not depend on `loadConfig.ts` (the same direction
 * other adapters in this codebase follow — adapters are
 * config-shape-agnostic ports).
 *
 * `loadConfig` builds the config when every required env var is
 * present and otherwise leaves the slot `null`. Constructing a
 * gateway with `null` is a programming error and the factory
 * (`createGenericSmsGateway`) throws — the dispatcher should
 * only call the factory when the slot is set.
 */
export interface SmsProviderConfig {
    /** Provider base URL (e.g. `https://api.afromessage.com`). No trailing slash required; the gateway normalizes. */
    readonly apiBaseUrl: string;
    /** API key as supplied by the operator. In production this is resolved from Secrets Manager via a future `loadSecretsThenConfig` extension; until then it lands directly in the env. */
    readonly apiKey: string;
    /** ARN of the Secrets Manager secret holding the API key, when set. The gateway itself does not consume this — it's passthrough metadata so the loaded config's shape matches one-for-one. */
    readonly apiKeySecretArn: string;
    /** Sender display name registered with the vendor (e.g. `EthioLink`). */
    readonly senderId: string;
    /** Provider identifier written to `notification_logs.provider`. Free-form string; defaults to `'GENERIC_SMS'`. */
    readonly providerName: string;
    /** HTTP request timeout in milliseconds. Default 10000 (10s). */
    readonly timeoutMs: number;
}

/**
 * Options accepted by {@link SmsHttpTransport.post}. The
 * gateway builds this from the configured + input data and
 * hands it off to the transport.
 */
export interface SmsHttpRequestOptions {
    /** Parsed JSON body. The transport stringifies. */
    readonly body: unknown;
    /** Request headers. The transport passes these through unchanged. */
    readonly headers: Record<string, string>;
    /** Per-request timeout in milliseconds. */
    readonly timeoutMs: number;
}

/**
 * Response shape the transport returns. The transport extracts
 * `status` + JSON-parses the body (falling back to the raw string
 * when the response isn't JSON). The gateway is the only place
 * that interprets these.
 */
export interface SmsHttpResponse {
    readonly status: number;
    /** Parsed JSON object/array, or raw string when the body wasn't JSON, or `null` when the body was empty. */
    readonly body: unknown;
}

/**
 * Transport seam between the gateway and `fetch`. Production
 * passes `defaultFetchSmsHttpTransport()`; tests pass a recording
 * fake.
 */
export interface SmsHttpTransport {
    post(url: string, options: SmsHttpRequestOptions): Promise<SmsHttpResponse>;
}

/**
 * Subclass of {@link NotificationGatewayError} raised when the
 * SMS provider is unreachable (5xx, timeout, network error). The
 * dispatcher catches the base class and writes
 * `notification_logs.status = 'FAILED'` with the error message,
 * so the booking flow continues uninterrupted. The dedicated
 * subclass lets a future retry job tell "the provider rejected
 * the number" (4xx → `SmsSendResult.status = 'FAILED'`, no
 * throw) apart from "the provider couldn't be reached"
 * (this class, thrown).
 */
export class SmsProviderUnavailableError extends NotificationGatewayError {
    constructor(message: string) {
        super('SMS_PROVIDER_UNAVAILABLE', message);
        this.name = 'SmsProviderUnavailableError';
    }
}

// ---------------------------------------------------------------------------
// Default fetch-based transport
// ---------------------------------------------------------------------------

/**
 * Production transport. Uses Node 20's global `fetch` with an
 * `AbortController`-driven timeout. Parses the response body as
 * JSON when the Content-Type allows; falls back to the raw text
 * when JSON parsing fails (so a misbehaving vendor's plain-text
 * 5xx page still shows up in `rawResponse` rather than throwing
 * a JSON parse error).
 */
export function defaultFetchSmsHttpTransport(): SmsHttpTransport {
    return {
        async post(url, options) {
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(),
                options.timeoutMs,
            );
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: options.headers,
                    body: JSON.stringify(options.body),
                    signal: controller.signal,
                });
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
// Gateway
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER_NAME = 'GENERIC_SMS';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Factory used by the dispatcher (in a future commit) to
 * construct the gateway from `AppConfig.smsProvider`. Throws
 * when the config is null — the caller is expected to check
 * before calling, but the throw makes a programming error loud
 * rather than silent.
 */
export function createGenericSmsGateway(
    config: SmsProviderConfig | null,
    transport: SmsHttpTransport = defaultFetchSmsHttpTransport(),
): GenericSmsGateway {
    if (!config) {
        throw new NotificationGatewayError(
            'SMS_PROVIDER_NOT_CONFIGURED',
            'SMS provider config is missing. Set SMS_PROVIDER_API_BASE_URL, ' +
                'SMS_PROVIDER_API_KEY, and SMS_PROVIDER_SENDER_ID (and optionally ' +
                'SMS_PROVIDER_API_KEY_SECRET_ARN for production secret resolution).',
        );
    }
    return new GenericSmsGateway(config, transport);
}

export class GenericSmsGateway implements NotificationGateway {
    public readonly channel = 'SMS' as const;
    public readonly provider: string;

    private readonly config: SmsProviderConfig;
    private readonly transport: SmsHttpTransport;

    constructor(
        config: SmsProviderConfig,
        transport: SmsHttpTransport = defaultFetchSmsHttpTransport(),
    ) {
        this.config = config;
        this.transport = transport;
        this.provider = config.providerName || DEFAULT_PROVIDER_NAME;
    }

    async send(input: NotificationSendInput): Promise<NotificationSendResult> {
        const phone = input.recipient.phoneE164?.trim();
        if (!phone) {
            // Programming error — the dispatcher should never route
            // an SMS-channel send to this gateway without a phone
            // number. Throwing surfaces the bug in
            // `notification_logs` rather than silently dropping the
            // request.
            throw new NotificationGatewayError(
                'SMS_RECIPIENT_INVALID',
                'SMS send requires `recipient.phoneE164`; got empty value.',
            );
        }

        const url = `${this.config.apiBaseUrl.replace(/\/+$/, '')}/v1/send`;
        const requestBody: Record<string, unknown> = {
            to: phone,
            from: this.config.senderId,
            message: input.rendered.body,
        };
        if (input.idempotencyKey) {
            requestBody.clientReference = input.idempotencyKey;
        }

        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };

        // Snapshot the timestamp BEFORE the network call so the
        // ISO `sentAt` reflects when the gateway tried, not when
        // the response arrived. A retried failure should still
        // carry the original attempt timestamp.
        const sentAt = new Date().toISOString();

        let response: SmsHttpResponse;
        try {
            response = await this.transport.post(url, {
                body: requestBody,
                headers,
                timeoutMs: this.config.timeoutMs || DEFAULT_TIMEOUT_MS,
            });
        } catch (err) {
            // Anything the transport throws — `AbortError` from a
            // timeout, `TypeError: fetch failed` from a DNS / TCP
            // failure, etc. — is "the provider could not be
            // reached". Map to the typed error so the dispatcher
            // and any future retry job can treat it differently
            // from a provider-side 4xx rejection.
            throw new SmsProviderUnavailableError(
                `SMS provider unreachable: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }

        if (response.status >= 500) {
            throw new SmsProviderUnavailableError(
                `SMS provider returned HTTP ${response.status}: ${truncate(
                    stringifyBody(response.body),
                    200,
                )}`,
            );
        }

        if (response.status >= 400) {
            return Object.freeze<NotificationSendResult>({
                status: 'FAILED',
                provider: this.provider,
                providerRef: null,
                rawResponse: response.body ?? null,
                errorCode: 'SMS_PROVIDER_REJECTED',
                errorMessage: `Provider rejected with HTTP ${response.status}.`,
                sentAt,
            });
        }

        return Object.freeze<NotificationSendResult>({
            status: 'SENT',
            provider: this.provider,
            providerRef: extractProviderRef(response.body),
            rawResponse: response.body ?? null,
            errorCode: null,
            errorMessage: null,
            sentAt,
        });
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Pull the vendor-issued message id out of a 2xx response body.
 * Defaults walk the two most common shapes: top-level
 * `messageId` or nested `data.id`. Returns `null` when neither
 * is present — the `notification_logs.provider_ref` column is
 * nullable, and a vendor that doesn't return an id is still a
 * successful send.
 *
 * Subclasses for specific vendors should override the parent
 * `send` method's call site if their shape differs more than this
 * (or, simpler, override this function via a static helper). The
 * generic shape covers AfroMessage + the Twilio-compatible space.
 */
function extractProviderRef(body: unknown): string | null {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        const obj = body as Record<string, unknown>;
        if (typeof obj.messageId === 'string' && obj.messageId.length > 0) {
            return obj.messageId;
        }
        if (typeof obj.id === 'string' && obj.id.length > 0) {
            return obj.id;
        }
        const data = obj.data;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            const inner = data as Record<string, unknown>;
            if (typeof inner.messageId === 'string' && inner.messageId.length > 0) {
                return inner.messageId;
            }
            if (typeof inner.id === 'string' && inner.id.length > 0) {
                return inner.id;
            }
        }
    }
    return null;
}

function stringifyBody(body: unknown): string {
    if (body === null || body === undefined) return '';
    if (typeof body === 'string') return body;
    try {
        return JSON.stringify(body);
    } catch {
        return String(body);
    }
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
