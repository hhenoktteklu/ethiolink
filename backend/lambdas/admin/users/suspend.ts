// EthioLink — Lambda handler for `POST /v1/admin/users/{id}/suspend`.
//
// Authenticated, ADMIN-only. Transitions a user with status ACTIVE
// to SUSPENDED and records one `SUSPEND_USER` row in `admin_actions`.
// Optional `{ notes }` body is persisted to the audit row.
//
// Service-error mapping:
//   * AdminForbiddenError                → 403 FORBIDDEN
//   * AdminUserNotFoundError             → 404 NOT_FOUND
//   * AdminUserInvalidTransitionError    → 409 CONFLICT
//     (e.g. attempting to suspend a SUSPENDED or DELETED user)

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
import { PgAdminActionRepository } from '../../../shared/domains/admin/adminActionRepository.js';
import { AdminForbiddenError } from '../../../shared/domains/admin/adminBusinessService.js';
import {
    AdminUserInvalidTransitionError,
    AdminUserNotFoundError,
    AdminUserService,
} from '../../../shared/domains/admin/adminUserService.js';
import { PgUserRepository } from '../../../shared/domains/users/userRepository.js';
import { UserService } from '../../../shared/domains/users/userService.js';
import { toAdminUserView } from '../../../shared/domains/users/userView.js';
import {
    conflict,
    forbidden,
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../../shared/http/responses.js';
import {
    UUID_RE,
    ValidationFailure,
    parseJsonObjectBody,
    parseStringOrNull,
} from '../../../shared/http/validation.js';
import { createLogger } from '../../../shared/logging/logger.js';

import { authorizeAdmin } from '../_authz.js';

const NOTES_MAX = 2000;

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userRepo = new PgUserRepository(pool);
const userService = new UserService(userRepo);
const adminUserService = new AdminUserService(
    userRepo,
    new PgAdminActionRepository(pool),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.users.suspend',
    });

    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('User id must be a UUID.', { field: 'id' });
    }

    let notes: string | null = null;
    try {
        const body = parseJsonObjectBody(event.body, { allowEmpty: true });
        notes = parseStringOrNull(body.notes, 'notes', NOTES_MAX);
    } catch (err) {
        if (err instanceof ValidationFailure) {
            return validationError(err.message, err.details);
        }
        throw err;
    }

    try {
        const authz = await authorizeAdmin(event, authProvider, userService);
        if (!authz.ok) return authz.response;

        try {
            const updated = await adminUserService.suspendUser(
                id,
                authz.caller,
                notes,
            );
            return ok(toAdminUserView(updated));
        } catch (err) {
            if (err instanceof AdminForbiddenError) return forbidden(err.message);
            if (err instanceof AdminUserNotFoundError) {
                return notFound(err.message);
            }
            if (err instanceof AdminUserInvalidTransitionError) {
                return conflict(err.message);
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
        logger.error('admin.users.suspend.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
