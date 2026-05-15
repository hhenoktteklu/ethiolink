// EthioLink — Lambda handler for `GET /v1/me/appointments`.
//
// Authenticated. Returns appointments where the caller is the
// customer. BUSINESS_OWNER and ADMIN callers see only their own
// customer-side bookings (typically empty); the business-side
// listing lives at `GET /v1/businesses/:businessId/appointments`.
//
// Query parameters (all optional):
//   * status — one of REQUESTED / ACCEPTED / REJECTED / CANCELLED /
//              COMPLETED / NO_SHOW.
//   * from   — inclusive lower bound on `startsAt` (ISO-8601).
//   * to     — exclusive upper bound on `startsAt` (ISO-8601).
//
// Listing order matches `PgAppointmentsRepository`:
// `starts_at DESC, id DESC`. No cursor pagination in MVP — a single
// customer's appointment count is small.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { CashGateway } from '../../shared/adapters/payments/CashGateway.js';
import { MockOnlineGateway } from '../../shared/adapters/payments/MockOnlineGateway.js';
import { MockNotificationGateway } from '../../shared/adapters/notifications/MockNotificationGateway.js';
import { loadConfig } from '../../shared/config/loadConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgAppointmentsRepository } from '../../shared/domains/appointments/appointmentsRepository.js';
import { AppointmentService } from '../../shared/domains/appointments/appointmentService.js';
import { toAppointmentView } from '../../shared/domains/appointments/appointmentView.js';
import { PgNotificationLogRepository } from '../../shared/domains/notifications/notificationLogRepository.js';
import { NotificationService } from '../../shared/domains/notifications/notificationService.js';
import { PgAvailabilityRepository } from '../../shared/domains/availability/availabilityRepository.js';
import { SlotService } from '../../shared/domains/availability/slotService.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgServiceRepository } from '../../shared/domains/services/serviceRepository.js';
import { PgStaffRepository } from '../../shared/domains/staff/staffRepository.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import {
    ValidationFailure,
    parseAppointmentStatusOptional,
    parseIsoDatetimeOptional,
} from './_validators.js';

const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const notificationService = new NotificationService({
    userRepository: new PgUserRepository(pool),
    notificationLogRepository: new PgNotificationLogRepository(pool),
    gateways: { MOCK: new MockNotificationGateway() },
    logger: baseLogger,
});
const appointmentService = new AppointmentService({
    appointmentsRepo: new PgAppointmentsRepository(pool),
    businessRepo: new PgBusinessRepository(pool),
    serviceRepo: new PgServiceRepository(pool),
    userRepo: new PgUserRepository(pool),
    slotService: new SlotService(
        new PgAvailabilityRepository(pool),
        new PgStaffRepository(pool),
        new PgServiceRepository(pool),
        new PgAppointmentsRepository(pool),
        {
            slotStepMinutes: config.booking.slotStepMinutes,
            bufferMinutes: config.booking.bufferMinutes,
            timezone: config.booking.defaultTimezone,
        },
    ),
    cashGateway: new CashGateway(),
    onlineGateway: new MockOnlineGateway(),
    notificationService,
    logger: baseLogger,
    options: {
        cancelCutoffMinutes: config.booking.cancelCutoffMinutes,
        timezone: config.booking.defaultTimezone,
    },
});

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'appointments.listMine',
    });

    try {
        const principal = await extractPrincipal(event, authProvider);

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let filters: {
            status?: ReturnType<typeof parseAppointmentStatusOptional>;
            fromUtc?: Date;
            toUtc?: Date;
        };
        try {
            filters = parseFilters(event);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        const items = await appointmentService.listForCustomer(user.id, filters);
        return ok({ items: items.map(toAppointmentView) });
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
        logger.error('appointments.listMine.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseFilters(event: APIGatewayProxyEvent): {
    status?: ReturnType<typeof parseAppointmentStatusOptional>;
    fromUtc?: Date;
    toUtc?: Date;
} {
    const qs = event.queryStringParameters ?? {};
    return {
        status: parseAppointmentStatusOptional(qs.status),
        fromUtc: parseIsoDatetimeOptional(qs.from, 'from'),
        toUtc: parseIsoDatetimeOptional(qs.to, 'to'),
    };
}
