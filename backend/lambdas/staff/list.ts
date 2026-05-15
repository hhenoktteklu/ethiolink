// EthioLink — Lambda handler for `GET /v1/businesses/{businessId}/staff`.
//
// Public endpoint (no auth). Returns the business's active staff
// members in the order the owner added them (`created_at ASC, id ASC`).
// Wrapped in `{ items, nextCursor: null }` for envelope symmetry —
// staff rosters per business are small and Phase 3 ships without
// pagination on this listing.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgStaffRepository } from '../../shared/domains/staff/staffRepository.js';
import { StaffService } from '../../shared/domains/staff/staffService.js';
import { toStaffView } from '../../shared/domains/staff/staffView.js';
import {
    internalError,
    ok,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import { UUID_RE } from './_validators.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const pool = getPool(config);
const staffService = new StaffService(
    new PgStaffRepository(pool),
    new PgBusinessRepository(pool),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'staff.list',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('businessId must be a UUID.', { field: 'businessId' });
    }

    try {
        const staff = await staffService.listActiveForBusiness(businessId);
        return ok({
            items: staff.map(toStaffView),
            nextCursor: null,
        });
    } catch (err) {
        logger.error('staff.list.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
