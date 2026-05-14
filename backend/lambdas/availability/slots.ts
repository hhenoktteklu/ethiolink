// EthioLink — Lambda handler for
// `GET /v1/businesses/{businessId}/staff/{staffId}/slots`.
//
// Public endpoint (no auth). Computes the bookable slots for the staff
// member over the requested date range for the requested service.
// Each slot is returned as a UTC ISO pair `{ startUtc, endUtc }`.
//
// Query parameters:
//   * serviceId — required UUID
//   * from      — required YYYY-MM-DD (inclusive)
//   * to        — required YYYY-MM-DD (inclusive)
//
// Appointment-conflict lookups go through `PgAppointmentsRepository`
// against the `appointments` table created in migration 0009. Slots
// that overlap an ACCEPTED, not-soft-deleted booking on the same
// staff member are filtered out by `SlotService`.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { loadConfig } from '../../shared/config/loadConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgAppointmentsRepository } from '../../shared/domains/appointments/appointmentsRepository.js';
import { PgAvailabilityRepository } from '../../shared/domains/availability/availabilityRepository.js';
import {
    SlotInvalidRangeError,
    SlotInvalidTimezoneError,
    SlotServiceNotFoundError,
    SlotService,
    SlotServiceStaffMismatchError,
    SlotStaffNotFoundError,
} from '../../shared/domains/availability/slotService.js';
import { PgServiceRepository } from '../../shared/domains/services/serviceRepository.js';
import { PgStaffRepository } from '../../shared/domains/staff/staffRepository.js';
import {
    internalError,
    notFound,
    ok,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import { UUID_RE, ValidationFailure, parseDate } from './_validators.js';

const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const pool = getPool(config);
const slotService = new SlotService(
    new PgAvailabilityRepository(pool),
    new PgStaffRepository(pool),
    new PgServiceRepository(pool),
    new PgAppointmentsRepository(pool),
    {
        slotStepMinutes: config.booking.slotStepMinutes,
        bufferMinutes: config.booking.bufferMinutes,
        timezone: config.booking.defaultTimezone,
    },
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'availability.slots',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('businessId must be a UUID.', { field: 'businessId' });
    }
    const staffId = event.pathParameters?.staffId?.trim();
    if (!staffId || !UUID_RE.test(staffId)) {
        return validationError('staffId must be a UUID.', { field: 'staffId' });
    }

    let parsed: { serviceId: string; fromDate: string; toDate: string };
    try {
        parsed = parseQuery(event);
    } catch (err) {
        if (err instanceof ValidationFailure) {
            return validationError(err.message, err.details);
        }
        throw err;
    }

    try {
        const slots = await slotService.computeSlots({
            staffId,
            serviceId: parsed.serviceId,
            fromDate: parsed.fromDate,
            toDate: parsed.toDate,
        });
        return ok({ items: slots });
    } catch (err) {
        if (err instanceof SlotStaffNotFoundError) {
            return notFound('Staff member not found.');
        }
        if (err instanceof SlotServiceNotFoundError) {
            return notFound('Service not found.');
        }
        if (err instanceof SlotServiceStaffMismatchError) {
            return validationError(err.message, {
                field: 'serviceId',
            });
        }
        if (err instanceof SlotInvalidRangeError) {
            return validationError(err.message, { field: 'from' });
        }
        if (err instanceof SlotInvalidTimezoneError) {
            logger.error('availability.slots.timezone', { error: err.message });
            return internalError();
        }
        logger.error('availability.slots.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseQuery(event: APIGatewayProxyEvent): {
    serviceId: string;
    fromDate: string;
    toDate: string;
} {
    const qs = event.queryStringParameters ?? {};
    const serviceIdRaw = (qs.serviceId ?? '').trim();
    if (!serviceIdRaw || !UUID_RE.test(serviceIdRaw)) {
        throw new ValidationFailure('serviceId is required and must be a UUID.', {
            field: 'serviceId',
        });
    }
    const fromDate = parseDate((qs.from ?? '').trim(), 'from');
    const toDate = parseDate((qs.to ?? '').trim(), 'to');
    return { serviceId: serviceIdRaw, fromDate, toDate };
}
