// EthioLink — Lambda handler for `POST /v1/admin/categories`.
//
// Authenticated, ADMIN-only. Creates a new marketplace category and
// records one `CREATE_CATEGORY` row in `admin_actions`.
//
// Body:
//   * slug      — required, lowercase machine key (e.g. `salon`).
//   * name      — required `LocalizedText` `{ en: string, am?: string }`.
//   * sortOrder — optional non-negative integer; defaults to 0.
//   * notes     — optional, persisted to the audit row.
//
// The handler defers input validation to `AdminCategoryService`,
// which throws `AdminCategoryInvalidInputError` for shape failures.
// Slug uniqueness is enforced at the service layer (pre-check +
// SQLSTATE 23505 race-loss translation to `AdminCategorySlugTakenError`).
//
// Service-error mapping:
//   * AdminForbiddenError                    → 403 FORBIDDEN
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
import { loadConfig } from '../../../shared/config/loadConfig.js';
import { getPool } from '../../../shared/db/pgClient.js';
import { PgAdminActionRepository } from '../../../shared/domains/admin/adminActionRepository.js';
import { AdminForbiddenError } from '../../../shared/domains/admin/adminBusinessService.js';
import {
    AdminCategoryInvalidInputError,
    AdminCategoryService,
    AdminCategorySlugTakenError,
    type CreateCategoryInput,
} from '../../../shared/domains/admin/adminCategoryService.js';
import { PgCategoryRepository } from '../../../shared/domains/categories/categoryRepository.js';
import { toAdminCategoryView } from '../../../shared/domains/categories/categoryView.js';
import { PgUserRepository } from '../../../shared/domains/users/userRepository.js';
import { UserService } from '../../../shared/domains/users/userService.js';
import {
    conflict,
    forbidden,
    internalError,
    ok,
    unauthenticated,
    validationError,
} from '../../../shared/http/responses.js';
import {
    ValidationFailure,
    parseJsonObjectBody,
    parseStringOrNull,
} from '../../../shared/http/validation.js';
import { createLogger } from '../../../shared/logging/logger.js';

import { authorizeAdmin } from '../_authz.js';

const NOTES_MAX = 2000;

const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const adminCategoryService = new AdminCategoryService(
    new PgCategoryRepository(pool),
    new PgAdminActionRepository(pool),
);

interface ParsedBody {
    readonly input: CreateCategoryInput;
    readonly notes: string | null;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.categories.create',
    });

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
            const created = await adminCategoryService.createCategory(
                parsed.input,
                authz.caller,
                parsed.notes,
            );
            return ok(toAdminCategoryView(created));
        } catch (err) {
            if (err instanceof AdminForbiddenError) return forbidden(err.message);
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
        logger.error('admin.categories.create.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseBody(rawBody: string | null): ParsedBody {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });
    // Shallow shape only — the service performs deep validation and
    // throws `AdminCategoryInvalidInputError` with a typed `field`.
    const input: CreateCategoryInput = {
        slug: obj.slug as string,
        name: obj.name as CreateCategoryInput['name'],
        sortOrder:
            obj.sortOrder === undefined || obj.sortOrder === null
                ? undefined
                : (obj.sortOrder as number),
    };
    const notes = parseStringOrNull(obj.notes, 'notes', NOTES_MAX);
    return { input, notes };
}
