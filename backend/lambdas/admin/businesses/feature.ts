// EthioLink — Lambda handler for `POST /v1/admin/businesses/{id}/feature`.
//
// Authenticated, ADMIN-only. Sets or clears `featured_until` on an
// `APPROVED` business. The same endpoint serves both intents: the
// body's `featuredUntil` field carries an ISO-8601 datetime to
// feature until, or `null` to unfeature.
//
// The service decides which audit action to record:
//   * `featuredUntil !== null` → `FEATURE_BUSINESS`
//   * `featuredUntil === null` → `UNFEATURE_BUSINESS`
//
// Body fields:
//   * featuredUntil — ISO-8601 datetime, or `null` to clear. Required
//     (`undefined` is rejected so the intent is always explicit).
//   * notes — optional, persisted to the audit row.
//
// Service-error mapping:
//   * AdminForbiddenError                    → 403 FORBIDDEN
//   * AdminBusinessNotFoundError             → 404 NOT_FOUND
//   * AdminBusinessInvalidTransitionError    → 409 CONFLICT
//     (non-APPROVED business)

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
import {
    AdminBusinessInvalidTransitionError,
    AdminBusinessNotFoundError,
    AdminBusinessService,
    AdminForbiddenError,
} from '../../../shared/domains/admin/adminBusinessService.js';
import { PgBusinessRepository } from '../../../shared/domains/businesses/businessRepository.js';
import { toBusinessOwnerView } from '../../../shared/domains/businesses/businessView.js';
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
const adminBusinessService = new AdminBusinessService(
    new PgBusinessRepository(pool),
    new PgAdminActionRepository(pool),
);

interface ParsedBody {
    readonly featuredUntil: Date | null;
    readonly notes: string | null;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.businesses.feature',
    });

    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('Business id must be a UUID.', { field: 'id' });
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
            const updated = await adminBusinessService.setFeaturedUntil(
                id,
                authz.caller,
                parsed.featuredUntil,
                parsed.notes,
            );
            return ok(toBusinessOwnerView(updated));
        } catch (err) {
            if (err instanceof AdminForbiddenError) return forbidden(err.message);
            if (err instanceof AdminBusinessNotFoundError) {
                return notFound(err.message);
            }
            if (err instanceof AdminBusinessInvalidTransitionError) {
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
        logger.error('admin.businesses.feature.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseBody(rawBody: string | null): ParsedBody {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });

    // `featuredUntil` is required-and-nullable: `undefined` is
    // rejected so the intent ("feature until X" vs "unfeature") is
    // always explicit on the wire.
    if (!('featuredUntil' in obj)) {
        throw new ValidationFailure(
            'featuredUntil is required (ISO-8601 string, or null to unfeature).',
            { field: 'featuredUntil' },
        );
    }
    const raw = obj.featuredUntil;
    let featuredUntil: Date | null;
    if (raw === null) {
        featuredUntil = null;
    } else if (typeof raw === 'string' && raw.trim() !== '') {
        const parsed = new Date(raw.trim());
        if (Number.isNaN(parsed.getTime())) {
            throw new ValidationFailure(
                'featuredUntil must be a valid ISO-8601 datetime or null.',
                { field: 'featuredUntil', value: raw },
            );
        }
        featuredUntil = parsed;
    } else {
        throw new ValidationFailure(
            'featuredUntil must be a string or null.',
            { field: 'featuredUntil' },
        );
    }

    const notes = parseStringOrNull(obj.notes, 'notes', NOTES_MAX);
    return { featuredUntil, notes };
}
