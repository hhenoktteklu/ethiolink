// EthioLink — Lambda handler for `POST /v1/appointments/{id}/review`.
//
// Authenticated, CUSTOMER-only. The calling customer leaves a review
// for their completed appointment. The service enforces the
// four-invariant rule set (appointment exists, caller is the
// customer, status is COMPLETED, no existing review).
//
// Body fields:
//   * rating  — integer 1..5, required.
//   * comment — string, optional. Trimmed, max 2000 chars; `null` /
//               `""` / absent all map to `null`.
//
// Service-error mapping:
//   * ReviewAppointmentNotFoundError       → 404 NOT_FOUND
//   * ReviewNotOwnedError                  → 403 FORBIDDEN
//   * ReviewAppointmentNotCompletedError   → 409 CONFLICT
//   * ReviewAlreadyExistsError             → 409 CONFLICT
//   * ReviewInvalidRatingError             → 400 VALIDATION_ERROR
//     (defensive — `parseRating` should catch malformed input first)

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadConfig } from '../../shared/config/loadConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgAppointmentsRepository } from '../../shared/domains/appointments/appointmentsRepository.js';
import { PgReviewRepository } from '../../shared/domains/reviews/reviewRepository.js';
import {
    ReviewAlreadyExistsError,
    ReviewAppointmentNotCompletedError,
    ReviewAppointmentNotFoundError,
    ReviewInvalidRatingError,
    ReviewNotOwnedError,
    ReviewService,
} from '../../shared/domains/reviews/reviewService.js';
import { toReviewView } from '../../shared/domains/reviews/reviewView.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    conflict,
    forbidden,
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import {
    UUID_RE,
    ValidationFailure,
    parseJsonObjectBody,
    parseStringOrNull,
} from './_validators.js';

const COMMENT_MAX = 2000;

const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const reviewService = new ReviewService(
    new PgReviewRepository(pool),
    new PgAppointmentsRepository(pool),
);

interface ReviewBody {
    readonly rating: number;
    readonly comment: string | null;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'appointments.review',
    });

    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('Appointment id must be a UUID.', { field: 'id' });
    }

    let body: ReviewBody;
    try {
        body = parseReviewBody(event.body);
    } catch (err) {
        if (err instanceof ValidationFailure) {
            return validationError(err.message, err.details);
        }
        throw err;
    }

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'CUSTOMER') {
            return forbidden('Only CUSTOMER role can leave a review.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        try {
            const review = await reviewService.createReview(
                id,
                { userId: user.id, role: principal.role },
                { rating: body.rating, comment: body.comment },
            );
            return ok(toReviewView(review));
        } catch (err) {
            if (err instanceof ReviewAppointmentNotFoundError) {
                return notFound('Appointment not found.');
            }
            if (err instanceof ReviewNotOwnedError) {
                return forbidden(err.message);
            }
            if (err instanceof ReviewAppointmentNotCompletedError) {
                return conflict(err.message);
            }
            if (err instanceof ReviewAlreadyExistsError) {
                return conflict(err.message);
            }
            if (err instanceof ReviewInvalidRatingError) {
                return validationError(err.message, { field: 'rating' });
            }
            throw err;
        }
    } catch (err) {
        if (
            err instanceof TokenExpiredError ||
            err instanceof TokenInvalidError ||
            err instanceof ClaimsMalformedError ||
            err instanceof AuthError
        ) {
            logger.warn('auth.unauthenticated', { reason: err.message });
            return unauthenticated(err.message);
        }
        logger.error('appointments.review.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseReviewBody(rawBody: string | null): ReviewBody {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });
    const rating = parseRating(obj.rating);
    const comment = parseStringOrNull(obj.comment, 'comment', COMMENT_MAX);
    return { rating, comment };
}

function parseRating(value: unknown): number {
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 5
    ) {
        throw new ValidationFailure('rating must be an integer between 1 and 5.', {
            field: 'rating',
        });
    }
    return value;
}
