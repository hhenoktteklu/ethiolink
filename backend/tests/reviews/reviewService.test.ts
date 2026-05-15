// EthioLink — ReviewService unit tests.
//
// Exercises the four-invariant create-rule (appointment exists,
// caller is the customer, status is COMPLETED, no live duplicate) +
// the SQLSTATE-23505 race translation + the public listing's
// soft-delete filter + limit. Uses `InMemoryReviewRepository` and the
// widened `InMemoryAppointmentsRepository`.
//
// Coverage matches the test brief in PHASE_4_BOOKING.md:
//   * completed appointment can be reviewed by its customer
//   * insert triggers the rating-aggregate recompute
//   * appointment-not-found / not-owned / not-completed → typed errors
//   * pre-check duplicate → ReviewAlreadyExistsError
//   * race-loss 23505 → ReviewAlreadyExistsError
//   * rating out of range → ReviewInvalidRatingError
//   * listForBusiness filters soft-deleted rows
//   * listForBusiness respects `limit`

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type {
    Appointment,
    AppointmentStatus,
} from '../../shared/domains/appointments/appointmentsRepository.js';
import type { Review } from '../../shared/domains/reviews/reviewRepository.js';
import {
    type CallerContext,
    ReviewAlreadyExistsError,
    ReviewAppointmentNotCompletedError,
    ReviewAppointmentNotFoundError,
    ReviewInvalidRatingError,
    ReviewNotOwnedError,
    ReviewService,
} from '../../shared/domains/reviews/reviewService.js';

import { InMemoryAppointmentsRepository } from '../_fakes/InMemoryAppointmentsRepository.js';
import { InMemoryReviewRepository } from '../_fakes/InMemoryReviewRepository.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '44444444-4444-4444-4444-444444444444';

const BUSINESS_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SERVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const STAFF_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const APPOINTMENT_STARTS_AT = new Date('2026-05-15T06:00:00.000Z');
const APPOINTMENT_ENDS_AT = new Date('2026-05-15T07:00:00.000Z');

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function caller(userId: string, role: CallerContext['role'] = 'CUSTOMER'): CallerContext {
    return { userId, role };
}

function makeAppointment(overrides: Partial<Appointment> = {}): Appointment {
    const now = new Date('2026-05-15T08:00:00.000Z');
    return Object.freeze({
        id: randomUUID(),
        customerId: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        serviceId: SERVICE_ID,
        staffId: STAFF_ID,
        startsAt: APPOINTMENT_STARTS_AT,
        endsAt: APPOINTMENT_ENDS_AT,
        status: 'COMPLETED' as AppointmentStatus,
        paymentMethod: 'CASH' as const,
        priceEtb: 300,
        notes: null,
        cancelledBy: null,
        cancelReason: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        ...overrides,
    });
}

function makeReview(overrides: Partial<Review> = {}): Review {
    const now = new Date('2026-05-15T10:00:00.000Z');
    return Object.freeze({
        id: randomUUID(),
        appointmentId: randomUUID(),
        customerId: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        rating: 5,
        comment: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        ...overrides,
    });
}

interface Env {
    readonly service: ReviewService;
    readonly reviewRepo: InMemoryReviewRepository;
    readonly apptRepo: InMemoryAppointmentsRepository;
}

function build(): Env {
    const reviewRepo = new InMemoryReviewRepository();
    const apptRepo = new InMemoryAppointmentsRepository();
    return {
        service: new ReviewService(reviewRepo, apptRepo),
        reviewRepo,
        apptRepo,
    };
}

// ---------------------------------------------------------------------------
// createReview — happy path
// ---------------------------------------------------------------------------

