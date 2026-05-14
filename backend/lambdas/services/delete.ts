// EthioLink — Lambda handler for `DELETE /v1/businesses/{businessId}/services/{id}`.
//
// Authenticated, BUSINESS_OWNER-only. **Soft-delete** — flips
// `is_active = false` on the row; never removes it. Historical
// appointments reference services via `ON DELETE RESTRICT`, so hard
// removal would orphan them.
//
// Returns the deactivated service (`isActive: false` in the response)
// so clients can confirm the state transition without an extra GET.
//
// Service errors → HTTP:
//   * ServiceNotFoundError  → 404
//   * ServiceNotOwnedError  → 403

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
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgServiceRepository } from '../../shared/domains/services/serviceRepository.js';
import {
    ServiceNotFoundError,
    ServiceNotOwnedError,
    ServiceService,
} from '../../shared/domains/services/serviceService.js';
import { toServiceView } from '../../shared/domains/services/serviceView.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    forbidden,
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import { UUID_RE } from './_validators.js';

const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const serviceService = new ServiceService(
    new PgServiceRepository(pool),
    new PgBusinessRepository(pool),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'services.delete',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('businessId must be a UUID.', { field: 'businessId' });
    }
    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('id must be a UUID.', { field: 'id' });
    }

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'BUSINESS_OWNER') {
            return forbidden('Only BUSINESS_OWNER role can deactivate services.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        try {
            const service = await serviceService.deactivate(id, {
                userId: user.id,
                role: principal.role,
            });
            return ok(toServiceView(service));
        } catch (err) {
            if (err instanceof ServiceNotFoundError) {
                return notFound('Service not found.');
            }
            if (err instanceof ServiceNotOwnedError) {
                return forbidden(err.message);
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
        logger.error('services.delete.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
