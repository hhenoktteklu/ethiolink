// EthioLink — notification template registry.
//
// Maps a `templateKey` (the application-layer enum stored verbatim
// in `notification_logs.template_key`) to a renderer function that
// produces a channel-neutral `NotificationRenderedMessage` (subject
// + body + provider metadata). The notification dispatcher
// (`notificationService.ts`) calls `renderTemplate` to turn a
// booking-event payload into shippable text before handing it to
// a `NotificationGateway`.
//
// MVP template keys (one renderer each):
//
//   * `booking.requested.business`  — customer just booked; tell the business owner.
//   * `booking.accepted.customer`   — business accepted; tell the customer.
//   * `booking.rejected.customer`   — business rejected; tell the customer.
//   * `booking.cancelled.business`  — customer cancelled; tell the business owner.
//   * `booking.cancelled.customer`  — business cancelled; tell the customer.
//   * `booking.rescheduled.business`— customer rescheduled; tell the business owner.
//   * `booking.reminder.customer`   — 24h-out reminder to the customer.
//   * `booking.reminder.business`   — 24h-out reminder to the business owner.
//
// Design notes:
//
//   * **One payload shape (`BookingTemplatePayload`) for all eight
//     keys.** Every booking notification carries the same context
//     — business name, service name, customer display name, and a
//     `startsAtUtc` ISO string. Optional fields (`cancelReason`,
//     `rescheduleNotes`) are only used by the templates that need
//     them; the registry tolerates missing optional fields with a
//     null-safe fallback. Keeping one shape avoids a payload-
//     polymorphism explosion the dispatcher would otherwise have
//     to wrangle — and the `notification_logs.payload` JSONB
//     column stays uniform, which is helpful for the admin
//     debugging view.
//
//   * **`templateKey` is a closed union here, even though the
//     repository keeps it `string`.** The repository's permissive
//     typing was deliberate — it lets new templates land without a
//     migration. The registry is where the closed list lives.
//     Renaming or removing a key is a contract break (historical
//     `notification_logs` rows would deserialize against missing
//     renderers); adding one is additive. This file is the
//     source-of-truth for the contract documented in the
//     `notificationService.ts` header.
//
//   * **Pure renderers.** Each renderer is a synchronous pure
//     function: payload in, rendered message out, no I/O, no
//     date arithmetic beyond a single `formatStartsAt` call. The
//     dispatcher passes a Luxon-friendly ISO string in
//     `startsAtUtc`; the renderer pretty-prints it in the
//     `Africa/Addis_Ababa` zone (everyone receiving these
//     messages is local). Future per-recipient timezones would
//     plumb a `timezone` field through the payload.
//
//   * **Subject vs. body.** All MVP templates set `subject = null`
//     because SMS / Telegram / Push ignore it; the body alone is
//     what users see. The field is kept on the result for forward
//     compatibility with the email channel (the templates would
//     populate it once an `EmailNotificationGateway` lands).
//
//   * **Metadata is empty in MVP.** Real providers will fill it
//     (e.g. an SMS sender id override, an email template id for
//     SendGrid dynamic templates). The shape is reserved so the
//     gateway interface doesn't need a v2 when that lands.

import { DateTime } from 'luxon';

import type { NotificationRenderedMessage } from '../../adapters/notifications/NotificationGateway.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The closed list of MVP booking-template keys. Renaming or
 * removing a member is a contract break — extend the union
 * additively instead. The values are persisted verbatim to
 * `notification_logs.template_key`.
 */
export type BookingTemplateKey =
    | 'booking.requested.business'
    | 'booking.accepted.customer'
    | 'booking.rejected.customer'
    | 'booking.cancelled.business'
    | 'booking.cancelled.customer'
    | 'booking.rescheduled.business'
    | 'booking.reminder.customer'
    | 'booking.reminder.business';

/**
 * Single payload shape consumed by every booking template. The
 * dispatcher builds this from the booking-event payload; the
 * registry treats it as opaque data and reads only the fields
 * each template needs.
 */
export interface BookingTemplatePayload {
    /** Display name of the business the appointment is with. */
    readonly businessName: string;
    /** Display name of the service the appointment is for. */
    readonly serviceName: string;
    /** Customer's display name. Used by business-side templates
     *  ("Henok just booked..."); may be `null` for unauthenticated
     *  / anonymous flows that aren't part of MVP but kept for
     *  forward compatibility. */
    readonly customerDisplayName: string | null;
    /** Appointment start time as an ISO-8601 UTC string. The
     *  renderer formats it in Addis Ababa local time. */
    readonly startsAtUtc: string;
    /** Optional cancellation reason. Used by the two
     *  `booking.cancelled.*` templates. */
    readonly cancelReason?: string | null;
    /** Optional reschedule notes. Used by
     *  `booking.rescheduled.business`. */
    readonly rescheduleNotes?: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when `renderTemplate` is asked for a key that isn't in
 * the registry. The dispatcher catches this as a programming /
 * configuration error — there's no transient retry; the call
 * site is buggy.
 */
export class UnknownTemplateKeyError extends Error {
    public readonly templateKey: string;

