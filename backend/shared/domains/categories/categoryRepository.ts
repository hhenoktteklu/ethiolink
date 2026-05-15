// EthioLink — category repository.
//
// Read paths shipped in Phase 2; admin write paths (insert / update /
// setIsActive) added in Phase 5 to back `AdminCategoryService`.
//
// Notes:
//   * "Active by default" is a service-level decision: `listActive()`
//     filters `is_active = true`. `listAll()` is exported so the
//     interface is complete for admin endpoints; public-facing
//     callers should use `listActive()`.
//   * Sort order: `sort_order ASC, name->>'en' ASC`. Within a sort_order
//     bucket the alphabetical English name is the tiebreaker, which
//     keeps the listing deterministic and matches the spec note in
//     PHASE_2_BUSINESS_PROFILES.md.
//   * `LocalizedText` is the JSONB shape `{en, am?}`. The pg driver
//     auto-parses jsonb into a JavaScript object, so no JSON.parse
//     ceremony is needed here.
//   * Column lists are spelled out — no `SELECT *` in production code.
//   * `slug` is `UNIQUE`. Duplicate inserts / updates raise SQLSTATE
//     23505; the admin service catches and translates to
//     `AdminCategorySlugTakenError`. The repository does NOT
//     translate — same pattern used elsewhere for unique-violation
//     handling.
//   * `is_active` is mutated through `setIsActive`, not via `update`.
//     The dedicated path keeps the soft-delete intent explicit at
//     every call site and matches the `services` / `staff` repos.

import { BaseRepository, RepositoryError } from '../../repositories/baseRepository.js';

/**
 * JSONB localized-text shape used by every multilingual column in the
 * data model. Keys are ISO 639-1 codes. MVP only writes `en`; `am` will
 * land once an Amharic-speaking content pass happens.
 */
export interface LocalizedText {
    readonly en: string;
    readonly am?: string;
}

/** Domain shape of a `business_categories` row. */
export interface Category {
    readonly id: string;
    readonly slug: string;
    readonly name: LocalizedText;
    readonly sortOrder: number;
    readonly isActive: boolean;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/** Fields written by `insert`. `sortOrder` defaults to `0` per migration 0003. */
export interface InsertCategoryInput {
    readonly slug: string;
    readonly name: LocalizedText;
    readonly sortOrder?: number;
}

/**
 * Fields mutable through `update`. `undefined` = no change; an
 * all-undefined patch is a no-op that returns the existing row
 * unchanged. `isActive` is mutated through `setIsActive`, not patched,
 * so the soft-delete intent stays explicit at every call site.
 */
export interface UpdateCategoryFields {
    readonly slug?: string;
    readonly name?: LocalizedText;
    readonly sortOrder?: number;
}

/**
 * Filters accepted by `listForAdmin`. `isActive` is the only filter
 * in MVP — admin dashboards surface "all", "active only", or
 * "deactivated" buckets. No cursor pagination; categories are a
 * small fixed set bounded by the `limit` parameter.
 */
export interface AdminCategoryFilters {
    readonly isActive?: boolean;
}

export interface CategoryRepository {
    listActive(): Promise<readonly Category[]>;
    listAll(): Promise<readonly Category[]>;
    findById(id: string): Promise<Category | null>;
    findBySlug(slug: string): Promise<Category | null>;
    insert(input: InsertCategoryInput): Promise<Category>;
    update(id: string, patch: UpdateCategoryFields): Promise<Category>;
    setIsActive(id: string, isActive: boolean): Promise<Category>;
    /**
     * Admin listing. Optional `isActive` filter; sort matches the
     * public canonical order (`sort_order ASC, name->>'en' ASC`) so
     * the admin sees rows in the same arrangement customers would.
     */
    listForAdmin(
        filters: AdminCategoryFilters,
        limit: number,
    ): Promise<readonly Category[]>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface CategoryRow {
    id: string;
    slug: string;
    name: LocalizedText;
    sort_order: number;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}

const CATEGORY_COLUMNS =
    'id, slug, name, sort_order, is_active, created_at, updated_at';

// Deterministic ordering. Stable across calls so cursor pagination
// (added by business listings later) can build on it without surprises.
const ORDER_BY = `ORDER BY sort_order ASC, name->>'en' ASC`;

export class PgCategoryRepository extends BaseRepository implements CategoryRepository {
    async listActive(): Promise<readonly Category[]> {
        const rows = await this.many<CategoryRow>(
            `
            SELECT ${CATEGORY_COLUMNS}
            FROM business_categories
            WHERE is_active = true
            ${ORDER_BY};
            `,
        );
        return rows.map(mapRow);
    }

