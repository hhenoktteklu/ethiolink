// EthioLink — in-memory `CategoryRepository` for tests.
//
// Mirrors `PgCategoryRepository`'s read-only surface. Sort order is
// `sort_order ASC, name->>'en' ASC` — same as the production SQL
// `ORDER BY` clause. The fake's `seed(category)` is the only write
// path; production code doesn't expose a category insert (admin
// category writes land in Phase 5).

import type {
    Category,
    CategoryRepository,
} from '../../shared/domains/categories/categoryRepository.js';

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
}

function compareCategories(a: Category, b: Category): number {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.en.localeCompare(b.name.en);
}
