// EthioLink — Lambda handler for `PATCH /v1/businesses/{businessId}/staff/{id}`.
//
// Authenticated, BUSINESS_OWNER-only. Edits a staff member's mutable
// fields. Ownership is enforced inside `staffService.update` — the
// service resolves the parent business via the row's `business_id`
// and compares against the caller. The path's `businessId` parameter
// is informational; the lookup is the source of truth.
//
// Patch semantics:
//   * Each field optional. Absent = no change.
//   * `displayName` is NOT NULL in the DB and cannot be cleared
//     (`parseRequiredString` rejects `null`).
//   * `role` accepts `null` to clear.
//   * Unknown fields tolerated.
//
// Service errors → HTTP:
//   * StaffNotFoundError  → 404
//   * StaffNotOwnedError  → 403

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
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgStaffRepository } from '../../shared/domains/staff/staffRepository.js';
import {
    StaffNotFoundError,
    StaffNotOwnedError,
    StaffService,
    type UpdateStaffInput,
} from '../../shared/domains/staff/staffService.js';
import { toStaffView } from '../../shared/domains/staff/staffView.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    forbidden,
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import {
    FieldLimits,
    UUID_RE,
    ValidationFailure,
    parseJsonObjectBody,
    parseRequiredString,
    parseStringOrNull,
} from './_validators.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const staffService = new StaffService(
    new PgStaffRepository(pool),
    new PgBusinessRepository(pool),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'staff.patch',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('businessId must be a UUID.', { field: 'businessId' });
    }
    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('id must be a UUID.', { field: 'id' });
    }

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'BUSINESS_OWNER') {
            return forbidden('Only BUSINESS_OWNER role can edit staff members.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let patch: UpdateStaffInput;
        try {
            patch = parsePatchBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            const staff = await staffService.update(
                id,
                { userId: user.id, role: principal.role },
                patch,
            );
            return ok(toStaffView(staff));
        } catch (err) {
            if (err instanceof StaffNotFoundError) {
                return notFound('Staff member not found.');
            }
            if (err instanceof StaffNotOwnedError) {
                return forbidden(err.message);
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
        logger.error('staff.patch.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parsePatchBody(rawBody: string | null): UpdateStaffInput {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: true });
    const patch: { -readonly [K in keyof UpdateStaffInput]: UpdateStaffInput[K] } = {};

    if ('displayName' in obj) {
        patch.displayName = parseRequiredString(
            obj.displayName,
            'displayName',
            FieldLimits.DISPLAY_NAME_MAX,
        );
    }
    if ('role' in obj) {
        patch.role = parseStringOrNull(obj.role, 'role', FieldLimits.ROLE_MAX);
    }

    return patch;
}
