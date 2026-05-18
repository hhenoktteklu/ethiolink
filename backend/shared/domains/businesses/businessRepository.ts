// EthioLink — business repository.
//
// SQL access to the `business_profiles` table. The service layer
// (`businessService.ts`) owns the rules — ownership, status
// transitions, required-before-submit validation. The repository is
// dumb on purpose: it just persists what it's given.
//
// Public listing details:
//   * `listPublic` filters `status = 'APPROVED'` unconditionally; only
//     approved businesses are visible to anonymous callers.
//   * Sort order is `featured_until DESC NULLS LAST, rating_avg DESC,
//     created_at DESC, id DESC`. Featured businesses surface first,
//     then by rating, then by recency; `id` is the final tiebreaker
//     to keep cursor pagination stable across calls.
//   * `featured_until NULLS LAST` is achieved by `COALESCE(featured_until,
//     '-infinity'::timestamptz)` — that way row-value comparison in the
//     cursor predicate works the same for null and non-null values.
//   * Cursor predicate is a row-value comparison against
//     `(COALESCE(featured_until, '-infinity'), rating_avg, created_at,
//     id)`. The shape of `ParsedCursor` mirrors that tuple.
//   * The "is there a next page" decision is made by asking for `limit
//     + 1` rows; the service trims and emits a `nextCursor` accordingly.
//
// Column lists are spelled out (no `SELECT *`).

import type { LocalizedText } from '../categories/categoryRepository.js';
import { BaseRepository, RepositoryError } from '../../repositories/baseRepository.js';

export type BusinessStatus =
    | 'DRAFT'
    | 'PENDING_REVIEW'
    | 'APPROVED'
    | 'REJECTED'
    | 'SUSPENDED';

/** Domain shape of a `business_profiles` row. */
export interface Business {
    readonly id: string;
    readonly ownerUserId: string;
    readonly categoryId: string;
    readonly name: string | null;
    readonly description: LocalizedText | null;
    readonly city: string | null;
    readonly addressLine: string | null;
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly phone: string | null;
    readonly telegramHandle: string | null;
    readonly whatsappPhone: string | null;
    readonly status: BusinessStatus;
    readonly featuredUntil: Date | null;
    readonly ratingAvg: number;
    readonly ratingCount: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    /**
     * Phase 9 Track 6 — full-text rank for the matching row. Only
     * populated when `listPublic` was called with `sort: 'relevance'`
     * and a non-empty `query`. All other code paths leave this as
     * `null` (the field is non-optional in the type so consumers
     * don't have to discriminate `undefined` vs `null`). The wire
     * shape `BusinessPublicView.searchRank` mirrors this.
     */
    readonly searchRank: number | null;
}

/** Fields written by `INSERT`. Owner / category required; everything else optional. */
export interface InsertBusinessInput {
    readonly ownerUserId: string;
    readonly categoryId: string;
    readonly name?: string | null;
    readonly description?: LocalizedText | null;
    readonly city?: string | null;
    readonly addressLine?: string | null;
    readonly latitude?: number | null;
    readonly longitude?: number | null;
    readonly phone?: string | null;
    readonly telegramHandle?: string | null;
    readonly whatsappPhone?: string | null;
}

/**
 * Fields mutable through `update`. `undefined` means "leave unchanged",
 * an explicit `null` means "clear the field". This shape mirrors JSON-patch
 * semantics at the HTTP boundary.
 *
 * `status`, `rating_avg`, `rating_count`, `featured_until`, `owner_user_id`,
 * and timestamps are NOT in this type — they have their own dedicated
 * mutation paths (e.g. `setStatus`) or are computed by the system.
 */
export interface UpdateBusinessFields {
    readonly categoryId?: string;
    readonly name?: string | null;
    readonly description?: LocalizedText | null;
    readonly city?: string | null;
    readonly addressLine?: string | null;
    readonly latitude?: number | null;
    readonly longitude?: number | null;
    readonly phone?: string | null;
    readonly telegramHandle?: string | null;
    readonly whatsappPhone?: string | null;
}

