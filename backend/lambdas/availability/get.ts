// EthioLink — Lambda handler for `GET /v1/businesses/{businessId}/staff/{staffId}/availability`.
//
// Public endpoint (no auth). Returns `{ weekly: [...], overrides: [...] }`
// — two flat arrays of `AvailabilityWindowView`. Returns 404 if the
// staff member does not exist or has been deactivated.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgAvailabilityRepository } from '../../shared/domains/availability/availabilityRepository.js';
import {
    AvailabilityService,
    AvailabilityStaffNotFoundError,
} from '../../shared/domains/availability/availabilityService.js';
import { toAvailabilityScheduleView } from '../../shared/domains/availability/availabilityView.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgStaffRepository } from '../../shared/domains/staff/staffRepository.js';
import {
    internalError,
    notFound,
    ok,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import { UUID_RE } from './_validators.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const pool = getPool(config);
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
        handler: 'availability.get',
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
        const schedule = await availabilityService.getScheduleForStaff(staffId);
        return ok(toAvailabilityScheduleView(schedule));
    } catch (err) {
        if (err instanceof AvailabilityStaffNotFoundError) {
            return notFound('Staff member not found.');
        }
        logger.error('availability.get.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
