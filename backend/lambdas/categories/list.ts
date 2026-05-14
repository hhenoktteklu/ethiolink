// EthioLink — Lambda handler for `GET /v1/categories`.
//
// Public endpoint. Returns the active business categories sorted by
// (sort_order ASC, name->'en' ASC), wrapped in the listing envelope:
//
//     { "items": [...], "nextCursor": null }
//
// The category set is small (currently four) and not paginated, but the
// response shape includes `nextCursor: null` for symmetry with other
// listing endpoints in this API. Clients can handle every listing
// (categories now, businesses next) with the same code path.
//
// No authentication: this handler does NOT call `extractPrincipal`.
// Anonymous callers, mobile and web alike, can list categories without
// signing in. Other public endpoints in Phase 2 will follow the same
// pattern (no optional-auth helper yet).

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { loadConfig } from '../../shared/config/loadConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgCategoryRepository } from '../../shared/domains/categories/categoryRepository.js';
import { CategoryService } from '../../shared/domains/categories/categoryService.js';
import { toCategoryView } from '../../shared/domains/categories/categoryView.js';
import { internalError, ok } from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

// Cold-start initialization. CategoryService is stateless beyond its
// pool reference, so it is safe to construct once at module load and
// reuse across warm invocations.
const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const categoryService = new CategoryService(
    new PgCategoryRepository(getPool(config)),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'categories.list',
    });

    try {
        const categories = await categoryService.listActive();
        return ok({
            items: categories.map(toCategoryView),
            nextCursor: null,
        });
    } catch (err) {
        logger.error('categories.list.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