    async listAll(): Promise<readonly Category[]> {
        const rows = await this.many<CategoryRow>(
            `
            SELECT ${CATEGORY_COLUMNS}
            FROM business_categories
            ${ORDER_BY};
            `,
        );
        return rows.map(mapRow);
    }

    async findById(id: string): Promise<Category | null> {
        const row = await this.oneOrNone<CategoryRow>(
            `SELECT ${CATEGORY_COLUMNS} FROM business_categories WHERE id = $1;`,
            [id],
        );
        return row ? mapRow(row) : null;
    }

    async findBySlug(slug: string): Promise<Category | null> {
        const row = await this.oneOrNone<CategoryRow>(
            `SELECT ${CATEGORY_COLUMNS} FROM business_categories WHERE slug = $1;`,
            [slug],
        );
        return row ? mapRow(row) : null;
    }

    async insert(input: InsertCategoryInput): Promise<Category> {
        // `sort_order` defaults to 0 at the DB; we pass undefined → null
        // and let the column default apply when the caller omits it.
        const row = await this.one<CategoryRow>(
            `
            INSERT INTO business_categories (slug, name, sort_order)
            VALUES ($1, $2::jsonb, COALESCE($3, 0))
            RETURNING ${CATEGORY_COLUMNS};
            `,
            [input.slug, JSON.stringify(input.name), input.sortOrder ?? null],
        );
        return mapRow(row);
    }

    async update(id: string, patch: UpdateCategoryFields): Promise<Category> {
        const sets: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (patch.slug !== undefined) {
            sets.push(`slug = $${idx}`);
            params.push(patch.slug);
            idx += 1;
        }
        if (patch.name !== undefined) {
            sets.push(`name = $${idx}::jsonb`);
            params.push(JSON.stringify(patch.name));
            idx += 1;
        }
        if (patch.sortOrder !== undefined) {
            sets.push(`sort_order = $${idx}`);
            params.push(patch.sortOrder);
            idx += 1;
        }

        if (sets.length === 0) {
            // No-op patch: return current row, matching the same
            // convention as services / staff / business repos.
            const current = await this.findById(id);
            if (!current) throw new RepositoryError(`Category ${id} not found.`);
            return current;
        }

        params.push(id);
        const row = await this.oneOrNone<CategoryRow>(
            `
            UPDATE business_categories
               SET ${sets.join(', ')}
             WHERE id = $${idx}
            RETURNING ${CATEGORY_COLUMNS};
            `,
            params,
        );
        if (!row) throw new RepositoryError(`Category ${id} not found.`);
        return mapRow(row);
    }

    async setIsActive(id: string, isActive: boolean): Promise<Category> {
        const row = await this.oneOrNone<CategoryRow>(
            `
            UPDATE business_categories
               SET is_active = $2
             WHERE id = $1
            RETURNING ${CATEGORY_COLUMNS};
            `,
            [id, isActive],
        );
        if (!row) throw new RepositoryError(`Category ${id} not found.`);
        return mapRow(row);
    }

    async listForAdmin(
        filters: AdminCategoryFilters,
        limit: number,
    ): Promise<readonly Category[]> {
        const rows = await this.many<CategoryRow>(
            `
            SELECT ${CATEGORY_COLUMNS}
              FROM business_categories
             WHERE ($1::bool IS NULL OR is_active = $1)
             ${ORDER_BY}
             LIMIT $2;
            `,
            [filters.isActive ?? null, limit],
        );
        return rows.map(mapRow);
    }
}

function mapRow(row: CategoryRow): Category {
    return Object.freeze<Category>({
        id: row.id,
        slug: row.slug,
        name: Object.freeze({ ...row.name }),
        sortOrder: row.sort_order,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}
