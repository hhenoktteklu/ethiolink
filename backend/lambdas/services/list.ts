// EthioLink — Lambda handler for `GET /v1/businesses/{businessId}/services`.
//
// Public endpoint (no auth). Returns the business's active services in
// the order the owner added them (`created_at ASC, id ASC`). Wrapped
// in the listing envelope `{ items, nextCursor: null }` for symmetry
// with other listing endpoints — service catalogs per business are
// small enough that Phase 3 ships without pagination, but clients can
// treat every listing with one code path.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgServiceRepository } from '../../shared/domains/services/serviceRepository.js';
import { ServiceService } from '../../shared/domains/services/serviceService.js';
import { toServiceView } from '../../shared/domains/services/serviceView.js';
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
const serviceService = new ServiceService(
    new PgServiceRepository(pool),
    new PgBusinessRepository(pool),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'services.list',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('businessId must be a UUID.', { field: 'businessId' });
    }

    try {
        const services = await serviceService.listActiveForBusiness(businessId);
        return ok({
            items: services.map(toServiceView),
            nextCursor: null,
        });
    } catch (err) {
        logger.error('services.list.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
