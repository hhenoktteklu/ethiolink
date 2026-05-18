// EthioLink — Lambda handler for `GET /v1/me/business`.
//
// Returns the caller's own business at any status — DRAFT,
// PENDING_REVIEW, APPROVED, REJECTED, or SUSPENDED. Owner-only view,
// so the response includes the internal `status` and `ownerUserId`
// fields that the public projection omits.
//
// Auth path:
//   1. Extract the Cognito principal from the event.
//   2. Resolve `principal.sub` to a `users.id` via UserService. If the
//      caller has never called POST /v1/auth/sync, return 404 with a
//      hint pointing at that endpoint — same pattern as /v1/me.
//   3. Look up the business by `owner_user_id`. If they don't have one
//      yet, return 404 with a hint pointing at POST /v1/businesses.

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
import { PgAdminActionRepository } from '../../shared/domains/admin/adminActionRepository.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { BusinessService } from '../../shared/domains/businesses/businessService.js';
import {
    type BusinessRejection,
    toBusinessOwnerView,
} from '../../shared/domains/businesses/businessView.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    internalError,
    notFound,
    ok,
    unauthenticated,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const businessService = new BusinessService(new PgBusinessRepository(pool));
const adminActionRepository = new PgAdminActionRepository(pool);

// How many admin actions to scan when looking for the most-recent
// REJECT_BUSINESS row. 20 is comfortably above the typical
// approve / reject / suspend / feature ping-pong a single business
// goes through and well below the 200-row hard cap the repository
// enforces. Newer actions sort first (`created_at DESC, id DESC`),
// so the latest REJECT_BUSINESS always lands in the first page.
const REJECT_LOOKBACK = 20;

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'me.business',
    });

    try {
        const principal = await extractPrincipal(event, authProvider);

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound('User profile not found. Call POST /v1/auth/sync first.');
        }

        const business = await businessService.getByOwner(user.id);
        if (!business) {
            return notFound(
                'No business profile yet. Call POST /v1/businesses to create one.',
            );
        }

        // Surface the latest rejection note when the business is
        // REJECTED. Other statuses leave `rejection: null` — there's
        // no audit lookup on the happy path. The lookback is a
        // bounded query (LIMIT 20) so cold-start cost is one extra
        // round-trip only when an owner is staring at a rejected
        // business waiting to fix it.
        let rejection: BusinessRejection | null = null;
        if (business.status === 'REJECTED') {
            const actions = await adminActionRepository.listForTarget(
                'business_profile',
                business.id,
                REJECT_LOOKBACK,
            );
            const latestReject = actions.find(
                (a) => a.action === 'REJECT_BUSINESS',
            );
            if (latestReject) {
                rejection = {
                    reason: latestReject.notes,
                    rejectedAt: latestReject.createdAt.toISOString(),
                };
            }
        }

        return ok(toBusinessOwnerView(business, { rejection }));
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
        logger.error('me.business.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
