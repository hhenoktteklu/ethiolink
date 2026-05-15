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

/** Filters accepted by `listPublic`. All optional. */
export interface PublicBusinessFilters {
    readonly categoryId?: string;
    readonly city?: string;
    readonly query?: string;
    readonly ratingMin?: number;
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
        const params: unknown[] = [
            filters.categoryId ?? null,
            filters.city ?? null,
            filters.query ?? null,
            filters.ratingMin ?? null,
        ];

        // Cursor params are emitted only when a cursor is present, to keep
        // the SQL simple when listing the first page.
        let cursorPredicate = '';
        if (cursor) {
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
              ) < ($5::timestamptz, $6::numeric, $7::timestamptz, $8::uuid)
            `;
        }

        params.push(limit);
        const limitParam = `$${params.length}`;

        const rows = await this.many<BusinessRow>(
            `
            SELECT ${BUSINESS_COLUMNS}
              FROM business_profiles
             WHERE status = 'APPROVED'
               AND ($1::uuid     IS NULL OR category_id = $1)
               AND ($2::text     IS NULL OR LOWER(city) = LOWER($2))
               AND ($3::text     IS NULL OR name ILIKE '%' || $3 || '%')
               AND ($4::numeric  IS NULL OR rating_avg >= $4)
               ${cursorPredicate}
             ORDER BY COALESCE(featured_until, '-infinity'::timestamptz) DESC,
                      rating_avg DESC,
                      created_at DESC,
                      id DESC
             LIMIT ${limitParam};
            `,
            params,
        );
        return rows.map(mapRow);
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
    });
}
