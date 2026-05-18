// EthioLink — Lambda handler for `GET /v1/admin/businesses`.
//
// Authenticated, ADMIN-only. Returns businesses across every status
// (DRAFT, PENDING_REVIEW, APPROVED, REJECTED, SUSPENDED). Optional
// `status` query filter narrows to a single bucket; the admin
// dashboard's "pending review" queue is the primary caller.
//
// Reads bypass `AdminBusinessService` and go straight through
// `BusinessRepository.listForAdmin` — there's no audit log row for
// reads. Response shape is `{ items: BusinessOwnerView[] }`; the
// owner view exposes `status` and `ownerUserId`, which the admin
// needs and the public view hides.
//
// Query parameters (all optional):
//   * status — one of DRAFT / PENDING_REVIEW / APPROVED / REJECTED / SUSPENDED.
//   * limit  — integer 1..100. Defaults to 50.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../../shared/db/pgClient.js';
import {
    type BusinessStatus,
    PgBusinessRepository,
} from '../../../shared/domains/businesses/businessRepository.js';
import { toBusinessOwnerView } from '../../../shared/domains/businesses/businessView.js';
import { PgUserRepository } from '../../../shared/domains/users/userRepository.js';
import { UserService } from '../../../shared/domains/users/userService.js';
import {
    internalError,
    ok,
    unauthenticated,
    validationError,
} from '../../../shared/http/responses.js';
import { createLogger } from '../../../shared/logging/logger.js';

import { authorizeAdmin } from '../_authz.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const BUSINESS_STATUSES: readonly BusinessStatus[] = [
    'DRAFT',
    'PENDING_REVIEW',
    'APPROVED',
    'REJECTED',
    'SUSPENDED',
];

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const businessRepo = new PgBusinessRepository(pool);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.businesses.list',
    });

    try {
        const authz = await authorizeAdmin(event, authProvider, userService);
        if (!authz.ok) return authz.response;

        const parsed = parseQuery(event);
        if ('error' in parsed) return parsed.error;

        const rows = await businessRepo.listForAdmin(
            { status: parsed.status },
            parsed.limit,
        );
        // Explicit arrow rather than `.map(toBusinessOwnerView)` —
        // the view now accepts an optional `options` parameter for
        // the `me.business` rejection-reason surface, and
        // `Array.prototype.map` would otherwise pass `(value, index)`
        // and the `index: number` would clash with the `options:
        // { rejection? }` shape at compile time. Admin list doesn't
        // need the rejection envelope (admin already sees status +
        // can open detail for the audit trail) so we pass no
        // options.
        return ok({ items: rows.map((row) => toBusinessOwnerView(row)) });
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
        logger.error('admin.businesses.list.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseQuery(event: APIGatewayProxyEvent):
    | { readonly status?: BusinessStatus; readonly limit: number }
    | { readonly error: APIGatewayProxyResult } {
    const qs = event.queryStringParameters ?? {};

    let status: BusinessStatus | undefined;
    const statusRaw = qs.status?.trim();
    if (statusRaw !== undefined && statusRaw !== '') {
        const upper = statusRaw.toUpperCase();
        if (!BUSINESS_STATUSES.includes(upper as BusinessStatus)) {
            return {
                error: validationError(
                    `status must be one of: ${BUSINESS_STATUSES.join(', ')}.`,
                    { field: 'status', allowed: BUSINESS_STATUSES },
                ),
            };
        }
        status = upper as BusinessStatus;
    }

    let limit = DEFAULT_LIMIT;
    const limitRaw = qs.limit?.trim();
    if (limitRaw !== undefined && limitRaw !== '') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
            return {
                error: validationError(
                    `limit must be an integer between 1 and ${MAX_LIMIT}.`,
                    { field: 'limit', value: limitRaw },
                ),
            };
        }
        limit = parsed;
    }

    return { status, limit };
}
