// EthioLink — public JSON shape for a category.
//
// Returned by `GET /v1/categories` and embedded in business profile
// responses (Phase 2 listing + detail endpoints). The localized `name`
// is kept as a structured object on the wire — clients pick the active
// locale without an additional round-trip and without server-side
// language negotiation.
//
// What's omitted from the public view:
//   * `isActive` — the public listing already filters to active rows
//     only, so surfacing this would be redundant noise. Admin endpoints
//     in Phase 5 will use a separate view that includes it.

import type { Category, LocalizedText } from './categoryRepository.js';

export interface CategoryView {
    readonly id: string;
    readonly slug: string;
    readonly name: LocalizedText;
    readonly sortOrder: number;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export function toCategoryView(category: Category): CategoryView {
    return Object.freeze<CategoryView>({
        id: category.id,
        slug: category.slug,
        name: category.name,
        sortOrder: category.sortOrder,
        createdAt: category.createdAt.toISOString(),
        updatedAt: category.updatedAt.toISOString(),
    });
}
