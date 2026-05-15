// EthioLink — Lambda handler for
// `PUT /v1/businesses/{businessId}/staff/{staffId}/availability`.
//
// Authenticated, BUSINESS_OWNER-only. Replaces the staff member's
// entire weekly schedule atomically. Strict input: the request must
// include all seven weekdays (0–6), even if a day has no windows.
//
// Body shape:
//
//   {
//     "days": [
//       { "weekday": 0, "windows": [] },
//       { "weekday": 1, "windows": [
//           { "startTime": "09:00",    "endTime": "12:00"    },
//           { "startTime": "13:00:00", "endTime": "17:00:00" }
//       ]},
//       ... (one entry per weekday 0..6)
//     ]
//   }
//
// `startTime` and `endTime` accept `HH:MM` or `HH:MM:SS`; the handler
// normalizes to `HH:MM:SS` before calling the service.
//
// Returns the full grouped schedule (`{ weekly, overrides }`) — same
// shape as GET — so clients can refresh their UI without a follow-up
// read. OVERRIDE rows are not touched by replace; they appear in the
// response if any exist for this staff member.
//
// Service errors → HTTP:
//   * AvailabilityStaffNotFoundError  → 404
//   * AvailabilityNotOwnedError       → 403
//   * AvailabilityInvalidWeeklyError  → 400 with the service's details payload

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
    AvailabilityInvalidWeeklyError,
    AvailabilityNotOwnedError,
    AvailabilityService,
    AvailabilityStaffNotFoundError,
    type ReplaceWeeklyInput,
    type WeeklyDaySchedule,
} from '../../shared/domains/availability/availabilityService.js';
import { toAvailabilityScheduleView } from '../../shared/domains/availability/availabilityView.js';
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
    parseJsonObjectBody,
    parseTime,
    parseWeekday,
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
        handler: 'availability.replace',
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
            return forbidden('Only BUSINESS_OWNER role can edit availability.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let input: ReplaceWeeklyInput;
        try {
            input = parseReplaceBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            await availabilityService.replaceWeekly(
                { userId: user.id, role: principal.role },
                staffId,
                input,
            );
            // Return full schedule (weekly + overrides) so clients can
            // refresh in one round-trip.
            const schedule = await availabilityService.getScheduleForStaff(staffId);
            return ok(toAvailabilityScheduleView(schedule));
        } catch (err) {
            if (err instanceof AvailabilityStaffNotFoundError) {
                return notFound('Staff member not found.');
            }
            if (err instanceof AvailabilityNotOwnedError) {
                return forbidden(err.message);
            }
            if (err instanceof AvailabilityInvalidWeeklyError) {
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
        logger.error('availability.replace.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseReplaceBody(rawBody: string | null): ReplaceWeeklyInput {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });
    const rawDays = obj.days;
    if (!Array.isArray(rawDays)) {
        throw new ValidationFailure('days must be an array.', { field: 'days' });
    }

    const days: WeeklyDaySchedule[] = [];
    for (let i = 0; i < rawDays.length; i++) {
        const rawDay = rawDays[i];
        if (typeof rawDay !== 'object' || rawDay === null || Array.isArray(rawDay)) {
            throw new ValidationFailure(`days[${i}] must be an object.`, {
                field: `days[${i}]`,
            });
        }
        const day = rawDay as Record<string, unknown>;
        const weekday = parseWeekday(day.weekday, `days[${i}].weekday`);

        const rawWindows = day.windows;
        if (!Array.isArray(rawWindows)) {
            throw new ValidationFailure(
                `days[${i}].windows must be an array.`,
                { field: `days[${i}].windows` },
            );
        }
        const windows: WeeklyDaySchedule['windows'] = [];
        for (let j = 0; j < rawWindows.length; j++) {
            const rawWindow = rawWindows[j];
            if (
                typeof rawWindow !== 'object' ||
                rawWindow === null ||
                Array.isArray(rawWindow)
            ) {
                throw new ValidationFailure(
                    `days[${i}].windows[${j}] must be an object.`,
                    { field: `days[${i}].windows[${j}]` },
                );
            }
            const w = rawWindow as Record<string, unknown>;
            windows.push({
                startTime: parseTime(w.startTime, `days[${i}].windows[${j}].startTime`),
                endTime: parseTime(w.endTime, `days[${i}].windows[${j}].endTime`),
            });
        }

        days.push({ weekday, windows });
    }

    return { days };
}