/**
 * Phase 9 Track 6 — sort modes for the public listing.
 *
 *   * `featured`  — default, preserves the existing
 *                   `featured_until DESC NULLS LAST, rating_avg DESC,
 *                   created_at DESC, id DESC` order. Cursor pagination
 *                   supported.
 *   * `relevance` — only meaningful when `query` is set. Orders by
 *                   `(featured_until DESC NULLS LAST, ts_rank DESC,
 *                   rating_avg DESC, created_at DESC, id DESC)`.
 *                   First-version: no cursor pagination — the
 *                   repository returns up to `limit` rows and the
 *                   service emits `nextCursor: null`. Rank-aware
 *                   cursor lands in a follow-up when query traffic
 *                   warrants it.
 *   * `rating`    — `rating_avg DESC, rating_count DESC, created_at
 *                   DESC, id DESC`. No cursor pagination yet.
 *   * `newest`    — `created_at DESC, id DESC`. No cursor pagination
 *                   yet.
 *
 * Only `featured` supports the cursor in this commit; the other
 * three are first-page-only. This trade-off keeps the diff small
 * and matches mobile UX — the customer rarely paginates past page
 * one on a non-featured sort.
 */
export type BusinessSortMode = 'featured' | 'relevance' | 'rating' | 'newest';

/** Filters accepted by `listPublic`. All optional. */
export interface PublicBusinessFilters {
    readonly categoryId?: string;
    readonly city?: string;
    /**
     * Free-text query. When set, matches against `name` + `description.en`
     * + `description.am` via the `search_tsv` GIN index using
     * `websearch_to_tsquery('simple', unaccent($))`. The repository falls
     * back to `lower(name) ILIKE '%' || q || '%'` (trigram-indexed) when
     * the tsvector path returns zero rows — handles short prefixes the
     * tsvector won't index.
     */
    readonly query?: string;
    readonly ratingMin?: number;
    /**
     * Phase 9 Track 6 — when true, filters to rows where
     * `featured_until > now()`. Surfaces the "show only featured"
     * affordance on the mobile UI; transparency over paid placement.
     */
    readonly featuredOnly?: boolean;
    /**
     * Phase 9 Track 6 — sort mode. Defaults to `'featured'` in the
     * service layer (the existing behavior). Only `'featured'` supports
     * cursor pagination in this commit.
     */
    readonly sort?: BusinessSortMode;
}

/**
 * Filters accepted by `listForAdmin`. Status is the dominant filter
 * for admin queues (PENDING_REVIEW screen, SUSPENDED audit, etc.).
 * No cursor pagination in MVP — admin listings are bounded by the
 * `limit` parameter (default and max set at the call site).
 */
export interface AdminBusinessFilters {
    readonly status?: BusinessStatus;
}

/**
 * Decoded cursor shape. The encoded form is opaque to callers
 * (`base64url(JSON.stringify(payload))`); the codec lives in
 * `businessService.ts`.
 */
export interface ParsedCursor {
    readonly id: string;
    readonly sortKey: {
        readonly featuredUntil: string | null; // ISO-8601 or null
        readonly ratingAvg: number;
        readonly createdAt: string; // ISO-8601
    };
}

