// EthioLink — Lambda handler for `POST /v1/appointments/{id}/accept`.
//
// Authenticated. Business owner (or ADMIN) flips the appointment from
// REQUESTED to ACCEPTED. Ownership / admin override is enforced by
// `AppointmentService.accept` via the same `assertBusinessOwnerOrAdmin`
// helper used by `listForBusiness`.
//
// No request body.
//
// Service-error mapping:
//   * AppointmentNotFoundError              → 404 NOT_FOUND
//   * AppointmentNotOwnedError              → 403 FORBIDDEN
//   * InvalidAppointmentTransitionError     → 409 CONFLICT

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
    AppointmentNotFoundError,
    AppointmentNotOwnedError,
    AppointmentService,
    InvalidAppointmentTransitionError,
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
    conflict,
    forbidden,
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import { UUID_RE } from './_validators.js';

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
        handler: 'appointments.accept',
    });

    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('Appointment id must be a UUID.', { field: 'id' });
    }

    try {
        const principal = await extractPrincipal(event, authProvider);

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        try {
            const appointment = await appointmentService.accept(id, {
                userId: user.id,
                role: principal.role,
            });
            return ok(toAppointmentView(appointment));
        } catch (err) {
            if (err instanceof AppointmentNotFoundError) {
                return notFound('Appointment not found.');
            }
            if (err instanceof AppointmentNotOwnedError) {
                return forbidden(err.message);
            }
            if (err instanceof InvalidAppointmentTransitionError) {
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
        logger.error('appointments.accept.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
