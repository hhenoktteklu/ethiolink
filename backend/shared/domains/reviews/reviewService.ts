// EthioLink — reviews service.
//
// Owns the four invariants for a review-create:
//
//   1. The appointment must exist (and not be soft-deleted).
//   2. The caller must be the customer on that appointment.
//   3. The appointment status must be `COMPLETED`.
//   4. No live review can exist for the appointment (UNIQUE on
//      `reviews.appointment_id` is the belt-and-braces guarantee).
//
// On success: insert the review, then refresh the denormalized
// `business_profiles.rating_avg` / `rating_count` for the affected
// business.
//
// Note on atomicity: the two statements run sequentially without
// `withTransaction`. Between them, the row is committed but the
// `business_profiles` aggregate is stale. The recompute is
// from-scratch (`SELECT AVG(...), COUNT(*) FROM reviews WHERE ...`),
// so any drift is self-healing: the next review (or an admin
// reconciliation job) will write the correct values. The MVP UI
// surface is rating-on-listing, where a few-ms stale read is not
// material. If a stronger guarantee is needed later, wrap both ops
// in `withTransaction` and inject the transactor here.

import type {
    AppointmentsRepository,
    AppointmentStatus,
} from '../appointments/appointmentsRepository.js';
import type { UserRole } from '../../adapters/auth/AuthProvider.js';

import type {
    InsertReviewInput,
    Review,
    ReviewRepository,
} from './reviewRepository.js';

// ---------------------------------------------------------------------------
// Caller context — same shape as the other domain services
// ---------------------------------------------------------------------------

export interface CallerContext {
    readonly userId: string;
    readonly role: UserRole;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateReviewInput {
    /** Integer 1..5. The service revalidates as a belt-and-braces guard. */
    readonly rating: number;
    readonly comment?: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ReviewAppointmentNotFoundError extends Error {
    public readonly appointmentId: string;
    constructor(appointmentId: string) {
        super(`Appointment ${appointmentId} not found.`);
        this.name = 'ReviewAppointmentNotFoundError';
        this.appointmentId = appointmentId;
    }
}

export class ReviewNotOwnedError extends Error {
    constructor() {
        super('Caller is not the customer on this appointment.');
        this.name = 'ReviewNotOwnedError';
    }
}

export class ReviewAppointmentNotCompletedError extends Error {
    public readonly status: AppointmentStatus;
    constructor(status: AppointmentStatus) {
        super(
            `Reviews require an appointment in COMPLETED status; got ${status}.`,
        );
        this.name = 'ReviewAppointmentNotCompletedError';
        this.status = status;
    }
}

export class ReviewAlreadyExistsError extends Error {
    constructor() {
        super('A review already exists for this appointment.');
        this.name = 'ReviewAlreadyExistsError';
    }
}

export class ReviewInvalidRatingError extends Error {
    public readonly rating: unknown;
    constructor(rating: unknown) {
        super('Rating must be an integer between 1 and 5.');
        this.name = 'ReviewInvalidRatingError';
        this.rating = rating;
    }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Postgres SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ReviewService {
    constructor(
        private readonly reviewRepo: ReviewRepository,
        private readonly appointmentsRepo: AppointmentsRepository,
    ) {}

    /**
     * Create a review for a completed appointment. See module header
     * for the four-invariant rule set.
     */
    async createReview(
        appointmentId: string,
        caller: CallerContext,
        input: CreateReviewInput,
    ): Promise<Review> {
        assertRating(input.rating);

        const appointment = await this.appointmentsRepo.findById(appointmentId);
        if (!appointment || appointment.deletedAt !== null) {
            throw new ReviewAppointmentNotFoundError(appointmentId);
        }
        if (appointment.customerId !== caller.userId) {
            throw new ReviewNotOwnedError();
        }
        if (appointment.status !== 'COMPLETED') {
            throw new ReviewAppointmentNotCompletedError(appointment.status);
        }

        const existing = await this.reviewRepo.findByAppointmentId(appointmentId);
        if (existing) {
            throw new ReviewAlreadyExistsError();
        }

        const payload: InsertReviewInput = {
            appointmentId,
            customerId: caller.userId,
            businessId: appointment.businessId,
            rating: input.rating,
            comment: input.comment ?? null,
        };

        let inserted: Review;
        try {
            inserted = await this.reviewRepo.insert(payload);
        } catch (err) {
            if (isUniqueViolation(err)) {
                // Race lost: a concurrent caller inserted a review
                // between our pre-check and the INSERT.
                throw new ReviewAlreadyExistsError();
            }
            throw err;
        }

        // Best-effort recompute. See module header — non-atomic
        // intentionally, idempotent by construction.
        await this.reviewRepo.recomputeBusinessRatingAggregate(
            appointment.businessId,
        );

        return inserted;
    }

    /**
     * Public listing for a business. Filters soft-deleted rows at
     * the repository layer. No cursor pagination in MVP — `limit`
     * caps at {@link MAX_LIST_LIMIT}.
     */
    async listForBusiness(
        businessId: string,
        requestedLimit?: number,
    ): Promise<readonly Review[]> {
        const limit = clampLimit(requestedLimit);
        return this.reviewRepo.listForBusiness(businessId, limit);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertRating(rating: unknown): asserts rating is number {
    if (
        typeof rating !== 'number' ||
        !Number.isFinite(rating) ||
        !Number.isInteger(rating) ||
        rating < 1 ||
        rating > 5
    ) {
        throw new ReviewInvalidRatingError(rating);
    }
}

function clampLimit(requested: number | undefined): number {
    if (requested === undefined) return DEFAULT_LIST_LIMIT;
    if (
        !Number.isInteger(requested) ||
        requested < 1 ||
        requested > MAX_LIST_LIMIT
    ) {
        return DEFAULT_LIST_LIMIT;
    }
    return requested;
}

function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: unknown }).code === PG_UNIQUE_VIOLATION
    );
}
