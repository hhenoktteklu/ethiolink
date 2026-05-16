// EthioLink — Lambda handler for `POST /v1/appointments`.
//
// Authenticated, CUSTOMER-only. Books a new appointment for the
// calling user.
//
// Body fields (all post-validation):
//   * staffId        — UUID, required.
//   * serviceId      — UUID, required.
//   * startsAt       — ISO-8601 datetime, required. Normalized to UTC
//                      by the service.
//   * paymentMethod  — 'CASH' or 'ONLINE_PENDING', required.
//   * notes          — string, optional; trimmed, max 2000 chars.
//
// Auth path mirrors `businesses/create.ts`:
//   1. Extract Cognito principal; 401 on auth failures.
//   2. Refuse non-CUSTOMER callers with 403 (BUSINESS_OWNER / ADMIN
//      bookings are not modeled in MVP).
//   3. Resolve principal.sub to a `users` row; 404 with the
//      `POST /v1/auth/sync` hint if the user is unsynced.
//
// Service-error mapping:
//   * SlotStaffNotFoundError / SlotServiceNotFoundError → 404
//   * SlotServiceStaffMismatchError → 400 (mismatched service+staff)
//   * AppointmentMissingServicePriceError → 400
//   * AppointmentSlotUnavailableError → 409 SLOT_UNAVAILABLE
//   * OnlinePaymentsUnavailableError → 400 ONLINE_PAYMENTS_UNAVAILABLE
//   * AppointmentInvalidStartTimeError → 400 (defensive; the
//     handler-side `parseStartsAt` should catch this first)
//   * AppointmentNotOwnedError → not produced by `create` itself.

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
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgAppointmentsRepository } from '../../shared/domains/appointments/appointmentsRepository.js';
import {
    AppointmentInvalidStartTimeError,
    AppointmentMissingServicePriceError,
    AppointmentService,
    AppointmentSlotUnavailableError,
    OnlinePaymentsUnavailableError,
    SlotServiceNotFoundError,
    SlotServiceStaffMismatchError,
    SlotStaffNotFoundError,
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
    errorResponse,
    forbidden,
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import {
    ValidationFailure,
    parseJsonObjectBody,
    parseNotesOrNull,
    parsePaymentMethod,
    parseRequiredUuid,
    parseStartsAt,
} from './_validators.js';

// Cold-start init. Shared with `listMine` / `listForBusiness` only
// through the service interface — each handler builds its own
// instances (matches Phase 2 / 3 convention).
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
        smsRoutingEnabled: shouldWireSmsGateway(config),
        telegramRoutingEnabled: shouldWireTelegramGateway(config),
    },
});

interface CreateBody {
    readonly staffId: string;
    readonly serviceId: string;
    readonly startsAt: string;
    readonly paymentMethod: 'CASH' | 'ONLINE_PENDING';
    readonly notes: string | null;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'appointments.create',
    });

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'CUSTOMER') {
            return forbidden('Only CUSTOMER role can create appointments.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let body: CreateBody;
        try {
            body = parseCreateBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            const result = await appointmentService.create({
                customerId: user.id,
                staffId: body.staffId,
                serviceId: body.serviceId,
                startsAtUtc: body.startsAt,
                paymentMethod: body.paymentMethod,
                notes: body.notes,
            });
            return ok(toAppointmentView(result.appointment));
        } catch (err) {
            if (err instanceof SlotStaffNotFoundError) {
                return notFound('Staff member not found.');
            }
            if (err instanceof SlotServiceNotFoundError) {
                return notFound('Service not found.');
            }
            if (err instanceof SlotServiceStaffMismatchError) {
                return validationError(err.message, { field: 'serviceId' });
            }
            if (err instanceof AppointmentMissingServicePriceError) {
                return validationError(err.message, { field: 'serviceId' });
            }
            if (err instanceof AppointmentSlotUnavailableError) {
                return errorResponse(409, 'SLOT_UNAVAILABLE', err.message);
            }
            if (err instanceof OnlinePaymentsUnavailableError) {
                return validationError(err.message, {
                    code: err.code,
                    field: 'paymentMethod',
                });
            }
            if (err instanceof AppointmentInvalidStartTimeError) {
                return validationError(err.message, { field: 'startsAt' });
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
        logger.error('appointments.create.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseCreateBody(rawBody: string | null): CreateBody {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });
    return {
        staffId: parseRequiredUuid(obj.staffId, 'staffId'),
        serviceId: parseRequiredUuid(obj.serviceId, 'serviceId'),
        startsAt: parseStartsAt(obj.startsAt),
        paymentMethod: parsePaymentMethod(obj.paymentMethod),
        notes: parseNotesOrNull(obj.notes),
    };
}
