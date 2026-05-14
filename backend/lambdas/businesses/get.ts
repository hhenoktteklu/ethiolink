// EthioLink — Lambda handler for `GET /v1/businesses/{id}`.
//
// Public endpoint (no auth). Returns a single business detail, but
// only if its status is APPROVED — DRAFT / PENDING_REVIEW / REJECTED /
// SUSPENDED rows are invisible to anonymous callers.
//
// The path parameter is validated as a UUID format before hitting the
// database. A malformed id returns 400 VALIDATION_ERROR; a well-formed
// id that doesn't exist (or isn't APPROVED) returns 404 NOT_FOUND.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { loadConfig } from '../../shared/config/loadConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { BusinessService } from '../../shared/domains/businesses/businessService.js';
import { toBusinessPublicView } from '../../shared/domains/businesses/businessView.js';
import {
    internalError,
    notFound,
    ok,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const businessService = new BusinessService(new PgBusinessRepository(getPool(config)));

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'businesses.get',
    });

    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('Business id must be a UUID.', { field: 'id' });
    }

    try {
        const business = await businessService.findApproved(id);
        if (!business) {
            return notFound('Business not found.');
        }
        return ok(toBusinessPublicView(business));
    } catch (err) {
        logger.error('businesses.get.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