export interface BusinessRepository {
    insert(input: InsertBusinessInput): Promise<Business>;
    update(id: string, patch: UpdateBusinessFields): Promise<Business>;
    setStatus(id: string, status: BusinessStatus): Promise<Business>;
    /**
     * Dedicated mutation path for `featured_until`. Admin-only at the
     * service layer. Pass `null` to clear the column (unfeature).
     */
    setFeaturedUntil(id: string, featuredUntil: Date | null): Promise<Business>;
    findById(id: string): Promise<Business | null>;
    findByOwnerUserId(ownerUserId: string): Promise<Business | null>;
    listPublic(
        filters: PublicBusinessFilters,
        cursor: ParsedCursor | null,
        limit: number,
    ): Promise<readonly Business[]>;
    /**
     * Admin listing across all statuses. Optionally filtered by a
     * single `status`; sorted `created_at DESC, id DESC` so the
     * newest queue items surface first. No cursor pagination — Phase
     * 5 caps results at the call site.
     */
    listForAdmin(
        filters: AdminBusinessFilters,
        limit: number,
    ): Promise<readonly Business[]>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface BusinessRow {
    id: string;
    owner_user_id: string;
    category_id: string;
    name: string | null;
    description: LocalizedText | null;
    city: string | null;
    address_line: string | null;
    latitude: number | null;
    longitude: number | null;
    phone: string | null;
    telegram_handle: string | null;
    whatsapp_phone: string | null;
    status: BusinessStatus;
    featured_until: Date | null;
    rating_avg: string | number;
    rating_count: number;
    created_at: Date;
    updated_at: Date;
}

const BUSINESS_COLUMNS = [
    'id',
    'owner_user_id',
    'category_id',
    'name',
    'description',
    'city',
    'address_line',
    'latitude',
    'longitude',
    'phone',
    'telegram_handle',
    'whatsapp_phone',
    'status',
    'featured_until',
    'rating_avg',
    'rating_count',
    'created_at',
    'updated_at',
].join(', ');

// Maps camelCase patch keys to snake_case column names for partial updates.
const PATCHABLE_COLUMNS: Readonly<Record<keyof UpdateBusinessFields, string>> = Object.freeze({
    categoryId: 'category_id',
    name: 'name',
    description: 'description',
    city: 'city',
    addressLine: 'address_line',
    latitude: 'latitude',
    longitude: 'longitude',
    phone: 'phone',
    telegramHandle: 'telegram_handle',
    whatsappPhone: 'whatsapp_phone',
});

export class PgBusinessRepository extends BaseRepository implements BusinessRepository {
    async insert(input: InsertBusinessInput): Promise<Business> {
        const row = await this.one<BusinessRow>(
            `
            INSERT INTO business_profiles (
                owner_user_id, category_id, name, description, city,
                address_line, latitude, longitude, phone,
                telegram_handle, whatsapp_phone
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING ${BUSINESS_COLUMNS};
            `,
            [
                input.ownerUserId,
                input.categoryId,
                input.name ?? null,
                input.description ?? null,
                input.city ?? null,
                input.addressLine ?? null,
                input.latitude ?? null,
                input.longitude ?? null,
                input.phone ?? null,
                input.telegramHandle ?? null,
                input.whatsappPhone ?? null,
            ],
        );
        return mapRow(row);
    }

    async update(id: string, patch: UpdateBusinessFields): Promise<Business> {
        const sets: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        for (const [camelKey, column] of Object.entries(PATCHABLE_COLUMNS) as Array<
            [keyof UpdateBusinessFields, string]
        >) {
            const value = patch[camelKey];
            if (value === undefined) continue;
            sets.push(`${column} = $${idx}`);
            params.push(value);
            idx += 1;
        }

        if (sets.length === 0) {
            // No-op patch: return current row. `update` returning a Business is
            // the contract; callers shouldn't see a different shape just
            // because they sent an empty body.
            const current = await this.findById(id);
            if (!current) throw new RepositoryError(`Business ${id} not found.`);
            return current;
        }

        params.push(id);
        const row = await this.oneOrNone<BusinessRow>(
            `
            UPDATE business_profiles
               SET ${sets.join(', ')}
             WHERE id = $${idx}
            RETURNING ${BUSINESS_COLUMNS};
            `,
            params,
        );
        if (!row) throw new RepositoryError(`Business ${id} not found.`);
        return mapRow(row);
    }

    async setStatus(id: string, status: BusinessStatus): Promise<Business> {
        const row = await this.oneOrNone<BusinessRow>(
            `
            UPDATE business_profiles
               SET status = $2
             WHERE id = $1
            RETURNING ${BUSINESS_COLUMNS};
            `,
            [id, status],
        );
        if (!row) throw new RepositoryError(`Business ${id} not found.`);
        return mapRow(row);
    }

    async setFeaturedUntil(
        id: string,
        featuredUntil: Date | null,
    ): Promise<Business> {
        const row = await this.oneOrNone<BusinessRow>(
            `
            UPDATE business_profiles
               SET featured_until = $2
             WHERE id = $1
            RETURNING ${BUSINESS_COLUMNS};
            `,
            [id, featuredUntil],
        );
        if (!row) throw new RepositoryError(`Business ${id} not found.`);
        return mapRow(row);
    }

