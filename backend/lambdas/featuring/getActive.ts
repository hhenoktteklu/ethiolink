// EthioLink — Lambda handler for
// `GET /v1/businesses/{businessId}/featuring/active`.
//
// Authenticated, BUSINESS_OWNER (owner-of-id). Returns the
// currently-ACTIVE featuring subscription for the caller's
// business, or `null` when none. Independent of the
// `config.featuring.enabled` flag — owners on a disabled env
// can still read their (admin-comp'd) active row.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../shared/adapters/auth/AuthProvider.js';
import { CashGateway } from '../../shared/adapters/payments/CashGateway.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgFeaturingRepository } from '../../shared/domains/featuring/featuringRepository.js';
import { FeaturingService } from '../../shared/domains/featuring/featuringService.js';
import { toFeaturingSubscriptionView } from '../../shared/domains/featuring/featuringView.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import {
    internalError,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import { UUID_RE, authorizeOwnerForBusiness } from './_authz.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const businessRepo = new PgBusinessRepository(pool);
const featuringRepo = new PgFeaturingRepository(pool);
const featuringService = new FeaturingService({
    featuringRepo,
    businessRepo,
    paymentGateway: new CashGateway(),
    config: config.featuring,
});

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'featuring.getActive',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('Business id must be a UUID.', {
            field: 'businessId',
        });
    }

    try {
        const authz = await authorizeOwnerForBusiness(event, businessId, {
            authProvider,
            userService,
            businessRepo,
        });
        if (!authz.ok) return authz.response;

        const active = await featuringRepo.findActiveByBusinessId(businessId);
        // The service is constructed but unused for this read; keep
        // it wired so a future "include packages in this response"
        // tweak doesn't have to plumb fresh deps. Reference the
        // import to keep tree-shaking honest in the meantime.
        void featuringService;

        return ok({
            active: active ? toFeaturingSubscriptionView(active) : null,
        });
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
        logger.error('featuring.getActive.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
