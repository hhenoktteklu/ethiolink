// EthioLink — payment gateway port.
//
// The booking service talks to payments exclusively through this
// interface. MVP ships two implementations:
//
//   * `CashGateway` — no-op success; cash settles in person at the
//     appointment.
//   * `MockOnlineGateway` — refuses every call with a typed error
//     because the real online providers are post-MVP.
//
// Future providers (Telebirr, Chapa, CBE Birr) plug in here by adding
// a class that implements `PaymentGateway`. The `PaymentProvider` enum
// — kept in sync with the `payment_intents.provider` CHECK list in
// migration 0011 — is the only schema-coupled identifier in this
// module.
//
// Design notes:
//   * **Two methods now — `authorize` + `verify`.** Phase 10 first
//     commit widens the port to model the redirect-then-confirm flow
//     real providers (Chapa, Telebirr) need. `authorize` initiates
//     the upstream transaction (synchronous SUCCEEDED for cash;
//     asynchronous PENDING + a `redirectUrl` for Chapa); `verify`
//     is the read-after-write call the webhook handler issues
//     against the upstream provider once it pings us. Cash + Mock
//     keep `verify` as a safe no-op / unsupported branch — they
//     never reach the PENDING state. A future `refund(providerRef,
//     amount)` lands when the admin refund tooling does. The
//     interface still stays as narrow as the call sites demand.
//   * **Result vs. throw split.** A regular "the user's card was
//     declined" outcome returns a `FAILED` result so the booking
//     service can persist a `payment_intents` row with the failure
//     reason. A "this gateway cannot service this request at all"
//     outcome — e.g. online payments are not yet implemented —
//     throws a typed `PaymentGatewayError` subclass. The booking
//     service distinguishes the two: declined → 200 with a domain
//     payload, unavailable → 400 with `ONLINE_PAYMENTS_UNAVAILABLE`.
//   * **No DB coupling.** This module imports nothing from the
//     repository layer. The booking service is responsible for
//     translating the returned `PaymentAuthorization` into a
//     `payment_intents` row (or, for `CASH`, skipping the write
//     entirely per the schema doc).
//   * **Idempotency.** `idempotencyKey` is part of the input so
//     future online providers can safely retry without
//     double-charging. Cash ignores it; MockOnline never reaches the
//     "would have used it" branch.

/**
 * Provider identifier. Matches the `payment_intents.provider` CHECK
 * values from migration 0011, plus the `CASH` sentinel for the cash
 * path (which never writes a `payment_intents` row).
 */
export type PaymentProvider =
    | 'CASH'
    | 'MOCK'
    | 'TELEBIRR'
    | 'CHAPA'
    | 'CBE_BIRR';

/**
 * Authorization lifecycle states. Mirrors the
 * `payment_intents.status` CHECK list minus `CANCELLED` (which is a
 * post-authorization administrative state, not an authorize-time
 * outcome).
 */
export type PaymentAuthorizationStatus = 'SUCCEEDED' | 'PENDING' | 'FAILED';

/**
 * Discriminated union accepted by {@link PaymentGateway.authorize}.
 * Phase 9 Track 6 — the original shape only carried `appointmentId`;
 * paid featuring (booked through `featuringService`) adds the
 * second variant so the same gateway port handles both purposes.
 *
 * The `purpose` tag is what each gateway switches on (today: nothing
 * — every implementation ignores both branches and returns a
 * deterministic result). Real upstream providers will use it to pick
 * the right product code / SKU / metadata block when calling out.
 */
export type PaymentAuthorizationInput =
    | AppointmentAuthorizationInput
    | FeaturingAuthorizationInput;

/** Authorization for a customer appointment (the original shape). */
export interface AppointmentAuthorizationInput {
    readonly purpose: 'APPOINTMENT';
    /** UUID of the appointment the payment is for. Opaque to the gateway. */
    readonly appointmentId: string;
    /** Amount to charge in ETB. Must match the appointment's snapshotted price. */
    readonly amountEtb: number;
    /**
     * Optional idempotency key the gateway MAY pass to its upstream
     * provider so a network retry does not double-charge. Cash and
     * MockOnline ignore it; real online providers use it.
     */
    readonly idempotencyKey?: string;
}

/**
 * Authorization for a paid featuring subscription (Phase 9 Track 6).
 * Carries the subscription id (the freshly-inserted
 * `featuring_subscriptions` row) so a future Telebirr gateway can
 * persist the upstream `providerRef` against the subscription
 * record's `payment_intents` row.
 */
export interface FeaturingAuthorizationInput {
    readonly purpose: 'FEATURING';
    /** UUID of the `featuring_subscriptions` row. */
    readonly featuringSubscriptionId: string;
    /** UUID of the business that owns the subscription. */
    readonly businessId: string;
    /** Server-priced amount in ETB. Owners never send this. */
    readonly amountEtb: number;
    /** Idempotency key — same semantics as the appointment variant. */
    readonly idempotencyKey?: string;
}

/**
 * Result returned from a regular authorization attempt. Even a
 * declined transaction returns a `PaymentAuthorization` (with
 * `status: 'FAILED'` and an error code/message) — the booking service
 * persists the outcome to `payment_intents` either way.
 *
 * Contrast with {@link PaymentGatewayError}, which signals that the
 * gateway cannot service the request at all (configuration, feature
 * not yet implemented, upstream unreachable).
 */
