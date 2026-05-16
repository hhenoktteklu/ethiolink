// EthioLink — Lambda handler for
// `GET /v1/admin/businesses/{id}/featuring/history`.
//
// Authenticated, ADMIN-only. Returns every featuring subscription
// for a business in `created_at DESC` order, capped at `limit`
// (default 50, max 200 — admin views need a wider lens than the
// owner's 100 cap).

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../../shared/adapters/auth/AuthProvider.js';
import { CashGateway } from '../../../shared/adapters/payments/CashGateway.js';
import { CognitoAuthProvider } from '../../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../../shared/domains/businesses/businessRepository.js';
import { PgFeaturingRepository } from '../../../shared/domains/featuring/featuringRepository.js';
import { FeaturingService } from '../../../shared/domains/featuring/featuringService.js';
import { toFeaturingSubscriptionView } from '../../../shared/domains/featuring/featuringView.js';
import { PgUserRepository } from '../../../shared/domains/users/userRepository.js';
import { UserService } from '../../../shared/domains/users/userService.js';
import {
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../../shared/http/responses.js';
import { createLogger } from '../../../shared/logging/logger.js';
import { UUID_RE } from '../../featuring/_authz.js';

import { authorizeAdmin } from '../_authz.js';

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

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
        handler: 'admin.featuring.listHistory',
    });

    const businessId = event.pathParameters?.id?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('Business id must be a UUID.', { field: 'id' });
    }

    let limit = HISTORY_DEFAULT_LIMIT;
    const limitRaw = event.queryStringParameters?.limit?.trim();
    if (limitRaw !== undefined && limitRaw !== '') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (
            !Number.isInteger(parsed) ||
            parsed <= 0 ||
            parsed > HISTORY_MAX_LIMIT
        ) {
            return validationError(
                `limit must be an integer between 1 and ${HISTORY_MAX_LIMIT}.`,
                { field: 'limit', value: limitRaw },
            );
        }
        limit = parsed;
    }

    try {
        const authz = await authorizeAdmin(event, authProvider, userService);
        if (!authz.ok) return authz.response;

        const business = await businessRepo.findById(businessId);
        if (!business) return notFound('Business not found.');

        const rows = await featuringService.listHistoryForBusiness(
            businessId,
            limit,
        );
        return ok({ items: rows.map(toFeaturingSubscriptionView) });
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
        logger.error('admin.featuring.listHistory.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
