// EthioLink — notification gateway port.
//
// The notification service (next commit) talks to every channel
// through this single interface. MVP ships three implementations:
//
//   * `MockNotificationGateway` — always succeeds, records
//     `provider = 'MOCK'`. The default for local dev and integration
//     tests; the dispatcher routes here when no real provider is
//     configured (or when `NOTIFICATIONS_PROVIDER=mock`).
//   * `SmsNotificationGateway` — stub. Every `send` throws
//     `NotificationProviderNotConfiguredError` because real Ethiopian
//     SMS gateway credentials are post-MVP.
//   * `TelegramNotificationGateway` — stub. Same posture as SMS:
//     throws until a real bot token is wired up.
//
// Future providers (Telebirr SMS, Ethio Telecom SMS, FCM/APNs push,
// SendGrid email) plug in here by adding a class that implements
// `NotificationGateway`. The two-axis model is `NotificationChannel`
// (what kind of message: SMS / EMAIL / TELEGRAM / PUSH / MOCK) and
// `provider` (which vendor: `'MOCK'`, `'TELEBIRR_SMS'`,
// `'TELEGRAM_BOT'`, etc.). The channel axis is the schema-coupled
// one — matches `notification_logs.channel` CHECK list from
// migration 0013. The provider axis is free-form `string` because
// new providers ship as code-only changes (same stance as
// `notification_logs.provider`, `admin_actions.action`,
// `template_key`).
//
// Design notes:
//
//   * **One method, `send`, in MVP.** Real read-receipt flows
//     (SMS DLR callbacks, email opens) will land as a future
//     webhook-driven path that transitions the log row from
//     `SENT` to `DELIVERED`. That isn't a method on the gateway —
//     it's an inbound handler. The gateway surface stays narrow
//     until a real call site forces growth.
//
//   * **Result vs. throw split.** A regular "provider tried, then
//     said no" outcome (carrier rejected the number, account out
//     of credits) returns a `NotificationSendResult` with
//     `status: 'FAILED'` so the dispatcher persists the failure to
//     the `notification_logs` row and the booking flow continues
//     uninterrupted. A "this gateway cannot service this request
//     at all" outcome — provider not configured, missing
//     credentials, or a generic infrastructure failure — throws a
//     typed `NotificationGatewayError` subclass. The dispatcher
//     catches the base class, persists `FAILED` with the error
//     message, and the booking flow still continues (notifications
//     are best-effort by design — see PHASE_6_NOTIFICATIONS.md
//     acceptance criteria).
//
//   * **No DB coupling.** This module imports nothing from
//     `backend/shared/domains/`. The dispatcher (next commit)
//     owns the translation between `NotificationSendResult` /
//     `NotificationGatewayError` and `notification_logs` rows.
//
//   * **No template rendering here.** The dispatcher renders the
//     template against the recipient + payload, then passes a
//     `NotificationRenderedMessage` (subject + body + raw
//     metadata) to the gateway. The gateway is dumb about
//     templates: it accepts a pre-rendered string and ships it.
//     That keeps `templateRegistry` decoupled from the transport,
//     and lets a future provider that has its own templating
//     engine (e.g. SendGrid dynamic templates) reuse the same
//     port — the dispatcher would just pass a different shape of
//     `rendered`.
//
//   * **`recipient` is structured, not a single string.** SMS
//     needs a phone number, email needs an address, Telegram
//     needs a chat id. We carry all three optional fields so the
//     dispatcher fills in whatever the channel needs and the
//     gateway picks the right one. Validating that the right
//     field is present for the channel is the gateway's job —
//     wrong field → `NotificationGatewayError` (treated like
//     "can't service this request" because it's a programming
//     error, not a transient failure).
//
//   * **`idempotencyKey` is part of the input** so future real
//     providers can safely retry a network blip without
//     double-sending. The mock ignores it; the stubs never reach
//     the point where they'd use it.

/**
 * Channel identifier. Mirrors the `notification_logs.channel`
 * CHECK list from migration 0013. A new channel here means a new
 * provider integration AND a new migration to widen the CHECK —
 * the two must move together, so the TS union is a closed list.
 */
export type NotificationChannel =
    | 'SMS'
    | 'EMAIL'
    | 'TELEGRAM'
    | 'PUSH'
    | 'MOCK';

/**
 * Send outcome for a regular attempt. Even a declined / rejected
 * transmission returns a `NotificationSendResult` (with
 * `status: 'FAILED'` and an error code / message) so the
 * dispatcher persists the outcome to `notification_logs` either
 * way. `SENT` is the terminal status for the gateway — a future
 * `DELIVERED` upgrade comes from a separate inbound webhook path,
 * not from this method.
 */
export type NotificationSendStatus = 'SENT' | 'FAILED';

/**
 * Recipient routing fields. All optional individually; the
 * dispatcher fills in whichever the channel needs.
 *
 *   * `SMS` / `PUSH` (when implemented) need `phoneE164`.
 *   * `EMAIL` needs `emailAddress`.
 *   * `TELEGRAM` needs `telegramChatId`.
 *   * `MOCK` needs nothing — it accepts whatever is provided.
 *
 * The `userId` field is the EthioLink user UUID. The mock gateway
 * ignores it; real providers may include it in their request
 * metadata for vendor-side analytics. It also feeds the
 * `notification_logs.recipient_user_id` column — but that wiring
 * happens in the dispatcher, not here.
 */