    async findById(id: string): Promise<Business | null> {
        const row = await this.oneOrNone<BusinessRow>(
            `SELECT ${BUSINESS_COLUMNS} FROM business_profiles WHERE id = $1;`,
            [id],
        );
        return row ? mapRow(row) : null;
    }

    async findByOwnerUserId(ownerUserId: string): Promise<Business | null> {
        // MVP enforces one-business-per-owner at the service layer. If a future
        // migration drops that rule, this query would need to disambiguate
        // (LIMIT 1, ORDER BY created_at DESC, or similar).
        const row = await this.oneOrNone<BusinessRow>(
            `SELECT ${BUSINESS_COLUMNS} FROM business_profiles WHERE owner_user_id = $1;`,
            [ownerUserId],
        );
        return row ? mapRow(row) : null;
    }

    async listPublic(
        filters: PublicBusinessFilters,
        cursor: ParsedCursor | null,
        limit: number,
    ): Promise<readonly Business[]> {
        const sort: BusinessSortMode = filters.sort ?? 'featured';
        const trimmedQuery =
            typeof filters.query === 'string' && filters.query.trim() !== ''
                ? filters.query.trim()
                : null;
        const useRelevance = sort === 'relevance' && trimmedQuery !== null;

        const params: unknown[] = [
            filters.categoryId ?? null,
            filters.city ?? null,
            trimmedQuery,
            filters.ratingMin ?? null,
            filters.featuredOnly === true,
        ];

        // Cursor pagination is supported only for the `featured` sort
        // in this commit. Non-featured sorts are first-page-only; the
        // service layer emits `nextCursor: null` accordingly.
        let cursorPredicate = '';
        if (cursor && sort === 'featured') {
            params.push(cursor.sortKey.featuredUntil ?? '-infinity');
            params.push(cursor.sortKey.ratingAvg);
            params.push(cursor.sortKey.createdAt);
            params.push(cursor.id);
            cursorPredicate = `
              AND (
                COALESCE(featured_until, '-infinity'::timestamptz),
                rating_avg,
                created_at,
                id
              ) < ($6::timestamptz, $7::numeric, $8::timestamptz, $9::uuid)
            `;
        }

        params.push(limit);
        // `LIMIT $N` provides a type context that Postgres infers
        // as `bigint`, so the cast is not strictly necessary today.
        // We add `::int` anyway: (a) makes the contract explicit
        // alongside the other positional casts in this query, and
        // (b) keeps the SQL-shape regression test in
        // `tests/businesses/pgBusinessRepository.test.ts` simple
        // — assert every bound param appears with `$N::TYPE`.
        const limitParam = `$${params.length}::int`;

        // The full-text predicate uses the `search_tsv` generated
        // column (migration 0017). When the tsvector path returns
        // zero rows for a short prefix, the trigram-indexed `name`
        // ILIKE predicate complements it — `OR` between the two so
        // either path can match.
        //
        // IMPORTANT: $3 (the query string) MUST always appear in the
        // SQL with an explicit `::text` cast — even when no query was
        // supplied — because the params array always includes a value
        // at index 3 (`trimmedQuery`, which is `null` when no `?q=`).
        // Postgres derives the parameter count from the highest `$N`
        // referenced in the SQL, but it also needs to assign a type
        // to every positional slot implied by that count. If $3 is
        // bound but not referenced, Postgres throws
        //   `could not determine data type of parameter $3`
        // on every category-only request like `?category=salon`.
        // The fix is the `$3::text IS NULL OR (...)` short-circuit:
        // when `trimmedQuery` is null, $3 is typed by the cast and
        // the predicate evaluates to TRUE without filtering; when
        // it's non-null, the FTS + trigram fallback applies as
        // before. Same pattern as `$1::uuid IS NULL OR …` /
        // `$2::text IS NULL OR …` above.
        const queryPredicate = `AND ($3::text IS NULL OR (
                  search_tsv @@ websearch_to_tsquery(
                      'simple',
                      ethiolink_unaccent_immutable($3::text)
                  )
                  OR lower(name) ILIKE '%' || lower($3::text) || '%'
              ))`;

        const featuredOnlyPredicate = `
              AND ($5::boolean = false
                   OR (featured_until IS NOT NULL AND featured_until > now()))
        `;

        // Pick the ORDER BY clause based on `sort`. The `featured`
        // mode is the existing behaviour; the three new modes are
        // each documented inline. Note that `rank` is computed only
        // when relevance is the chosen sort + a query is present —
        // it appears in the SELECT projection so the result row
        // carries it back to `mapRow`.
        const rankExpr = useRelevance
            ? `ts_rank(
                   search_tsv,
                   websearch_to_tsquery('simple', ethiolink_unaccent_immutable($3::text))
               )`
            : 'NULL::real';

        let orderBy: string;
        switch (sort) {
            case 'relevance':
                // Featured wins the first tier (paid placement
                // protected); within each tier `ts_rank` orders by
                // match quality. Falls back to the featured order
                // when `query` is empty (treated as `'featured'`).
                orderBy = useRelevance
                    ? `COALESCE(featured_until, '-infinity'::timestamptz) DESC,
                       ts_rank(
                           search_tsv,
                           websearch_to_tsquery('simple', ethiolink_unaccent_immutable($3::text))
                       ) DESC,
                       rating_avg DESC,
                       created_at DESC,
                       id DESC`
                    : `COALESCE(featured_until, '-infinity'::timestamptz) DESC,
                       rating_avg DESC,
                       created_at DESC,
                       id DESC`;
                break;
            case 'rating':
                orderBy = `rating_avg DESC, rating_count DESC, created_at DESC, id DESC`;
                break;
            case 'newest':
                orderBy = `created_at DESC, id DESC`;
                break;
            case 'featured':
            default:
                orderBy = `COALESCE(featured_until, '-infinity'::timestamptz) DESC,
                           rating_avg DESC,
                           created_at DESC,
                           id DESC`;
                break;
        }

        const rows = await this.many<BusinessRow & { search_rank: number | null }>(
            `
            SELECT ${BUSINESS_COLUMNS}, ${rankExpr} AS search_rank
              FROM business_profiles
             WHERE status = 'APPROVED'
               AND ($1::uuid     IS NULL OR category_id = $1)
               AND ($2::text     IS NULL OR LOWER(city) = LOWER($2))
               AND ($4::numeric  IS NULL OR rating_avg >= $4)
               ${queryPredicate}
               ${featuredOnlyPredicate}
               ${cursorPredicate}
             ORDER BY ${orderBy}
             LIMIT ${limitParam};
            `,
            params,
        );
        return rows.map((row) =>
            Object.freeze<Business>({
                ...mapRow(row),
                searchRank:
                    typeof row.search_rank === 'number' ? row.search_rank : null,
            }),
        );
    }

