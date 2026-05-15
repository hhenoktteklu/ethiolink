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
import { CashGateway } from '../../shared/adapters/payments/CashGateway.js';
import { MockOnlineGateway } from '../../shared/adapters/payments/MockOnlineGateway.js';
import { loadConfig } from '../../shared/config/loadConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgAppointmentsRepository } from '../../shared/domains/appointments/appointmentsRepository.js';
import {
    AppointmentNotFoundError,
    AppointmentNotOwnedError,
    AppointmentService,
    InvalidAppointmentTransitionError,
} from '../../shared/domains/appointments/appointmentService.js';
import { toAppointmentView } from '../../shared/domains/appointments/appointmentView.js';
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

const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const appointmentService = new AppointmentService({
    appointmentsRepo: new PgAppointmentsRepository(pool),
    businessRepo: new PgBusinessRepository(pool),
    serviceRepo: new PgServiceRepository(pool),
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
