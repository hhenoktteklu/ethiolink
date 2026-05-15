// EthioLink — Lambda handler for `POST /v1/businesses/{id}/submit`.
//
// Authenticated, BUSINESS_OWNER-only. Transitions the caller's
// DRAFT business to PENDING_REVIEW. Validation that the business has
// the required fields (name, description, city, categoryId) is
// performed by `businessService.submit`; this handler just maps
// service errors onto HTTP codes.
//
// Service errors → HTTP:
//   * BusinessNotFoundError              → 404 NOT_FOUND
//   * BusinessNotOwnedError              → 403 FORBIDDEN
//   * BusinessInvalidTransitionError     → 409 CONFLICT
//   * BusinessIncompleteForSubmitError   → 400 VALIDATION_ERROR with
//                                          details.missing[]

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import {
    BusinessIncompleteForSubmitError,
    BusinessInvalidTransitionError,
    BusinessNotFoundError,
    BusinessNotOwnedError,
    BusinessService,
} from '../../shared/domains/businesses/businessService.js';
import { toBusinessOwnerView } from '../../shared/domains/businesses/businessView.js';
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

import { UUID_RE } from './_validators.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const businessService = new BusinessService(new PgBusinessRepository(pool));

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'businesses.submit',
    });

    const id = event.pathParameters?.businessId?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('Business id must be a UUID.', { field: 'id' });
    }

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'BUSINESS_OWNER') {
            return forbidden(
                'Only BUSINESS_OWNER role can submit a business for review.',
            );
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        try {
            const business = await businessService.submit(id, user.id);
            return ok(toBusinessOwnerView(business));
        } catch (err) {
            if (err instanceof BusinessNotFoundError) {
                return notFound('Business not found.');
            }
            if (err instanceof BusinessNotOwnedError) {
                return forbidden('Caller does not own this business.');
            }
            if (err instanceof BusinessInvalidTransitionError) {
                return conflict(
                    `Cannot submit a business in status ${err.from}; submit is only allowed from DRAFT.`,
                );
            }
            if (err instanceof BusinessIncompleteForSubmitError) {
                return validationError(
                    'Business is missing required fields for submission.',
                    { missing: err.missing },
                );
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
        logger.error('businesses.submit.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
