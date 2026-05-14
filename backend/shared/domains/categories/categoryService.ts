// EthioLink — category service.
//
// Phase 2 ships the read side only:
//   * `listActive()` powers the public `GET /v1/categories` endpoint.
//   * `getBySlug()` powers the category filter on business listings
//     (`?category=salon` style URLs).
//   * `getById()` powers internal lookups when a service holds only a
//     category UUID (e.g. validating `category_id` on business create).
//
// Admin write paths (create, update, deactivate) are Phase 5 work.
//
// The service is intentionally thin over the repository for read-only
// operations. Following the userService / userRepository split keeps a
// consistent boundary: handlers depend on the service, the service
// owns rules, the repository owns SQL. Future caching, post-processing,
// or business rules around categories slot in here without rippling
// out to handlers.

import type { Category, CategoryRepository } from './categoryRepository.js';

export class CategoryService {
    constructor(private readonly repository: CategoryRepository) {}

    /**
     * All active categories, sorted by `(sort_order ASC, name->'en' ASC)`.
     * This is the only listing public callers should use; inactive
     * categories are filtered out.
     */
    async listActive(): Promise<readonly Category[]> {
        return this.repository.listActive();
    }

    /** Find a category by its stable slug (e.g. `'salon'`). `null` when not found. */
    async getBySlug(slug: string): Promise<Category | null> {
        return this.repository.findBySlug(slug);
    }

    /** Find a category by primary key. `null` when not found. */
    async getById(id: string): Promise<Category | null> {
        return this.repository.findById(id);
    }
}