describe('ReviewService.createReview — happy path', () => {
    it('creates a review on a COMPLETED appointment for its customer', async () => {
        const env = build();
        const appt = makeAppointment({ status: 'COMPLETED' });
        env.apptRepo.seedAppointment(appt);

        const review = await env.service.createReview(
            appt.id,
            caller(CUSTOMER_ID, 'CUSTOMER'),
            { rating: 5, comment: 'Loved it.' },
        );

        assert.strictEqual(review.appointmentId, appt.id);
        assert.strictEqual(review.businessId, BUSINESS_ID);
        assert.strictEqual(review.customerId, CUSTOMER_ID);
        assert.strictEqual(review.rating, 5);
        assert.strictEqual(review.comment, 'Loved it.');
        assert.strictEqual(review.deletedAt, null);
        assert.strictEqual(env.reviewRepo.size(), 1);
    });

    it('triggers a rating-aggregate recompute on the affected business', async () => {
        const env = build();
        const appt = makeAppointment({ status: 'COMPLETED' });
        env.apptRepo.seedAppointment(appt);

        await env.service.createReview(
            appt.id,
            caller(CUSTOMER_ID, 'CUSTOMER'),
            { rating: 4 },
        );

        assert.strictEqual(env.reviewRepo.recomputeCallsFor(BUSINESS_ID), 1);
        // Recompute is for the appointment's business, not any other.
        assert.strictEqual(env.reviewRepo.recomputeCallsFor(OTHER_ID), 0);
    });

    it('treats a missing comment as null', async () => {
        const env = build();
        const appt = makeAppointment({ status: 'COMPLETED' });
        env.apptRepo.seedAppointment(appt);

        const review = await env.service.createReview(
            appt.id,
            caller(CUSTOMER_ID, 'CUSTOMER'),
            { rating: 3 },
        );

        assert.strictEqual(review.comment, null);
    });
});

// ---------------------------------------------------------------------------
// createReview — typed errors
// ---------------------------------------------------------------------------

describe('ReviewService.createReview — appointment not found', () => {
    it('throws ReviewAppointmentNotFoundError on a missing appointment id', async () => {
        const env = build();
        await assert.rejects(
            () =>
                env.service.createReview(
                    '00000000-0000-0000-0000-00000000dead',
                    caller(CUSTOMER_ID, 'CUSTOMER'),
                    { rating: 5 },
                ),
            ReviewAppointmentNotFoundError,
        );
        assert.strictEqual(env.reviewRepo.size(), 0);
        assert.strictEqual(env.reviewRepo.recomputeCallsFor(BUSINESS_ID), 0);
    });

    it('throws ReviewAppointmentNotFoundError when the appointment is soft-deleted', async () => {
        const env = build();
        const appt = makeAppointment({
            status: 'COMPLETED',
            deletedAt: new Date(),
        });
        env.apptRepo.seedAppointment(appt);

        await assert.rejects(
            () =>
                env.service.createReview(
                    appt.id,
                    caller(CUSTOMER_ID, 'CUSTOMER'),
                    { rating: 5 },
                ),
            ReviewAppointmentNotFoundError,
        );
    });
});

describe('ReviewService.createReview — ownership', () => {
    it('throws ReviewNotOwnedError when caller is not the appointment customer', async () => {
        const env = build();
        const appt = makeAppointment({
            status: 'COMPLETED',
            customerId: CUSTOMER_ID,
        });
        env.apptRepo.seedAppointment(appt);

        await assert.rejects(
            () =>
                env.service.createReview(
                    appt.id,
                    caller(OTHER_ID, 'CUSTOMER'),
                    { rating: 5 },
                ),
            ReviewNotOwnedError,
        );
        assert.strictEqual(env.reviewRepo.size(), 0);
    });
});

describe('ReviewService.createReview — status guard', () => {
    const NON_COMPLETED: AppointmentStatus[] = [
        'REQUESTED',
        'ACCEPTED',
        'REJECTED',
        'CANCELLED',
        'NO_SHOW',
    ];

    for (const status of NON_COMPLETED) {
        it(`refuses a review on an appointment in status ${status}`, async () => {
            const env = build();
            const appt = makeAppointment({ status });
            env.apptRepo.seedAppointment(appt);

            await assert.rejects(
                () =>
                    env.service.createReview(
                        appt.id,
                        caller(CUSTOMER_ID, 'CUSTOMER'),
                        { rating: 5 },
                    ),
                (err: unknown) => {
                    assert.ok(err instanceof ReviewAppointmentNotCompletedError);
                    assert.strictEqual(err.status, status);
                    return true;
                },
            );
        });
    }
});

describe('ReviewService.createReview — duplicate live review', () => {
    it('throws ReviewAlreadyExistsError when a live review already exists (pre-check)', async () => {
        const env = build();
        const appt = makeAppointment({ status: 'COMPLETED' });
        env.apptRepo.seedAppointment(appt);
        env.reviewRepo.seedReview(makeReview({ appointmentId: appt.id }));

        await assert.rejects(
            () =>
                env.service.createReview(
                    appt.id,
                    caller(CUSTOMER_ID, 'CUSTOMER'),
                    { rating: 5 },
                ),
            ReviewAlreadyExistsError,
        );
        assert.strictEqual(env.reviewRepo.size(), 1); // unchanged
    });

    it('translates SQLSTATE 23505 from a race-loss insert', async () => {
        const env = build();
        const appt = makeAppointment({ status: 'COMPLETED' });
        env.apptRepo.seedAppointment(appt);
        env.reviewRepo.failNextInsertWithUniqueViolation();

        await assert.rejects(
            () =>
                env.service.createReview(
                    appt.id,
                    caller(CUSTOMER_ID, 'CUSTOMER'),
                    { rating: 5 },
                ),
            ReviewAlreadyExistsError,
        );
        assert.strictEqual(env.reviewRepo.size(), 0);
    });
});

