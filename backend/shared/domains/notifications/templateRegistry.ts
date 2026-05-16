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
//
//   * **Locale-aware (Phase 9 Track 5).** `renderTemplate` takes a
//     `locale` argument; the registry is a `Record<TemplateKey,
//     Record<UserLocale, Renderer>>` keyed first by template, then
//     by language. Both `'en'` and `'am'` (Amharic) ship with
//     entries for every booking template. The lookup still falls
//     back to `'en'` when a future locale lands without all its
//     renderers, so widening `users.locale` ahead of the content
//     pass remains safe. The argument defaults to `'en'` so
//     existing call sites continue compiling without changes.
//
//   * **Amharic copy notes.** Weekday + month names use Amharic
//     abbreviations from a hardcoded lookup (not Intl) so tests
//     are deterministic and don't depend on the Node ICU build.
//     Hours are formatted with ጥዋት (morning) / ከሰዓት
//     (afternoon) instead of AM / PM. Proper nouns —
//     `businessName`, `serviceName`, `customerDisplayName` — pass
//     through verbatim; we don't transliterate user-entered data.
//     The "(reason: ...)" / "(notes: ...)" suffixes pick up
//     Amharic labels (ምክንያት / ማስታወሻ) when the renderer locale
//     is `'am'`.

import { DateTime } from 'luxon';

import type { NotificationRenderedMessage } from '../../adapters/notifications/NotificationGateway.js';
import type { UserLocale } from '../users/userRepository.js';

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

/**
 * Per-template, per-locale renderer table. The outer key is the
 * `BookingTemplateKey`, the inner key is a `UserLocale`. Both
 * `'en'` and `'am'` ship with an entry for every booking template
 * (Phase 9 Track 5 content pass). `renderTemplate` still falls
 * back to `'en'` when a future locale is registered without all
 * its entries, so widening `users.locale` remains safe.
 */
const RENDERERS: Readonly<
    Record<BookingTemplateKey, Readonly<Partial<Record<UserLocale, Renderer>>>>