    async listForAdmin(
        filters: AdminBusinessFilters,
        limit: number,
    ): Promise<readonly Business[]> {
        const rows = await this.many<BusinessRow>(
            `
            SELECT ${BUSINESS_COLUMNS}
              FROM business_profiles
             WHERE ($1::text IS NULL OR status = $1)
             ORDER BY created_at DESC, id DESC
             LIMIT $2;
            `,
            [filters.status ?? null, limit],
        );
        return rows.map(mapRow);
    }
}

function mapRow(row: BusinessRow): Business {
    return Object.freeze<Business>({
        id: row.id,
        ownerUserId: row.owner_user_id,
        categoryId: row.category_id,
        name: row.name,
        description: row.description ? Object.freeze({ ...row.description }) : null,
        city: row.city,
        addressLine: row.address_line,
        latitude: row.latitude,
        longitude: row.longitude,
        phone: row.phone,
        telegramHandle: row.telegram_handle,
        whatsappPhone: row.whatsapp_phone,
        status: row.status,
        featuredUntil: row.featured_until,
        // `numeric` columns are returned by pg as strings to preserve precision.
        ratingAvg: typeof row.rating_avg === 'string' ? Number(row.rating_avg) : row.rating_avg,
        ratingCount: row.rating_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Phase 9 Track 6 — `listPublic` overrides this when the
        // `sort=relevance` SELECT projects `ts_rank`. Every other
        // call path resolves to `null`.
        searchRank: null,
    });
}
