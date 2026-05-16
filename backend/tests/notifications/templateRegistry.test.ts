// EthioLink — template registry unit tests.
//
// Verifies that every MVP `BookingTemplateKey` is registered and
// renders a non-empty body referencing the key's most-relevant
// payload fields. Pure unit tests — no I/O, no fakes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    BOOKING_TEMPLATE_KEYS,
    UnknownTemplateKeyError,
    isBookingTemplateKey,
    renderTemplate,
    type BookingTemplatePayload,
    type BookingTemplateKey,
} from '../../shared/domains/notifications/templateRegistry.js';

const PAYLOAD: BookingTemplatePayload = Object.freeze({
    businessName: 'Habesha Beauty Lounge',
    serviceName: 'Hair braiding',
    customerDisplayName: 'Henok',
    // 2026-05-15 11:00 UTC → 2026-05-15 14:00 Addis Ababa (UTC+3)
    startsAtUtc: '2026-05-15T11:00:00.000Z',
    cancelReason: 'Closed for maintenance',
    rescheduleNotes: 'Customer asked for later in the day',
});

describe('templateRegistry — registered keys', () => {
    it('lists exactly the eight MVP booking template keys', () => {
        assert.deepStrictEqual([...BOOKING_TEMPLATE_KEYS].sort(), [
            'booking.accepted.customer',
            'booking.cancelled.business',
            'booking.cancelled.customer',
            'booking.rejected.customer',
            'booking.reminder.business',
            'booking.reminder.customer',
            'booking.requested.business',
            'booking.rescheduled.business',
        ]);
    });

    it('isBookingTemplateKey accepts registered keys and rejects others', () => {
        assert.strictEqual(isBookingTemplateKey('booking.accepted.customer'), true);
        assert.strictEqual(isBookingTemplateKey('booking.unknown'), false);
        assert.strictEqual(isBookingTemplateKey(''), false);
    });

    it('renders every registered key as a non-empty body with a null subject', () => {
        for (const key of BOOKING_TEMPLATE_KEYS) {
            const result = renderTemplate(key, PAYLOAD);
            assert.strictEqual(result.subject, null, `subject must be null for ${key}`);
            assert.ok(
                result.body.length > 0,
                `body must be non-empty for ${key}`,
            );
            assert.deepStrictEqual(
                result.metadata,
                {},
                `metadata must be empty object for ${key}`,
            );
        }
    });
});

describe('templateRegistry — per-key content', () => {
    function render(key: BookingTemplateKey): string {
        return renderTemplate(key, PAYLOAD).body;
    }

    it('booking.requested.business mentions the customer + service', () => {
        const body = render('booking.requested.business');
        assert.match(body, /Henok/);
        assert.match(body, /Hair braiding/);
    });

    it('booking.accepted.customer mentions the business + service', () => {
        const body = render('booking.accepted.customer');
        assert.match(body, /Habesha Beauty Lounge/);
        assert.match(body, /Hair braiding/);
    });

    it('booking.rejected.customer mentions the business and tells the user to retry', () => {
        const body = render('booking.rejected.customer');
        assert.match(body, /Habesha Beauty Lounge/);
        assert.match(body, /another time|another business/i);
    });

    it('booking.cancelled.business includes the cancellation reason when present', () => {
        const body = render('booking.cancelled.business');
        assert.match(body, /Henok/);
        assert.match(body, /Closed for maintenance/);
    });

    it('booking.cancelled.customer includes the cancellation reason when present', () => {
        const body = render('booking.cancelled.customer');
        assert.match(body, /Habesha Beauty Lounge/);
        assert.match(body, /Closed for maintenance/);
    });

    it('booking.cancelled.* tolerate a missing cancellation reason', () => {
        const { cancelReason: _ignored, ...rest } = PAYLOAD;
        const lean: BookingTemplatePayload = { ...rest, cancelReason: null };
        const business = renderTemplate('booking.cancelled.business', lean).body;
        const customer = renderTemplate('booking.cancelled.customer', lean).body;
        assert.doesNotMatch(business, /reason:/);
        assert.doesNotMatch(customer, /reason:/);
    });

    it('booking.rescheduled.business mentions the new time and the notes when present', () => {
        const body = render('booking.rescheduled.business');
        assert.match(body, /Henok/);
        assert.match(body, /Customer asked for later in the day/);
    });

    it('booking.reminder.customer addresses the customer', () => {
        const body = render('booking.reminder.customer');
        assert.match(body, /Reminder/i);
        assert.match(body, /Habesha Beauty Lounge/);
    });

    it('booking.reminder.business addresses the business', () => {
        const body = render('booking.reminder.business');
        assert.match(body, /Reminder/i);
        assert.match(body, /Henok/);
    });

    it('falls back to "A customer" when customerDisplayName is null', () => {
        const anon: BookingTemplatePayload = {
            ...PAYLOAD,
            customerDisplayName: null,
        };
        const body = renderTemplate('booking.requested.business', anon).body;
        assert.match(body, /A customer/);
    });

    it('formats startsAt in Addis Ababa local time', () => {
        // UTC 11:00 -> Addis 14:00 (UTC+3). Friday 15 May 2026 stays Friday.
        const body = render('booking.accepted.customer');
        assert.match(body, /2:00 PM/);
        assert.match(body, /15 May/);
    });
});

