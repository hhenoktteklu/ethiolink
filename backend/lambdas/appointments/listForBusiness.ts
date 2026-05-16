// EthioLink — Lambda handler for
// `GET /v1/businesses/{businessId}/appointments`.
//
// Authenticated. Caller must own the business OR be ADMIN — the
// ownership / admin override is enforced by
// `AppointmentService.listForBusiness`. The handler just passes the
// `CallerContext` through and maps the typed error to 403.
//
// Query parameters (all optional):
//   * status — one of REQUESTED / ACCEPTED / REJECTED / CANCELLED /
//              COMPLETED / NO_SHOW.
//   * from   — inclusive lower bound on `startsAt` (ISO-8601).
//   * to     — exclusive upper bound on `startsAt` (ISO-8601).
//
// Listing order matches `PgAppointmentsRepository`:
// `starts_at DESC, id DESC`. No cursor pagination in MVP.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { createPaymentGateways } from '../../shared/factories/paymentGatewayFactory.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgAppointmentsRepository } from '../../shared/domains/appointments/appointmentsRepository.js';
import {
    AppointmentNotOwnedError,
    AppointmentService,
} from '../../shared/domains/appointments/appointmentService.js';
import { toAppointmentView } from '../../shared/domains/appointments/appointmentView.js';
import {
    createNotificationService,
    shouldWireSmsGateway,
    shouldWireTelegramGateway,
} from '../../shared/domains/notifications/notificationServiceFactory.js';
import { PgAvailabilityRepository } from '../../shared/domains/availability/availabilityRepository.js';
import { SlotService } from '../../shared/domains/availability/slotService.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgServiceRepository } from '../../shared/domains/services/serviceRepository.js';
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
    parseAppointmentStatusOptional,
    parseIsoDatetimeOptional,
} from './_validators.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const notificationService = createNotificationService({
    pool,
    config,
    logger: baseLogger,
});
// Phase 10 — factory builds CashGateway + (MockOnlineGateway by
// default; ChapaGateway when payments_provider=chapa is wired).
const paymentGateways = createPaymentGateways(config);
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
    cashGateway: paymentGateways.cash,
    onlineGateway: paymentGateways.online,
    notificationService,
    logger: baseLogger,
    options: {
        cancelCutoffMinutes: config.booking.cancelCutoffMinutes,
        timezone: config.booking.defaultTimezone,
        smsRoutingEnabled: shouldWireSmsGateway(config),
        telegramRoutingEnabled: shouldWireTelegramGateway(config),
    },
});

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'appointments.listForBusiness',
    });

    try {
        const principal = await extractPrincipal(event, authProvider);

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        const businessId = event.pathParameters?.businessId?.trim();
        if (!businessId || !UUID_RE.test(businessId)) {
            return validationError('businessId must be a UUID.', {
                field: 'businessId',
            });
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

        try {
            const items = await appointmentService.listForBusiness(
                businessId,
                { userId: user.id, role: principal.role },
                filters,
            );
            return ok({ items: items.map(toAppointmentView) });
        } catch (err) {
            if (err instanceof AppointmentNotOwnedError) {
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
        logger.error('appointments.listForBusiness.failed', {
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
