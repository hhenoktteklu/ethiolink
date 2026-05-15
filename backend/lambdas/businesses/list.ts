// EthioLink — Lambda handler for `GET /v1/businesses`.
//
// Public endpoint (no auth). Lists APPROVED businesses with optional
// filters, in the order owned by `businessRepository.listPublic`:
// featured first, then by rating, then by recency. Cursor pagination
// uses the opaque `base64url(JSON.stringify({ id, sortKey }))` format
// defined by `businessService`.
//
// Query parameters:
//   * category  — slug (e.g. "salon"); resolved to category_id via
//                 CategoryService.getBySlug. Slug must be active or
//                 the request is rejected with VALIDATION_ERROR.
//   * city      — case-insensitive exact match
//   * query     — partial match on `name` (ILIKE %...%)
//   * ratingMin — number 0..5
//   * cursor    — opaque page token from a previous response
//   * limit     — integer 1..100, default 20
//
// All filters are optional. Empty / whitespace-only query strings are
// treated as "no filter" — the user-facing UI often emits `?city=` as
// a result of an empty input.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import {
    BusinessService,
    InvalidCursorError,
} from '../../shared/domains/businesses/businessService.js';
import { toBusinessPublicView } from '../../shared/domains/businesses/businessView.js';
import { PgCategoryRepository } from '../../shared/domains/categories/categoryRepository.js';
import { CategoryService } from '../../shared/domains/categories/categoryService.js';
import {
    internalError,
    ok,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

// Cold-start init. Services are stateless beyond their pool reference.
const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const pool = getPool(config);
const businessService = new BusinessService(new PgBusinessRepository(pool));
const categoryService = new CategoryService(new PgCategoryRepository(pool));

const MAX_LIMIT = 100;
const RATING_MIN = 0;
const RATING_MAX = 5;

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'businesses.list',
    });

    try {
        // 1. Parse + validate non-category query params first (cheap, no DB).
        const params = parseQuery(event);

        // 2. Resolve the category slug, if any, to a category_id. This is the
        //    only step that requires a database lookup before the main query.
        let categoryId: string | undefined;
        if (params.categorySlug !== undefined) {
            const category = await categoryService.getBySlug(params.categorySlug);
            if (!category || !category.isActive) {
                return validationError('Unknown or inactive category.', {
                    field: 'category',
                    value: params.categorySlug,
                });
            }
            categoryId = category.id;
        }

        // 3. Run the listing.
        const page = await businessService.listPublic(
            {
                categoryId,
                city: params.city,
                query: params.query,
                ratingMin: params.ratingMin,
            },
            params.cursor,
            params.limit,
        );

        return ok({
            items: page.items.map(toBusinessPublicView),
            nextCursor: page.nextCursor,
        });
    } catch (err) {
        if (err instanceof InvalidCursorError) {
            return validationError('Malformed cursor.', { field: 'cursor' });
        }
        if (err instanceof QueryValidationError) {
            return validationError(err.message, err.details);
        }
        logger.error('businesses.list.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

// ---------------------------------------------------------------------------
// Query-string parsing
// ---------------------------------------------------------------------------

interface ParsedQuery {
    readonly categorySlug?: string;
    readonly city?: string;
    readonly query?: string;
    readonly ratingMin?: number;
    readonly cursor?: string;
    readonly limit?: number;
}

class QueryValidationError extends Error {
    public readonly details: Record<string, unknown>;
    constructor(message: string, details: Record<string, unknown>) {
        super(message);
        this.name = 'QueryValidationError';
        this.details = details;
    }
}

function parseQuery(event: APIGatewayProxyEvent): ParsedQuery {
    const qs = event.queryStringParameters ?? {};

    const categorySlug = readString(qs.category);
    const city = readString(qs.city);
    const query = readString(qs.query);
    const cursor = readString(qs.cursor);

    let ratingMin: number | undefined;
    const ratingMinRaw = readString(qs.ratingMin);
    if (ratingMinRaw !== undefined) {
        const parsed = Number.parseFloat(ratingMinRaw);
        if (!Number.isFinite(parsed) || parsed < RATING_MIN || parsed > RATING_MAX) {
            throw new QueryValidationError(
                `ratingMin must be a number between ${RATING_MIN} and ${RATING_MAX}.`,
                { field: 'ratingMin', value: ratingMinRaw },
            );
        }
        ratingMin = parsed;
    }

    let limit: number | undefined;
    const limitRaw = readString(qs.limit);
    if (limitRaw !== undefined) {
        const parsed = Number.parseInt(limitRaw, 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
            throw new QueryValidationError(
                `limit must be an integer between 1 and ${MAX_LIMIT}.`,
                { field: 'limit', value: limitRaw },
            );
        }
        limit = parsed;
    }

    return { categorySlug, city, query, ratingMin, cursor, limit };
}

/** Trim a query-string value; return `undefined` for missing / empty / whitespace-only. */
function readString(raw: string | undefined): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
}
