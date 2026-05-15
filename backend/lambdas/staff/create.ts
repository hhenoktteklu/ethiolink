// EthioLink — Lambda handler for `POST /v1/businesses/{businessId}/staff`.
//
// Authenticated, BUSINESS_OWNER-only (Phase 3 scope; admin write paths
// land in Phase 5). Creates a new active staff member for the business
// at `businessId`. The caller must own that business — ownership is
// enforced inside `staffService.create`.
//
// Service errors → HTTP:
//   * StaffBusinessNotFoundError → 404
//   * StaffNotOwnedError         → 403

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
    StaffBusinessNotFoundError,
    StaffNotOwnedError,
    StaffService,
    type CreateStaffInput,
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
        handler: 'staff.create',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('businessId must be a UUID.', { field: 'businessId' });
    }

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'BUSINESS_OWNER') {
            return forbidden('Only BUSINESS_OWNER role can create staff members.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let input: CreateStaffInput;
        try {
            input = parseCreateBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            const staff = await staffService.create(
                { userId: user.id, role: principal.role },
                businessId,
                input,
            );
            return ok(toStaffView(staff));
        } catch (err) {
            if (err instanceof StaffBusinessNotFoundError) {
                return notFound(err.message);
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
        logger.error('staff.create.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseCreateBody(rawBody: string | null): CreateStaffInput {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });
    return {
        displayName: parseRequiredString(
            obj.displayName,
            'displayName',
            FieldLimits.DISPLAY_NAME_MAX,
        ),
        role: parseStringOrNull(obj.role, 'role', FieldLimits.ROLE_MAX),
    };
}