export interface PaymentAuthorization {
    readonly status: PaymentAuthorizationStatus;
    /** Provider that issued this authorization. Echoes `gateway.provider`. */
    readonly provider: PaymentProvider;
    /**
     * External reference from the upstream provider (e.g. a Telebirr
     * transaction id). `null` for `CASH` (no upstream) and may be
     * `null` for `PENDING`/`FAILED` if the provider failed before
     * issuing one.
     */
    readonly providerRef: string | null;
    /**
     * Verbatim provider payload. Persisted to
     * `payment_intents.raw_response` for debugging and reconciliation.
     * `null` for `CASH`.
     */
    readonly rawResponse: unknown | null;
    /** Short stable code for `FAILED` outcomes, e.g. `'CARD_DECLINED'`. */
    readonly errorCode: string | null;
    /** Human-readable failure reason. Surfaced to the caller verbatim. */
    readonly errorMessage: string | null;
    /** ISO-8601 timestamp the result was produced. */
    readonly authorizedAt: string;
    /**
     * Provider-hosted checkout URL the customer should be sent to.
     * Populated only when `status === 'PENDING'` and the gateway
     * uses a redirect-then-confirm model (Chapa, future Telebirr).
     * `null` for synchronous gateways (`CASH`) and for terminal
     * outcomes returned on the initial call (`SUCCEEDED` /
     * `FAILED` without a redirect step).
     *
     * Phase 10 first commit. The handler layer surfaces this on
     * the API response so the mobile client can open the hosted
     * checkout. Existing callers that ignore the field see no
     * behaviour change.
     */
    readonly redirectUrl?: string | null;
}

/**
 * Base class for gateway failures that are NOT a normal declined
 * transaction. Subclasses distinguish "online payments not yet
 * implemented" from generic infrastructure failures (network,
 * misconfiguration). The booking service catches the base class and
 * maps to a `400 ONLINE_PAYMENTS_UNAVAILABLE` or `500 INTERNAL_ERROR`
 * depending on the subclass.
 */
export class PaymentGatewayError extends Error {
    /** Stable, code-shaped identifier the handler layer can switch on. */
    public readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'PaymentGatewayError';
        this.code = code;
    }
}

/**
 * Raised by gateways that intentionally do not service requests in
 * MVP — i.e. `MockOnlineGateway`. Distinguishable from generic
 * `PaymentGatewayError` so the booking service can map it to a
 * targeted 400 instead of a 500.
 */
export class OnlinePaymentsUnavailableError extends PaymentGatewayError {
    constructor(message: string) {
        super('ONLINE_PAYMENTS_UNAVAILABLE', message);
        this.name = 'OnlinePaymentsUnavailableError';
    }
}

/**
 * Raised when {@link PaymentGateway.verify} is called on a gateway
 * that does not support the operation — i.e. synchronous gateways
 * (`CashGateway`) and the mock (`MockOnlineGateway`). The webhook
 * handler should never reach a `verify` against these because
 * neither gateway ever returns `PENDING` from `authorize`. Keeping
 * the typed error means a future refactor that mis-routes a
 * webhook into one of these gateways fails loudly rather than
 * silently dropping the lookup.
 *
 * Phase 10 first commit.
 */
export class PaymentVerificationUnsupportedError extends PaymentGatewayError {
    constructor(provider: PaymentProvider) {
        super(
            'PAYMENT_VERIFICATION_UNSUPPORTED',
            `Provider ${provider} does not support verify(); webhook routing bug?`,
        );
        this.name = 'PaymentVerificationUnsupportedError';
    }
}

/**
 * Provider-agnostic port. Implementations live alongside this file;
 * the booking service depends on the interface, never on a concrete
 * class.
 */
export interface PaymentGateway {
    /** Provider identifier this gateway represents. */
    readonly provider: PaymentProvider;

    /**
     * Attempt to authorize a charge. The input's `purpose` tag
     * picks between an appointment payment (the booking funnel)
     * and a featuring subscription (Phase 9 Track 6).
     *
     * - Returns `PaymentAuthorization` for normal outcomes (success,
     *   pending external action, declined).
     * - Throws `PaymentGatewayError` (or subclass) when the gateway
     *   cannot service the request at all (online not implemented,
     *   upstream unreachable, misconfigured).
     */
    authorize(input: PaymentAuthorizationInput): Promise<PaymentAuthorization>;

    /**
     * Read-after-write verification against the upstream provider.
     * Called by the webhook handler once the provider pings us; the
     * webhook payload is not trusted on its own — we re-fetch the
     * canonical status from the provider before mutating any
     * domain state.
     *
     * Behaviour:
     *   * For redirect-then-confirm gateways (Chapa, future
     *     Telebirr) — perform the upstream `verify` round-trip and
     *     return a `PaymentAuthorization` with `SUCCEEDED` or
     *     `FAILED` (PENDING is allowed but unusual: it means the
     *     webhook fired before the provider's own state settled,
     *     which we handle by no-oping the domain transition and
     *     letting the next webhook retry land).
     *   * For synchronous gateways (`CashGateway`,
     *     `MockOnlineGateway`) — throw
     *     `PaymentVerificationUnsupportedError`. Neither gateway
     *     ever returns `PENDING` from `authorize`, so the webhook
     *     handler should never reach this branch; the throw makes
     *     a routing bug loud.
     *
     * Phase 10 first commit.
     */
    verify(providerRef: string): Promise<PaymentAuthorization>;
}
