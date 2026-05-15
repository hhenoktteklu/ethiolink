// EthioLink — Lambda handler for `GET /v1/admin/categories`.
//
// Authenticated, ADMIN-only. Lists categories (active + deactivated)
// in the canonical sort order (`sort_order ASC, name->>'en' ASC`).
// Returns `AdminCategoryView` rows (adds `isActive` so the dashboard
// can colour-code deactivated entries).
//
// Reads bypass `AdminCategoryService` and go straight through
// `CategoryRepository.listForAdmin` — no audit row on reads.
//
// Query parameters (all optional):
//   * isActive — `true` or `false` (case-insensitive). Narrows the
//                response to one bucket.
//   * limit    — integer 1..100. Defaults to 100 (the MVP marketplace
//                has four categories; the cap is generous).

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
import { PgCategoryRepository } from '../../../shared/domains/categories/categoryRepository.js';
import { toAdminCategoryView } from '../../../shared/domains/categories/categoryView.js';
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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const categoryRepo = new PgCategoryRepository(pool);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.categories.list',
    });

    try {
        const authz = await authorizeAdmin(event, authProvider, userService);
        if (!authz.ok) return authz.response;

        const parsed = parseQuery(event);
        if ('error' in parsed) return parsed.error;

        const rows = await categoryRepo.listForAdmin(
            { isActive: parsed.isActive },
            parsed.limit,
        );
        return ok({ items: rows.map(toAdminCategoryView) });
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
        logger.error('admin.categories.list.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseQuery(event: APIGatewayProxyEvent):
    | { readonly isActive?: boolean; readonly limit: number }
    | { readonly error: APIGatewayProxyResult } {
    const qs = event.queryStringParameters ?? {};

    let isActive: boolean | undefined;
    const isActiveRaw = qs.isActive?.trim().toLowerCase();
    if (isActiveRaw !== undefined && isActiveRaw !== '') {
        if (isActiveRaw === 'true') {
            isActive = true;
        } else if (isActiveRaw === 'false') {
            isActive = false;
        } else {
            return {
                error: validationError(
                    "isActive must be 'true' or 'false'.",
                    { field: 'isActive', value: qs.isActive },
                ),
            };
        }
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

    return { isActive, limit };
}
