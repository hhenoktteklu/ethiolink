// EthioLink — reviews repository.
//
// SQL access to the `reviews` table created in migration 0010. The
// `reviewService` layer owns ownership / status / dedupe rules; this
// repository stays narrow:
//
//   * `insert` — row insert. UNIQUE on `appointment_id` is the
//     belt-and-braces dedupe guard; the service does a pre-check for
//     a nicer error path. Concurrent inserts raise SQLSTATE 23505
//     (`unique_violation`) which the service translates to
//     `ReviewAlreadyExistsError`. The repository does NOT translate
//     it (same pattern as `PgAppointmentsRepository` for 23P01).
//   * `findByAppointmentId` — dedupe pre-check. Filters
//     `deleted_at IS NULL` so an admin-soft-deleted review does NOT
//     block a re-review of the same appointment.
//   * `listForBusiness` — public-facing listing, ordered by
//     `created_at DESC, id DESC` to match the `(business_id,
//     created_at DESC)` index from migration 0010.
//   * `recomputeBusinessRatingAggregate` — re-derives
//     `business_profiles.rating_avg` / `rating_count` from the
//     current reviews state for that business and writes them in a
//     single UPDATE. The reviews module owns this denormalization
//     because reviews are the source of truth. The recompute is
//     idempotent: a future review (or an admin reconciliation job)
//     will heal any drift.
//
// Note on atomicity: `reviewService.createReview` calls `insert`
// and `recomputeBusinessRatingAggregate` as two separate
// statements (not wrapped in `withTransaction`). A small window
// exists where the row is committed but the aggregate is stale; the
// from-scratch nature of the recompute makes any inconsistency
// self-healing. Documented in `reviewService.ts`.

import { BaseRepository } from '../../repositories/baseRepository.js';

/** Domain shape of a `reviews` row. */
export interface Review {
    readonly id: string;
    readonly appointmentId: string;
    readonly customerId: string;
    readonly businessId: string;
    /** Integer 1..5. */
    readonly rating: number;
    readonly comment: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly deletedAt: Date | null;
}

/** Fields written by `insert`. */
export interface InsertReviewInput {
    readonly appointmentId: string;
    readonly customerId: string;
    readonly businessId: string;
    readonly rating: number;
    readonly comment: string | null;
}

export interface ReviewRepository {
    insert(input: InsertReviewInput): Promise<Review>;
    findByAppointmentId(appointmentId: string): Promise<Review | null>;
    listForBusiness(businessId: string, limit: number): Promise<readonly Review[]>;
    /**
     * Refresh `business_profiles.rating_avg` / `rating_count` for the
     * given business from the current reviews state. Idempotent; safe
     * to call repeatedly. Documents source-of-truth for the
     * denormalization that lives on `business_profiles`.
     */
    recomputeBusinessRatingAggregate(businessId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface ReviewRow {
    id: string;
    appointment_id: string;
    customer_id: string;
    business_id: string;
    rating: number;
    comment: string | null;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
}

const REVIEW_COLUMNS = [
    'id',
    'appointment_id',
    'customer_id',
    'business_id',
    'rating',
    'comment',
    'created_at',
    'updated_at',
    'deleted_at',
].join(', ');

export class PgReviewRepository extends BaseRepository implements ReviewRepository {
    async insert(input: InsertReviewInput): Promise<Review> {
        const row = await this.one<ReviewRow>(
            `
            INSERT INTO reviews (
                appointment_id, customer_id, business_id, rating, comment
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING ${REVIEW_COLUMNS};
            `,
            [
                input.appointmentId,
                input.customerId,
                input.businessId,
                input.rating,
                input.comment,
            ],
        );
        return mapRow(row);
    }

    async findByAppointmentId(appointmentId: string): Promise<Review | null> {
        const row = await this.oneOrNone<ReviewRow>(
            `
            SELECT ${REVIEW_COLUMNS}
              FROM reviews
             WHERE appointment_id = $1
               AND deleted_at IS NULL;
            `,
            [appointmentId],
        );
        return row ? mapRow(row) : null;
    }

    async listForBusiness(
        businessId: string,
        limit: number,
    ): Promise<readonly Review[]> {
        const rows = await this.many<ReviewRow>(
            `
            SELECT ${REVIEW_COLUMNS}
              FROM reviews
             WHERE business_id = $1
               AND deleted_at IS NULL
             ORDER BY created_at DESC, id DESC
             LIMIT $2;
            `,
            [businessId, limit],
        );
        return rows.map(mapRow);
    }

    async recomputeBusinessRatingAggregate(businessId: string): Promise<void> {
        // Single UPDATE that re-derives the aggregate from the current
        // reviews table. `COALESCE` handles the "no reviews left"
        // case (e.g. all soft-deleted) by writing 0/0 — same as the
        // initial business_profiles defaults.
        //
        // `numeric(3,2)` is the column type on business_profiles;
        // ROUND ensures we don't widen the result past the column's
        // precision before the implicit cast.
        await this.execute(
            `
            UPDATE business_profiles
               SET rating_avg = COALESCE(agg.rating_avg, 0),
                   rating_count = COALESCE(agg.rating_count, 0)
              FROM (
                   SELECT ROUND(AVG(rating)::numeric, 2) AS rating_avg,
                          COUNT(*) AS rating_count
                     FROM reviews
                    WHERE business_id = $1
                      AND deleted_at IS NULL
              ) AS agg
             WHERE business_profiles.id = $1;
            `,
            [businessId],
        );
    }
}

function mapRow(row: ReviewRow): Review {
    return Object.freeze<Review>({
        id: row.id,
        appointmentId: row.appointment_id,
        customerId: row.customer_id,
        businessId: row.business_id,
        rating: row.rating,
        comment: row.comment,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
    });
}