    constructor(templateKey: string) {
        super(`Unknown notification template key: ${templateKey}`);
        this.name = 'UnknownTemplateKeyError';
        this.templateKey = templateKey;
    }
}

// ---------------------------------------------------------------------------
// Renderer table
// ---------------------------------------------------------------------------

type Renderer = (payload: BookingTemplatePayload) => NotificationRenderedMessage;

const RENDERERS: Readonly<Record<BookingTemplateKey, Renderer>> = Object.freeze({
    'booking.requested.business': (p) =>
        plain(
            `${customerLabel(p)} just booked ${p.serviceName} on ${formatStartsAt(
                p.startsAtUtc,
            )}. Open the EthioLink app to accept or reject.`,
        ),

    'booking.accepted.customer': (p) =>
        plain(
            `${p.businessName} accepted your ${p.serviceName} booking on ${formatStartsAt(
                p.startsAtUtc,
            )}. See you then!`,
        ),

    'booking.rejected.customer': (p) =>
        plain(
            `${p.businessName} couldn't accept your ${p.serviceName} booking on ${formatStartsAt(
                p.startsAtUtc,
            )}. Please pick another time or another business.`,
        ),

    'booking.cancelled.business': (p) =>
        plain(
            `${customerLabel(p)} cancelled their ${p.serviceName} booking on ${formatStartsAt(
                p.startsAtUtc,
            )}${reasonSuffix(p.cancelReason)}.`,
        ),

    'booking.cancelled.customer': (p) =>
        plain(
            `${p.businessName} cancelled your ${p.serviceName} booking on ${formatStartsAt(
                p.startsAtUtc,
            )}${reasonSuffix(p.cancelReason)}. We're sorry for the inconvenience.`,
        ),

    'booking.rescheduled.business': (p) =>
        plain(
            `${customerLabel(p)} rescheduled their ${p.serviceName} booking to ${formatStartsAt(
                p.startsAtUtc,
            )}${notesSuffix(p.rescheduleNotes)}.`,
        ),

    'booking.reminder.customer': (p) =>
        plain(
            `Reminder: your ${p.serviceName} appointment with ${p.businessName} is on ${formatStartsAt(
                p.startsAtUtc,
            )}. See you soon!`,
        ),

    'booking.reminder.business': (p) =>
        plain(
            `Reminder: ${customerLabel(p)} has a ${p.serviceName} appointment with you on ${formatStartsAt(
                p.startsAtUtc,
            )}.`,
        ),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the given `templateKey` against `payload`. Throws
 * `UnknownTemplateKeyError` if the key isn't registered — the
 * dispatcher treats that as a non-retryable configuration error.
 */
export function renderTemplate(
    templateKey: string,
    payload: BookingTemplatePayload,
): NotificationRenderedMessage {
    const renderer = (RENDERERS as Record<string, Renderer | undefined>)[templateKey];
    if (!renderer) {
        throw new UnknownTemplateKeyError(templateKey);
    }
    return renderer(payload);
}

/**
 * Type-guard for the closed MVP template-key union. Useful for
 * the booking-handler integration (next commit) to assert a
 * literal is part of the registered set at compile-time.
 */
export function isBookingTemplateKey(key: string): key is BookingTemplateKey {
    return Object.prototype.hasOwnProperty.call(RENDERERS, key);
}

/** All registered keys, in declaration order. Useful for tests
 *  and the future admin "list templates" surface. */
export const BOOKING_TEMPLATE_KEYS: readonly BookingTemplateKey[] = Object.freeze(
    Object.keys(RENDERERS) as BookingTemplateKey[],
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADDIS_TZ = 'Africa/Addis_Ababa';

function plain(body: string): NotificationRenderedMessage {
    return Object.freeze<NotificationRenderedMessage>({
        subject: null,
        body,
        metadata: Object.freeze({}),
    });
}

function customerLabel(p: BookingTemplatePayload): string {
    return p.customerDisplayName ?? 'A customer';
}

function reasonSuffix(reason: string | null | undefined): string {
    if (!reason) return '';
    return ` (reason: ${reason})`;
}

function notesSuffix(notes: string | null | undefined): string {
    if (!notes) return '';
    return ` (notes: ${notes})`;
}

/**
 * Pretty-print a UTC ISO-8601 timestamp in Addis Ababa local
 * time. Falls back to the raw ISO string if Luxon can't parse it
 * — defensive only; the dispatcher always passes a valid value.
 */
function formatStartsAt(startsAtUtc: string): string {
    const dt = DateTime.fromISO(startsAtUtc, { zone: 'utc' }).setZone(ADDIS_TZ);
    if (!dt.isValid) return startsAtUtc;
    // e.g. "Fri 17 May, 2:00 PM"
    return dt.toFormat('ccc d LLL, h:mm a');
}
