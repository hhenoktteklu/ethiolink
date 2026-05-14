// EthioLink — category repository.
//
// Read-only access to the `business_categories` table for Phase 2. The
// admin write paths (create / update / deactivate categories) come in
// Phase 5 alongside the rest of the admin dashboard surface.
//
// Notes:
//   * "Active by default" is a service-level decision: `listActive()`
//     filters `is_active = true`. `listAll()` is exported so the
//     interface is complete for future admin endpoints; public-facing
//     callers should use `listActive()`.
//   * Sort order: `sort_order ASC, name->>'en' ASC`. Within a sort_order
//     bucket the alphabetical English name is the tiebreaker, which
//     keeps the listing deterministic and matches the spec note in
//     PHASE_2_BUSINESS_PROFILES.md.
//   * `LocalizedText` is the JSONB shape `{en, am?}`. The pg driver
//     auto-parses jsonb into a JavaScript object, so no JSON.parse
//     ceremony is needed here.
//   * Column lists are spelled out — no `SELECT *` in production code.

import { BaseRepository } from '../../repositories/baseRepository.js';

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

export interface CategoryRepository {
    listActive(): Promise<readonly Category[]>;
    listAll(): Promise<readonly Category[]>;
    findById(id: string): Promise<Category | null>;
    findBySlug(slug: string): Promise<Category | null>;
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
