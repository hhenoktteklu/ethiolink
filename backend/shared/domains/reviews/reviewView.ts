// EthioLink — JSON projection for a `Review` domain object.
//
// One public projection covers both the customer's "I just left a
// review" response (`POST /v1/appointments/:id/review`) and the
// public business-detail listing (`GET /v1/businesses/:id/reviews`).
// `deletedAt` is hidden from clients — soft-deleted rows are
// filtered at the repository layer and never reach this view.

import type { Review } from './reviewRepository.js';

export interface ReviewView {
    readonly id: string;
    readonly appointmentId: string;
    readonly customerId: string;
    readonly businessId: string;
    readonly rating: number;
    readonly comment: string | null;
    /** UTC ISO-8601. */
    readonly createdAt: string;
    /** UTC ISO-8601. */
    readonly updatedAt: string;
}

export function toReviewView(review: Review): ReviewView {
    return Object.freeze<ReviewView>({
        id: review.id,
        appointmentId: review.appointmentId,
        customerId: review.customerId,
        businessId: review.businessId,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt.toISOString(),
        updatedAt: review.updatedAt.toISOString(),
    });
}
