// EthioLink — Lambda handler for `GET /v1/admin/users`.
//
// Authenticated, ADMIN-only. Lists users across every status / role.
// Returns `AdminUserView` (adds `status` so the dashboard can render
// ACTIVE / SUSPENDED / DELETED bands); `cognito_sub` stays hidden.
//
// Reads bypass `AdminUserService` and go straight through
// `UserRepository.listForAdmin` — no audit row for reads.
//
// Query parameters (all optional):
//   * status — one of ACTIVE / SUSPENDED / DELETED.
//   * role   — one of CUSTOMER / BUSINESS_OWNER / ADMIN.
//   * limit  — integer 1..100. Defaults to 50.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
    type UserRole,
} from '../../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadConfig } from '../../../shared/config/loadConfig.js';
import { getPool } from '../../../shared/db/pgClient.js';
import {
    PgUserRepository,
    type UserStatus,
} from '../../../shared/domains/users/userRepository.js';
import { UserService } from '../../../shared/domains/users/userService.js';
import { toAdminUserView } from '../../../shared/domains/users/userView.js';
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

const USER_STATUSES: readonly UserStatus[] = ['ACTIVE', 'SUSPENDED', 'DELETED'];
const USER_ROLES: readonly UserRole[] = ['CUSTOMER', 'BUSINESS_OWNER', 'ADMIN'];

const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userRepo = new PgUserRepository(pool);
const userService = new UserService(userRepo);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.users.list',
    });

    try {
        const authz = await authorizeAdmin(event, authProvider, userService);
        if (!authz.ok) return authz.response;

        const parsed = parseQuery(event);
        if ('error' in parsed) return parsed.error;

        const rows = await userRepo.listForAdmin(
            { status: parsed.status, role: parsed.role },
            parsed.limit,
        );
        return ok({ items: rows.map(toAdminUserView) });
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
        logger.error('admin.users.list.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseQuery(event: APIGatewayProxyEvent):
    | {
          readonly status?: UserStatus;
          readonly role?: UserRole;
          readonly limit: number;
      }
    | { readonly error: APIGatewayProxyResult } {
    const qs = event.queryStringParameters ?? {};

    let status: UserStatus | undefined;
    const statusRaw = qs.status?.trim();
    if (statusRaw !== undefined && statusRaw !== '') {
        const upper = statusRaw.toUpperCase();
        if (!USER_STATUSES.includes(upper as UserStatus)) {
            return {
                error: validationError(
                    `status must be one of: ${USER_STATUSES.join(', ')}.`,
                    { field: 'status', allowed: USER_STATUSES },
                ),
            };
        }
        status = upper as UserStatus;
    }

    let role: UserRole | undefined;
    const roleRaw = qs.role?.trim();
    if (roleRaw !== undefined && roleRaw !== '') {
        const upper = roleRaw.toUpperCase();
        if (!USER_ROLES.includes(upper as UserRole)) {
            return {
                error: validationError(
                    `role must be one of: ${USER_ROLES.join(', ')}.`,
                    { field: 'role', allowed: USER_ROLES },
                ),
            };
        }
        role = upper as UserRole;
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

    return { status, role, limit };
}
