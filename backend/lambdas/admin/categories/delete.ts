// EthioLink — Lambda handler for `DELETE /v1/admin/categories/{id}`.
//
// Authenticated, ADMIN-only. **Soft-delete** — flips `is_active` to
// `false` on the row, never removes it. A `business_profiles` row
// may still reference the category via `category_id`; hard-deleting
// would either cascade those FKs or fail outright. Soft-delete
// preserves the historical relationship.
//
// Records one `DEACTIVATE_CATEGORY` row in `admin_actions`. Already-
// inactive rows are refused with 409 CONFLICT (keeps the audit log
// free of no-op rows).
//
// Body (optional): `{ "notes": "..." }`. Persisted to the audit row.
//
// Service-error mapping:
//   * AdminForbiddenError                       → 403 FORBIDDEN
//   * AdminCategoryNotFoundError                → 404 NOT_FOUND
//   * AdminCategoryInvalidTransitionError       → 409 CONFLICT
//     (already-inactive row)

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
    AdminCategoryInvalidTransitionError,
    AdminCategoryNotFoundError,
    AdminCategoryService,
} from '../../../shared/domains/admin/adminCategoryService.js';
import { PgCategoryRepository } from '../../../shared/domains/categories/categoryRepository.js';
import { toAdminCategoryView } from '../../../shared/domains/categories/categoryView.js';
import { PgUserRepository } from '../../../shared/domains/users/userRepository.js';
import { UserService } from '../../../shared/domains/users/userService.js';
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
const userService = new UserService(new PgUserRepository(pool));
const adminCategoryService = new AdminCategoryService(
    new PgCategoryRepository(pool),
    new PgAdminActionRepository(pool),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.categories.delete',
    });

    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('Category id must be a UUID.', { field: 'id' });
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
            const updated = await adminCategoryService.deactivateCategory(
                id,
                authz.caller,
                notes,
            );
            return ok(toAdminCategoryView(updated));
        } catch (err) {
            if (err instanceof AdminForbiddenError) return forbidden(err.message);
            if (err instanceof AdminCategoryNotFoundError) {
                return notFound(err.message);
            }
            if (err instanceof AdminCategoryInvalidTransitionError) {
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
        logger.error('admin.categories.delete.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