> = Object.freeze({
    'booking.requested.business': Object.freeze({
        en: (p) =>
            plain(
                `${customerLabel(p, 'en')} just booked ${p.serviceName} on ${formatStartsAt(
                    p.startsAtUtc,
                    'en',
                )}. Open the EthioLink app to accept or reject.`,
            ),
        am: (p) =>
            plain(
                `${customerLabel(p, 'am')} ለ${p.serviceName} ቀጠሮ ቦታ ይዘዋል፣ ${formatStartsAt(
                    p.startsAtUtc,
                    'am',
                )}። ለመቀበል ወይም ለመቃወም EthioLink አፕልኬሽን ይክፈቱ።`,
            ),
    }),

    'booking.accepted.customer': Object.freeze({
        en: (p) =>
            plain(
                `${p.businessName} accepted your ${p.serviceName} booking on ${formatStartsAt(
                    p.startsAtUtc,
                    'en',
                )}. See you then!`,
            ),
        am: (p) =>
            plain(
                `${p.businessName} የ${p.serviceName} ቀጠሮዎን ተቀብለዋል፣ ${formatStartsAt(
                    p.startsAtUtc,
                    'am',
                )}። በዚያ ቀን እንገናኝ!`,
            ),
    }),

    'booking.rejected.customer': Object.freeze({
        en: (p) =>
            plain(
                `${p.businessName} couldn't accept your ${p.serviceName} booking on ${formatStartsAt(
                    p.startsAtUtc,
                    'en',
                )}. Please pick another time or another business.`,
            ),
        am: (p) =>
            plain(
                `${p.businessName} የ${p.serviceName} ቀጠሮዎን በ${formatStartsAt(
                    p.startsAtUtc,
                    'am',
                )} መቀበል አልቻለም። እባክዎ ሌላ ሰዓት ወይም ሌላ ቢዝነስ ይምረጡ።`,
            ),
    }),

    'booking.cancelled.business': Object.freeze({
        en: (p) =>
            plain(
                `${customerLabel(p, 'en')} cancelled their ${p.serviceName} booking on ${formatStartsAt(
                    p.startsAtUtc,
                    'en',
                )}${reasonSuffix(p.cancelReason, 'en')}.`,
            ),
        am: (p) =>
            plain(
                `${customerLabel(p, 'am')} የ${p.serviceName} ቀጠሯቸውን በ${formatStartsAt(
                    p.startsAtUtc,
                    'am',
                )} ሰርዘዋል${reasonSuffix(p.cancelReason, 'am')}።`,
            ),
    }),

    'booking.cancelled.customer': Object.freeze({
        en: (p) =>
            plain(
                `${p.businessName} cancelled your ${p.serviceName} booking on ${formatStartsAt(
                    p.startsAtUtc,
                    'en',
                )}${reasonSuffix(p.cancelReason, 'en')}. We're sorry for the inconvenience.`,
            ),
        am: (p) =>
            plain(
                `${p.businessName} የ${p.serviceName} ቀጠሮዎን በ${formatStartsAt(
                    p.startsAtUtc,
                    'am',
                )} ሰርዟል${reasonSuffix(p.cancelReason, 'am')}። ስለ ችግሩ ይቅርታ እንጠይቃለን።`,
            ),
    }),

    'booking.rescheduled.business': Object.freeze({
        en: (p) =>
            plain(
                `${customerLabel(p, 'en')} rescheduled their ${p.serviceName} booking to ${formatStartsAt(
                    p.startsAtUtc,
                    'en',
                )}${notesSuffix(p.rescheduleNotes, 'en')}.`,
            ),
        am: (p) =>
            plain(
                `${customerLabel(p, 'am')} የ${p.serviceName} ቀጠሯቸውን ወደ ${formatStartsAt(
                    p.startsAtUtc,
                    'am',
                )} ቀይረዋል${notesSuffix(p.rescheduleNotes, 'am')}።`,
            ),
    }),

    'booking.reminder.customer': Object.freeze({
        en: (p) =>
            plain(
                `Reminder: your ${p.serviceName} appointment with ${p.businessName} is on ${formatStartsAt(
                    p.startsAtUtc,
                    'en',
                )}. See you soon!`,
            ),
        am: (p) =>
            plain(
                `ማስታወሻ: የ${p.serviceName} ቀጠሮዎ ከ${p.businessName} ጋር በ${formatStartsAt(
                    p.startsAtUtc,
                    'am',
                )} ነው። በቅርቡ እንገናኝ!`,
            ),
    }),

    'booking.reminder.business': Object.freeze({
        en: (p) =>
            plain(
                `Reminder: ${customerLabel(p, 'en')} has a ${p.serviceName} appointment with you on ${formatStartsAt(
                    p.startsAtUtc,
                    'en',
                )}.`,
            ),
        am: (p) =>
            plain(
                `ማስታወሻ: ${customerLabel(p, 'am')} ከእርስዎ ጋር የ${p.serviceName} ቀጠሮ አላቸው፣ ${formatStartsAt(
                    p.startsAtUtc,
                    'am',
                )}።`,
            ),
    }),
});

const FALLBACK_LOCALE: UserLocale = 'en';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the given `templateKey` against `payload`, in the
 * requested `locale`. Throws `UnknownTemplateKeyError` if the
 * key isn't registered — the dispatcher treats that as a
 * non-retryable configuration error.
 *
 * Locale fallback: if the requested locale has no entry for this
 * template (e.g. `'am'` while only `'en'` is registered), the
 * registry transparently falls back to `'en'`. This makes it
 * safe for `users.locale` to widen ahead of the translation pass
 * — users stay receiving the English copy until their locale's
 * renderer lands.
 *
 * `locale` defaults to `'en'` so existing callers don't have to
 * change.
 */
