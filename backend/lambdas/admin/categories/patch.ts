// EthioLink — Lambda handler for `PATCH /v1/admin/categories/{id}`.
//
// Authenticated, ADMIN-only. Updates the editable fields of a
// category and records one `UPDATE_CATEGORY` row in `admin_actions`.
// `isActive` is NOT patched here — it has its own dedicated path
// (`DELETE /v1/admin/categories/{id}` flips it to `false`).
//
// Body fields (all optional):
//   * slug      — change the machine-friendly key.
//   * name      — `LocalizedText` `{ en: string, am?: string }`.
//   * sortOrder — non-negative integer.
//   * notes     — optional, persisted to the audit row.
//
// A patch with no changeable fields is still a valid call (the
// audit row records admin intent even when the row content didn't
// move). Input validation is delegated to `AdminCategoryService`.
//
// Service-error mapping:
//   * AdminForbiddenError                    → 403 FORBIDDEN
//   * AdminCategoryNotFoundError             → 404 NOT_FOUND
//   * AdminCategoryInvalidInputError         → 400 VALIDATION_ERROR
//   * AdminCategorySlugTakenError            → 409 CONFLICT

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
    AdminCategoryInvalidInputError,
    AdminCategoryNotFoundError,
    AdminCategoryService,
    AdminCategorySlugTakenError,
    type UpdateCategoryInput,
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

interface ParsedBody {
    readonly patch: UpdateCategoryInput;
    readonly notes: string | null;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.categories.patch',
    });

    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('Category id must be a UUID.', { field: 'id' });
    }

    let parsed: ParsedBody;
    try {
        parsed = parseBody(event.body);
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
            const updated = await adminCategoryService.updateCategory(
                id,
                parsed.patch,
                authz.caller,
                parsed.notes,
            );
            return ok(toAdminCategoryView(updated));
        } catch (err) {
            if (err instanceof AdminForbiddenError) return forbidden(err.message);
            if (err instanceof AdminCategoryNotFoundError) {
                return notFound(err.message);
            }
            if (err instanceof AdminCategoryInvalidInputError) {
                return validationError(err.message, { field: err.field });
            }
            if (err instanceof AdminCategorySlugTakenError) {
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
        logger.error('admin.categories.patch.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseBody(rawBody: string | null): ParsedBody {
    // `allowEmpty: true` — a `{}` body is a no-op patch that still
    // records an audit row (admin intent).
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: true });

    // Shallow shape only — the service performs deep validation and
    // throws `AdminCategoryInvalidInputError` with a typed `field`.
    const patch: UpdateCategoryInput = {
        slug: 'slug' in obj ? (obj.slug as string) : undefined,
        name:
            'name' in obj
                ? (obj.name as UpdateCategoryInput['name'])
                : undefined,
        sortOrder:
            'sortOrder' in obj
                ? (obj.sortOrder as number | undefined)
                : undefined,
    };
    const notes = parseStringOrNull(obj.notes, 'notes', NOTES_MAX);
    return { patch, notes };
}
