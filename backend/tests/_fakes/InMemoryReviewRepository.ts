// EthioLink — in-memory `ReviewRepository` for tests.
//
// Mirrors `PgReviewRepository` semantics:
//
//   * `insert` stores the row with a fresh UUID and now() timestamps.
//     `deletedAt` defaults to null. A primed knob
//     (`failNextInsertWithUniqueViolation`) can force the next call
//     to throw a pg-shaped `{ code: '23505' }` error so the
//     review-service `isUniqueViolation` translation path can be
//     tested without arranging a real concurrent insert.
//   * `findByAppointmentId` filters `deletedAt IS NULL` so a soft-
//     deleted review does NOT block a re-review of the same
//     appointment — same as the SQL repo.
//   * `listForBusiness` filters soft-deleted, sorts `createdAt DESC,
//     id DESC`, and caps at `limit`.
//   * `recomputeBusinessRatingAggregate` is the cross-domain UPDATE
//     in the SQL repo. The fake just records the call for tests to
//     assert on; computing a real aggregate against `business_profiles`
//     would require a fake business repo and adds nothing for the
//     unit tests in scope here.
//
// Test-side helpers:
//   * `seedReview(review)` — direct row injection. Accepts a Review
//     with arbitrary `deletedAt` to set up soft-deleted rows.
//   * `failNextInsertWithUniqueViolation()` — one-shot knob.
//   * `recomputeCallsFor(businessId)` — number of times the recompute
//     was invoked for that business.

import { randomUUID } from 'node:crypto';

import type {
    InsertReviewInput,
    Review,
    ReviewRepository,
} from '../../shared/domains/reviews/reviewRepository.js';

/**
 * pg-shaped error for `INSERT`s that hit the UNIQUE constraint on
 * `reviews.appointment_id`. Carries the same `.code` (`'23505'`) the
 * service's `isUniqueViolation` duck-typer looks for.
 */
class PgUniqueViolationError extends Error {
    public readonly code = '23505';
    constructor() {
        super('unique_violation (in-memory fake)');
        this.name = 'PgUniqueViolationError';
    }
}

export class InMemoryReviewRepository implements ReviewRepository {
    private readonly rows: Review[] = [];
    private uniquePrimed = false;
    private readonly recomputeCounts = new Map<string, number>();

    // ----- Test helpers -----------------------------------------------------

    /** Direct row injection. Set `deletedAt` to seed a soft-deleted review. */
    seedReview(review: Review): void {
        this.rows.push(Object.freeze({ ...review }));
    }

    /** Total seeded rows (including soft-deleted). */
    size(): number {
        return this.rows.length;
    }

    /**
     * Force the next `insert` to throw a pg-shaped unique-violation
     * error. Used to test the SQLSTATE 23505 → `ReviewAlreadyExistsError`
     * mapping without arranging a real race against `findByAppointmentId`.
     */
    failNextInsertWithUniqueViolation(): void {
        this.uniquePrimed = true;
    }

    /** How many times `recomputeBusinessRatingAggregate` was called for `businessId`. */
    recomputeCallsFor(businessId: string): number {
        return this.recomputeCounts.get(businessId) ?? 0;
    }

    // ----- ReviewRepository surface -----------------------------------------

    async insert(input: InsertReviewInput): Promise<Review> {
        if (this.uniquePrimed) {
            this.uniquePrimed = false;
            throw new PgUniqueViolationError();
        }
        // Mirror the UNIQUE on `appointment_id` (live rows only): a
        // second live insert for the same appointment id throws.
        const liveSameAppointment = this.rows.some(
            (r) => r.appointmentId === input.appointmentId && r.deletedAt === null,
        );
        if (liveSameAppointment) {
            throw new PgUniqueViolationError();
        }

        const now = new Date();
        const row: Review = Object.freeze({
            id: randomUUID(),
            appointmentId: input.appointmentId,
            customerId: input.customerId,
            businessId: input.businessId,
            rating: input.rating,
            comment: input.comment,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        });
        this.rows.push(row);
        return row;
    }

    async findByAppointmentId(appointmentId: string): Promise<Review | null> {
        const row = this.rows.find(
            (r) => r.appointmentId === appointmentId && r.deletedAt === null,
        );
        return row ?? null;
    }

    async listForBusiness(
        businessId: string,
        limit: number,
    ): Promise<readonly Review[]> {
        return this.rows
            .filter((r) => r.businessId === businessId && r.deletedAt === null)
            .sort(
                (a, b) =>
                    b.createdAt.getTime() - a.createdAt.getTime() ||
                    (a.id < b.id ? 1 : -1),
            )
            .slice(0, limit);
    }

    async recomputeBusinessRatingAggregate(businessId: string): Promise<void> {
        this.recomputeCounts.set(
            businessId,
            (this.recomputeCounts.get(businessId) ?? 0) + 1,
        );
    }
}
