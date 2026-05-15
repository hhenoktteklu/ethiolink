// EthioLink — in-memory `CategoryRepository` for tests.
//
// Mirrors `PgCategoryRepository`'s full surface — read paths from
// Phase 2 plus the Phase 5 admin write paths (`insert`, `update`,
// `setIsActive`). Sort order is `sort_order ASC, name->>'en' ASC`
// to match the production `ORDER BY` clause.
//
// `seed(category)` remains the direct-injection helper for tests
// that need to fix the id / timestamps / isActive flag without
// going through the write path. `insert` mirrors the production
// shape — a 23505-style pg error on duplicate slug.

import { randomUUID } from 'node:crypto';

import { RepositoryError } from '../../shared/repositories/baseRepository.js';
import type {
    Category,
    CategoryRepository,
    InsertCategoryInput,
    UpdateCategoryFields,
} from '../../shared/domains/categories/categoryRepository.js';

/**
 * pg-shaped error for INSERT / UPDATE statements that violate the
 * `business_categories_slug_key` UNIQUE constraint. Carries
 * `.code === '23505'` so the admin service's duck-typed
 * `isUniqueViolation` detector picks it up.
 */
class PgUniqueViolationError extends Error {
    public readonly code = '23505';
    constructor() {
        super('unique_violation (in-memory fake)');
        this.name = 'PgUniqueViolationError';
    }
}

export class InMemoryCategoryRepository implements CategoryRepository {
    private readonly rowsById = new Map<string, Category>();

    /** Test seed: insert a category row. Bypasses any production write path. */
    seed(category: Category): void {
        this.rowsById.set(category.id, Object.freeze({ ...category }));
    }

    /** Test helper: total rows stored. */
    size(): number {
        return this.rowsById.size;
    }

    async listActive(): Promise<readonly Category[]> {
        return Array.from(this.rowsById.values())
            .filter((c) => c.isActive)
            .sort(compareCategories);
    }

    async listAll(): Promise<readonly Category[]> {
        return Array.from(this.rowsById.values()).sort(compareCategories);
    }

    async findById(id: string): Promise<Category | null> {
        return this.rowsById.get(id) ?? null;
    }

    async findBySlug(slug: string): Promise<Category | null> {
        for (const c of this.rowsById.values()) {
            if (c.slug === slug) return c;
        }
        return null;
    }

    async insert(input: InsertCategoryInput): Promise<Category> {
        for (const c of this.rowsById.values()) {
            if (c.slug === input.slug) {
                throw new PgUniqueViolationError();
            }
        }
        const now = new Date();
        const row: Category = Object.freeze({
            id: randomUUID(),
            slug: input.slug,
            name: Object.freeze({ ...input.name }),
            sortOrder: input.sortOrder ?? 0,
            isActive: true,
            createdAt: now,
            updatedAt: now,
        });
        this.rowsById.set(row.id, row);
        return row;
    }

    async update(id: string, patch: UpdateCategoryFields): Promise<Category> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`Category ${id} not found.`);
        }
        const noop =
            patch.slug === undefined &&
            patch.name === undefined &&
            patch.sortOrder === undefined;
        if (noop) {
            return existing;
        }
        if (patch.slug !== undefined && patch.slug !== existing.slug) {
            // UNIQUE check against any other row.
            for (const c of this.rowsById.values()) {
                if (c.id !== id && c.slug === patch.slug) {
                    throw new PgUniqueViolationError();
                }
            }
        }
        const next: Category = Object.freeze({
            ...existing,
            slug: patch.slug ?? existing.slug,
            name:
                patch.name !== undefined
                    ? Object.freeze({ ...patch.name })
                    : existing.name,
            sortOrder: patch.sortOrder ?? existing.sortOrder,
            updatedAt: new Date(),
        });
        this.rowsById.set(id, next);
        return next;
    }

    async setIsActive(id: string, isActive: boolean): Promise<Category> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`Category ${id} not found.`);
        }
        const next: Category = Object.freeze({
            ...existing,
            isActive,
            updatedAt: new Date(),
        });
        this.rowsById.set(id, next);
        return next;
    }
}

function compareCategories(a: Category, b: Category): number {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.en.localeCompare(b.name.en);
}
