// EthioLink — Lambda handler for `PATCH /v1/me`.
//
// Phase 1 scope:
//   * `displayName` — mutable here.
//   * `preferredCity` — deferred. Lives on `customer_profiles`, which is
//     not yet created (no Phase 1 migration for it). When that table
//     lands, add a customer-profile patch path here.
//
// Body shape (all fields optional; an empty `{}` is a valid no-op):
//
//     { "displayName": string | null }
//
// `null` clears the field; a string sets it. Strings are trimmed and
// length-bounded; whitespace-only strings are rejected.

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
import {
    type UpdateUserFields,
    PgUserRepository,
} from '../../shared/domains/users/userRepository.js';
import {
    UserNotFoundError,
    UserService,
} from '../../shared/domains/users/userService.js';
import { toUserView } from '../../shared/domains/users/userView.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

const DISPLAY_NAME_MAX = 100;

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const userRepository = new PgUserRepository(getPool(config));

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'me.patch',
    });

    try {
        const principal = await extractPrincipal(event, authProvider);
        const userService = new UserService(userRepository, logger);

        // Self-lookup. PATCH /me operates on the caller's own row.
        const me = await userService.getByCognitoSub(principal.sub);
        if (!me) {
            return notFound('User profile not found. Call POST /v1/auth/sync first.');
        }

        let patch: UpdateUserFields;
        try {
            patch = parsePatchBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        const updated = await userService.update(me.id, patch);
        return ok(toUserView(updated));
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
        if (err instanceof UserNotFoundError) {
            return notFound('User profile not found.');
        }
        logger.error('me.patch.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

// ---------------------------------------------------------------------------
// Body validation
//
// Hand-written rather than zod-based: only one optional field, no nested
// structures. Promote to zod when the validation surface grows (Phase 2+).
// Unknown fields are ignored, not rejected, to keep clients forward-compatible
// during minor backend changes.
// ---------------------------------------------------------------------------

class ValidationFailure extends Error {
    public readonly details?: Record<string, unknown>;
    constructor(message: string, details?: Record<string, unknown>) {
        super(message);
        this.name = 'ValidationFailure';
        this.details = details;
    }
}

function parsePatchBody(rawBody: string | null): UpdateUserFields {
    if (rawBody === null || rawBody.trim() === '') {
        return {};
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBody);
    } catch {
        throw new ValidationFailure('Body must be valid JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ValidationFailure('Body must be a JSON object.');
    }

    const obj = parsed as Record<string, unknown>;
    const out: { displayName?: string | null } = {};

    if ('displayName' in obj) {
        out.displayName = parseDisplayName(obj.displayName);
    }

    return out;
}

function parseDisplayName(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string') {
        throw new ValidationFailure('displayName must be a string or null.', {
            field: 'displayName',
        });
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new ValidationFailure('displayName must not be empty.', {
            field: 'displayName',
        });
    }
    if (trimmed.length > DISPLAY_NAME_MAX) {
        throw new ValidationFailure(
            `displayName must be ${DISPLAY_NAME_MAX} characters or fewer.`,
            { field: 'displayName', max: DISPLAY_NAME_MAX },
        );
    }
    return trimmed;
}
