// EthioLink — Lambda handler for
// `GET /v1/businesses/{businessId}/featuring/packages`.
//
// Authenticated, BUSINESS_OWNER (owner-of-id). Returns the
// pre-priced featuring packages configured in this environment.
// `config.featuring.enabled = false` → 503 (FeaturingDisabledError);
// the owner UI hides the entry-point card when this happens, so
// the 503 is a defensive path rather than a normal flow.

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
import {
    FeaturingDisabledError,
    FeaturingService,
} from '../../shared/domains/featuring/featuringService.js';
import { toFeaturingPackageView } from '../../shared/domains/featuring/featuringView.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import {
    errorResponse,
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
    // CashGateway is the safe default for the list-packages handler —
    // it never authorizes anything here. The `subscribe` handler
    // builds its own service with the real gateway picked from
    // config.
    paymentGateway: new CashGateway(),
    config: config.featuring,
});

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'featuring.listPackages',
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

        try {
            const packages = featuringService.listPackages();
            return ok({ items: packages.map(toFeaturingPackageView) });
        } catch (err) {
            if (err instanceof FeaturingDisabledError) {
                return errorResponse(503, 'FEATURING_DISABLED', err.message);
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
        logger.error('featuring.listPackages.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