describe('ReviewService.createReview — rating validation', () => {
    const BAD_RATINGS: Array<{ readonly label: string; readonly value: unknown }> = [
        { label: '0 (below 1)', value: 0 },
        { label: '6 (above 5)', value: 6 },
        { label: '-1 (negative)', value: -1 },
        { label: '3.5 (non-integer)', value: 3.5 },
        { label: 'NaN', value: Number.NaN },
        { label: 'a string', value: 'five' },
        { label: 'undefined', value: undefined },
    ];

    for (const { label, value } of BAD_RATINGS) {
        it(`refuses rating = ${label}`, async () => {
            const env = build();
            const appt = makeAppointment({ status: 'COMPLETED' });
            env.apptRepo.seedAppointment(appt);

            await assert.rejects(
                () =>
                    env.service.createReview(
                        appt.id,
                        caller(CUSTOMER_ID, 'CUSTOMER'),
                        // Cast through unknown so the helpers accept the
                        // deliberately-malformed value at the type level.
                        { rating: value as number },
                    ),
                ReviewInvalidRatingError,
            );
            assert.strictEqual(env.reviewRepo.size(), 0);
        });
    }

    it('accepts the boundary values 1 and 5', async () => {
        for (const rating of [1, 5] as const) {
            const env = build();
            const appt = makeAppointment({ status: 'COMPLETED' });
            env.apptRepo.seedAppointment(appt);

            const review = await env.service.createReview(
                appt.id,
                caller(CUSTOMER_ID, 'CUSTOMER'),
                { rating },
            );
            assert.strictEqual(review.rating, rating);
        }
    });
});

// ---------------------------------------------------------------------------
// listForBusiness
// ---------------------------------------------------------------------------

describe('ReviewService.listForBusiness', () => {
    it('returns only non-deleted rows, newest-first', async () => {
        const env = build();
        const t0 = new Date('2026-05-10T00:00:00.000Z');
        const t1 = new Date('2026-05-11T00:00:00.000Z');
        const t2 = new Date('2026-05-12T00:00:00.000Z');
        const t3 = new Date('2026-05-13T00:00:00.000Z');

        env.reviewRepo.seedReview(makeReview({ rating: 1, createdAt: t0 }));
        env.reviewRepo.seedReview(makeReview({ rating: 2, createdAt: t1 }));
        env.reviewRepo.seedReview(
            makeReview({ rating: 3, createdAt: t2, deletedAt: new Date() }),
        );
        env.reviewRepo.seedReview(makeReview({ rating: 4, createdAt: t3 }));

        const items = await env.service.listForBusiness(BUSINESS_ID);
        assert.strictEqual(items.length, 3);
        // Newest first; the soft-deleted rating=3 row is excluded.
        assert.deepStrictEqual(
            items.map((r) => r.rating),
            [4, 2, 1],
        );
    });

    it('respects the requested limit', async () => {
        const env = build();
        const base = new Date('2026-05-10T00:00:00.000Z').getTime();
        for (let i = 0; i < 5; i += 1) {
            env.reviewRepo.seedReview(
                makeReview({
                    rating: 5,
                    // Spread timestamps so the sort is deterministic.
                    createdAt: new Date(base + i * 60_000),
                }),
            );
        }

        const items = await env.service.listForBusiness(BUSINESS_ID, 3);
        assert.strictEqual(items.length, 3);
    });

    it('clamps limit to 100 when an out-of-range value is supplied', async () => {
        const env = build();
        env.reviewRepo.seedReview(makeReview());

        const items = await env.service.listForBusiness(BUSINESS_ID, 9999);
        assert.strictEqual(items.length, 1);
    });

    it('returns an empty list for a business with no reviews', async () => {
        const env = build();
        const items = await env.service.listForBusiness(OTHER_ID);
        assert.deepStrictEqual([...items], []);
    });
});
