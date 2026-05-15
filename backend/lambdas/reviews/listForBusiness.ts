// EthioLink — Lambda handler for `GET /v1/businesses/{id}/reviews`.
//
// Public endpoint (no auth). Returns reviews for the given business,
// newest first, soft-deleted rows excluded by the repository.
//
// Query parameters:
//   * limit — optional integer 1..100. Defaults to 100 (the service
//             also caps; the handler validates the shape).
//
// No cursor pagination in MVP. The denormalized rating aggregate on
// `business_profiles` already covers the headline number; the
// detail listing is mostly browsed top-of-list.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgAppointmentsRepository } from '../../shared/domains/appointments/appointmentsRepository.js';
import { PgReviewRepository } from '../../shared/domains/reviews/reviewRepository.js';
import { ReviewService } from '../../shared/domains/reviews/reviewService.js';
import { toReviewView } from '../../shared/domains/reviews/reviewView.js';
import {
    internalError,
    ok,
    validationError,
} from '../../shared/http/responses.js';
import { UUID_RE } from '../../shared/http/validation.js';
import { createLogger } from '../../shared/logging/logger.js';

const MAX_LIMIT = 100;

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const pool = getPool(config);
const reviewService = new ReviewService(
    new PgReviewRepository(pool),
    new PgAppointmentsRepository(pool),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'reviews.listForBusiness',
    });

    const businessId = event.pathParameters?.id?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('Business id must be a UUID.', { field: 'id' });
    }

    let limit: number | undefined;
    const limitRaw = event.queryStringParameters?.limit;
    if (typeof limitRaw === 'string' && limitRaw.trim() !== '') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (
            !Number.isInteger(parsed) ||
            parsed < 1 ||
            parsed > MAX_LIMIT
        ) {
            return validationError(
                `limit must be an integer between 1 and ${MAX_LIMIT}.`,
                { field: 'limit', value: limitRaw },
            );
        }
        limit = parsed;
    }

    try {
        const reviews = await reviewService.listForBusiness(businessId, limit);
        return ok({ items: reviews.map(toReviewView) });
    } catch (err) {
        logger.error('reviews.listForBusiness.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
