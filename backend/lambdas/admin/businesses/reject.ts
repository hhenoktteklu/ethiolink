// EthioLink — Lambda handler for `POST /v1/admin/businesses/{id}/reject`.
//
// Authenticated, ADMIN-only. Transitions a `PENDING_REVIEW` business
// to `REJECTED` and records one `REJECT_BUSINESS` row in
// `admin_actions`. The optional `notes` body field is the canonical
// place to record the rejection reason — the dashboard renders the
// most-recent REJECT_BUSINESS row's `notes` alongside the business
// to explain why it was rejected (per the Phase 5 scoping decision:
// no dedicated `business_profiles.rejection_reason` column).
//
// Service-error mapping:
//   * AdminForbiddenError                    → 403 FORBIDDEN
//   * AdminBusinessNotFoundError             → 404 NOT_FOUND
//   * AdminBusinessInvalidTransitionError    → 409 CONFLICT

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

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.businesses.reject',
    });

    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('Business id must be a UUID.', { field: 'id' });
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
            const updated = await adminBusinessService.rejectBusiness(
                id,
                authz.caller,
                notes,
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
        logger.error('admin.businesses.reject.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