export function renderTemplate(
    templateKey: string,
    payload: BookingTemplatePayload,
    locale: UserLocale = FALLBACK_LOCALE,
): NotificationRenderedMessage {
    const perLocale = (
        RENDERERS as Record<string, Readonly<Partial<Record<UserLocale, Renderer>>> | undefined>
    )[templateKey];
    if (!perLocale) {
        throw new UnknownTemplateKeyError(templateKey);
    }
    const renderer = perLocale[locale] ?? perLocale[FALLBACK_LOCALE];
    if (!renderer) {
        // Defensive: if a template is registered with no English
        // entry the call site is buggy. Surface it loudly.
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

function customerLabel(
    p: BookingTemplatePayload,
    locale: UserLocale,
): string {
    if (p.customerDisplayName) return p.customerDisplayName;
    return locale === 'am' ? 'አንድ ደንበኛ' : 'A customer';
}

function reasonSuffix(
    reason: string | null | undefined,
    locale: UserLocale,
): string {
    if (!reason) return '';
    const label = locale === 'am' ? 'ምክንያት' : 'reason';
    return ` (${label}: ${reason})`;
}

function notesSuffix(
    notes: string | null | undefined,
    locale: UserLocale,
): string {
    if (!notes) return '';
    const label = locale === 'am' ? 'ማስታወሻ' : 'notes';
    return ` (${label}: ${notes})`;
}

/**
 * Pretty-print a UTC ISO-8601 timestamp in Addis Ababa local
 * time. Falls back to the raw ISO string if Luxon can't parse it
 * — defensive only; the dispatcher always passes a valid value.
 *
 * English: relies on Luxon's default format (e.g. "Fri 15 May,
 * 2:00 PM"). Amharic: hand-rolled with the
 * `AM_WEEKDAY_SHORT` / `AM_MONTH_SHORT` lookups + ጥዋት/ከሰዓት
 * meridiem, so the output is deterministic regardless of the
 * Node ICU build.
 */
function formatStartsAt(
    startsAtUtc: string,
    locale: UserLocale,
): string {
    const dt = DateTime.fromISO(startsAtUtc, { zone: 'utc' }).setZone(ADDIS_TZ);
    if (!dt.isValid) return startsAtUtc;
    if (locale === 'am') {
        const weekday = AM_WEEKDAY_SHORT[dt.weekday] ?? '';
        const month = AM_MONTH_SHORT[dt.month] ?? '';
        const hour24 = dt.hour;
        const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
        const minute = dt.minute.toString().padStart(2, '0');
        const meridiem = hour24 < 12 ? 'ጥዋት' : 'ከሰዓት';
        return `${weekday} ${dt.day} ${month}, ${hour12}:${minute} ${meridiem}`;
    }
    // e.g. "Fri 17 May, 2:00 PM"
    return dt.toFormat('ccc d LLL, h:mm a');
}

/**
 * Amharic weekday abbreviations, indexed by Luxon's
 * `DateTime#weekday` (1 = Monday … 7 = Sunday). Hand-rolled so
 * the output doesn't depend on the Node runtime's ICU
 * Amharic data — keeps unit tests deterministic across CI
 * runners.
 */
const AM_WEEKDAY_SHORT: Readonly<Record<number, string>> = Object.freeze({
    1: 'ሰኞ',
    2: 'ማክሰ',
    3: 'ረቡዕ',
    4: 'ሐሙስ',
    5: 'ዓርብ',
    6: 'ቅዳሜ',
    7: 'እሁድ',
});

/**
 * Amharic Gregorian month abbreviations, indexed by Luxon's
 * `DateTime#month` (1 = January … 12 = December). Ethiopian
 * calendar months (መስከረም/ጥቅምት/…) are deliberately NOT used —
 * the system stores Gregorian timestamps and these messages are
 * pretty-prints of the Gregorian date in Amharic script.
 */
const AM_MONTH_SHORT: Readonly<Record<number, string>> = Object.freeze({
    1: 'ጃንዋ',
    2: 'ፌብሩ',
    3: 'ማርች',
    4: 'ኤፕሪ',
    5: 'ሜይ',
    6: 'ጁን',
    7: 'ጁላይ',
    8: 'ኦገስ',
    9: 'ሴፕቴ',
    10: 'ኦክቶ',
    11: 'ኖቬም',
    12: 'ዲሴም',
});