describe('templateRegistry — unknown keys', () => {
    it('throws UnknownTemplateKeyError on unregistered keys', () => {
        assert.throws(
            () => renderTemplate('booking.does-not-exist', PAYLOAD),
            (err: unknown) => {
                assert.ok(err instanceof UnknownTemplateKeyError);
                assert.strictEqual(err.templateKey, 'booking.does-not-exist');
                return true;
            },
        );
    });
});

describe('templateRegistry — locale handling', () => {
    it('defaults to English when no locale is supplied', () => {
        const body = renderTemplate('booking.accepted.customer', PAYLOAD).body;
        assert.match(body, /accepted your/);
    });

    it('explicitly returns the English renderer for locale=en', () => {
        const body = renderTemplate(
            'booking.accepted.customer',
            PAYLOAD,
            'en',
        ).body;
        assert.match(body, /accepted your/);
    });

    it('every registered key renders a non-empty English body', () => {
        for (const key of BOOKING_TEMPLATE_KEYS) {
            const body = renderTemplate(key, PAYLOAD, 'en').body;
            assert.ok(body.length > 0, `en body must be non-empty for ${key}`);
            // English bodies contain only ASCII (plus the
            // standard punctuation we use). A quick sanity check
            // that we didn't accidentally swap an Amharic glyph
            // into an English renderer.
            assert.doesNotMatch(
                body,
                /[ሀ-፿]/,
                `en body should not contain Ethiopic glyphs for ${key}`,
            );
        }
    });

    it('every registered key renders a non-empty Amharic body', () => {
        for (const key of BOOKING_TEMPLATE_KEYS) {
            const body = renderTemplate(key, PAYLOAD, 'am').body;
            assert.ok(body.length > 0, `am body must be non-empty for ${key}`);
            // Amharic bodies must contain at least one Ethiopic
            // script glyph (U+1200-U+137F). If a renderer
            // accidentally returns the English copy this will
            // catch it.
            assert.match(
                body,
                /[ሀ-፿]/,
                `am body should contain Ethiopic glyphs for ${key}`,
            );
        }
    });

    it('Amharic body differs from English body for every key', () => {
        for (const key of BOOKING_TEMPLATE_KEYS) {
            const enBody = renderTemplate(key, PAYLOAD, 'en').body;
            const amBody = renderTemplate(key, PAYLOAD, 'am').body;
            assert.notStrictEqual(
                amBody,
                enBody,
                `am body must differ from en body for ${key}`,
            );
        }
    });

    it('Amharic body preserves proper nouns (business/service/customer) verbatim', () => {
        // We don't transliterate user-entered data. Latin-script
        // names flow through into the Amharic copy.
        const body = renderTemplate(
            'booking.accepted.customer',
            PAYLOAD,
            'am',
        ).body;
        assert.match(body, /Habesha Beauty Lounge/);
        assert.match(body, /Hair braiding/);
    });

    it('Amharic body formats startsAt with Amharic weekday + month + meridiem', () => {
        // UTC 11:00 -> Addis 14:00 (UTC+3). Friday 15 May 2026.
        // Friday = ዓርብ; May = ሜይ; 2:00 PM = ከሰዓት.
        const body = renderTemplate(
            'booking.accepted.customer',
            PAYLOAD,
            'am',
        ).body;
        assert.match(body, /ዓርብ/);
        assert.match(body, /ሜይ/);
        assert.match(body, /2:00 ከሰዓት/);
    });

    it('Amharic body uses Amharic suffix labels for reason / notes', () => {
        const cancelledBiz = renderTemplate(
            'booking.cancelled.business',
            PAYLOAD,
            'am',
        ).body;
        assert.match(cancelledBiz, /ምክንያት: Closed for maintenance/);

        const rescheduledBiz = renderTemplate(
            'booking.rescheduled.business',
            PAYLOAD,
            'am',
        ).body;
        assert.match(
            rescheduledBiz,
            /ማስታወሻ: Customer asked for later in the day/,
        );
    });

    it('Amharic body falls back to "አንድ ደንበኛ" when customerDisplayName is null', () => {
        const anon: BookingTemplatePayload = {
            ...PAYLOAD,
            customerDisplayName: null,
        };
        const body = renderTemplate(
            'booking.requested.business',
            anon,
            'am',
        ).body;
        assert.match(body, /አንድ ደንበኛ/);
    });

    it('falls back to English when an unsupported locale is requested', () => {
        // The type union only allows 'en' | 'am' at compile time,
        // but the registry guards against runtime callers (string
        // boundary) too. Casting to bypass the union mirrors what
        // a misconfigured caller might do.
        const enBody = renderTemplate('booking.accepted.customer', PAYLOAD, 'en').body;
        const fallback = renderTemplate(
            'booking.accepted.customer',
            PAYLOAD,
            'fr' as unknown as 'en',
        ).body;
        assert.strictEqual(fallback, enBody);
    });
});