export interface NotificationRecipient {
    readonly userId?: string | null;
    readonly phoneE164?: string;
    readonly emailAddress?: string;
    readonly telegramChatId?: string;
}

/**
 * Pre-rendered message. The dispatcher takes a `templateKey` +
 * `payload`, runs it through the template registry, and produces
 * this shape. The gateway is template-agnostic — it just ships
 * what it's given.
 *
 *   * `body` is the required, channel-neutral text content.
 *   * `subject` is honored for email; ignored by SMS, push, and
 *     mock. Telegram may use it as a bold first line at the
 *     adapter's discretion.
 *   * `metadata` is verbatim provider-specific data the future
 *     gateway might need (e.g. an SMS sender id override, an
 *     email template id for SendGrid dynamic templates). Empty
 *     object when not used; never `undefined` so the gateway can
 *     `metadata.x` without a null-check.
 */
export interface NotificationRenderedMessage {
    readonly subject: string | null;
    readonly body: string;
    readonly metadata: Record<string, unknown>;
}

/**
 * Input accepted by {@link NotificationGateway.send}. Opaque to
 * the gateway: the dispatcher built this shape from the template
 * registry + the booking-event payload.
 */
export interface NotificationSendInput {
    /** Which channel this attempt targets. The gateway MAY assert
     *  it matches its own `channel`; mismatched channel is a
     *  programming error, not a transient failure. */
    readonly channel: NotificationChannel;

    /** Where to send it. The gateway picks the field it needs. */
    readonly recipient: NotificationRecipient;

    /** What to send. Pre-rendered by the dispatcher. */
    readonly rendered: NotificationRenderedMessage;

    /**
     * Stable identifier the dispatcher uses to correlate the
     * gateway call with the `notification_logs` row it wrote.
     * Future real providers MAY pass it upstream as their own
     * idempotency key so a network retry does not double-send.
     * The mock ignores it; the stubs never use it.
     */
    readonly idempotencyKey?: string;
}

/**
 * Result returned from a regular send attempt. The dispatcher
 * maps this into `notification_logs.updateStatus({ status,
 * providerRef, errorMessage })`.
 */
export interface NotificationSendResult {
    readonly status: NotificationSendStatus;
    /** Provider identifier that handled this attempt. Free-form
     *  string; mirrors `notification_logs.provider`. */
    readonly provider: string;
    /** External reference from the upstream provider (e.g. an SMS
     *  message id). `null` for `FAILED` if the provider failed
     *  before issuing one. */
    readonly providerRef: string | null;
    /** Verbatim provider payload. Persisted for debugging /
     *  reconciliation. `null` if there isn't one. */
    readonly rawResponse: unknown | null;
    /** Short stable code on `FAILED`. */
    readonly errorCode: string | null;
    /** Human-readable failure reason on `FAILED`. */
    readonly errorMessage: string | null;
    /** ISO-8601 UTC timestamp the result was produced. */
    readonly sentAt: string;
}

/**
 * Base class for gateway failures that are NOT a normal
 * "provider rejected the send" outcome. Subclasses distinguish
 * "provider intentionally not wired up" (the SMS / Telegram
 * stubs) from generic infrastructure failures. The dispatcher
 * catches the base class and writes `notification_logs.status =
 * 'FAILED'` with `errorMessage = err.message` so the admin can
 * see what went wrong; the booking flow itself is unaffected.
 */
export class NotificationGatewayError extends Error {
    /** Stable, code-shaped identifier the dispatcher can switch
     *  on if it ever needs to. Mirrors `PaymentGatewayError.code`. */
    public readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'NotificationGatewayError';
        this.code = code;
    }
}

/**
 * Raised by gateways that intentionally do not service requests
 * in MVP — i.e. the SMS and Telegram stubs. Distinguishable from
 * a generic `NotificationGatewayError` so a future "list
 * configured channels" admin endpoint can report which providers
 * are real vs. stubbed without parsing error messages.
 */
export class NotificationProviderNotConfiguredError
    extends NotificationGatewayError
{
    constructor(message: string) {
        super('NOTIFICATION_PROVIDER_NOT_CONFIGURED', message);
        this.name = 'NotificationProviderNotConfiguredError';
    }
}

/**
 * Provider-agnostic port. Implementations live alongside this
 * file; the notification dispatcher depends on the interface,
 * never on a concrete class.
 */
export interface NotificationGateway {
    /** Channel identifier this gateway implements. The dispatcher
     *  uses this to route a `NotificationSendInput` to the right
     *  gateway instance. */
    readonly channel: NotificationChannel;

    /** Provider identifier this gateway represents. Echoes
     *  `NotificationSendResult.provider`. Free-form string so new
     *  providers ship as code-only changes (no schema migration). */
    readonly provider: string;

    /**
     * Attempt to send a single rendered message.
     *
     * - Returns `NotificationSendResult` for normal outcomes
     *   (sent, rejected by upstream).
     * - Throws `NotificationGatewayError` (or subclass) when the
     *   gateway cannot service the request at all (provider not
     *   configured, missing recipient field for this channel,
     *   upstream unreachable).
     */
    send(input: NotificationSendInput): Promise<NotificationSendResult>;
}
