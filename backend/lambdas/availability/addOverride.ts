// EthioLink — Lambda handler for
// `POST /v1/businesses/{businessId}/staff/{staffId}/availability/override`.
//
// Authenticated, BUSINESS_OWNER-only. Adds one OVERRIDE row to the
// staff member's availability — either a special open window or
// (with `isClosed: true`) a blackout that hides part of the weekly
// schedule on the given date.
//
// Body shape:
//
//   {
//     "specificDate": "2026-05-14",
//     "startTime":    "09:00",
//     "endTime":      "12:00:00",
//     "isClosed":     false
//   }
//
// `startTime` and `endTime` accept `HH:MM` or `HH:MM:SS`; the handler
// normalizes to `HH:MM:SS`. `isClosed` defaults to `false` when
// omitted. A closed override does NOT require a matching open window
// on the same date — the row stands alone.
//
// Returns the newly-created override as `AvailabilityWindowView`.
//
// Service errors → HTTP:
//   * AvailabilityStaffNotFoundError    → 404
//   * AvailabilityNotOwnedError         → 403
//   * AvailabilityInvalidOverrideError  → 400 with the service's details payload

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
import { PgAvailabilityRepository } from '../../shared/domains/availability/availabilityRepository.js';
import {
    type AddOverrideInput,
    AvailabilityInvalidOverrideError,
    AvailabilityNotOwnedError,
    AvailabilityService,
    AvailabilityStaffNotFoundError,
} from '../../shared/domains/availability/availabilityService.js';
import { toAvailabilityWindowView } from '../../shared/domains/availability/availabilityView.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgStaffRepository } from '../../shared/domains/staff/staffRepository.js';
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
    UUID_RE,
    ValidationFailure,
    parseDate,
    parseJsonObjectBody,
    parseOptionalBoolean,
    parseTime,
} from './_validators.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const availabilityService = new AvailabilityService(
    new PgAvailabilityRepository(pool),
    new PgStaffRepository(pool),
    new PgBusinessRepository(pool),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'availability.addOverride',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('businessId must be a UUID.', { field: 'businessId' });
    }
    const staffId = event.pathParameters?.staffId?.trim();
    if (!staffId || !UUID_RE.test(staffId)) {
        return validationError('staffId must be a UUID.', { field: 'staffId' });
    }

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'BUSINESS_OWNER') {
            return forbidden('Only BUSINESS_OWNER role can add availability overrides.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let input: AddOverrideInput;
        try {
            input = parseOverrideBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            const window = await availabilityService.addOverride(
                { userId: user.id, role: principal.role },
                staffId,
                input,
            );
            return ok(toAvailabilityWindowView(window));
        } catch (err) {
            if (err instanceof AvailabilityStaffNotFoundError) {
                return notFound('Staff member not found.');
            }
            if (err instanceof AvailabilityNotOwnedError) {
                return forbidden(err.message);
            }
            if (err instanceof AvailabilityInvalidOverrideError) {
                return validationError(err.message, err.details);
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
        logger.error('availability.addOverride.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseOverrideBody(rawBody: string | null): AddOverrideInput {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });
    return {
        specificDate: parseDate(obj.specificDate, 'specificDate'),
        startTime: parseTime(obj.startTime, 'startTime'),
        endTime: parseTime(obj.endTime, 'endTime'),
        isClosed: parseOptionalBoolean(obj.isClosed, 'isClosed') ?? false,
    };
}
