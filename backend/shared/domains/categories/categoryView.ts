// EthioLink — JSON shapes for a category.
//
// Two projections of the same domain object:
//   * `CategoryView` — public-facing. Returned by `GET /v1/categories`
//     and embedded in business profile responses. The public listing
//     already filters to active rows only, so `isActive` is omitted.
//   * `AdminCategoryView` — admin-facing. Extends `CategoryView` with
//     `isActive` so the dashboard can render the active / deactivated
//     buckets.
//
// The localized `name` is kept as a structured object on the wire —
// clients pick the active locale without an additional round-trip
// and without server-side language negotiation.

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

/**
 * Admin projection. Adds `isActive` so the dashboard can colour-code
 * deactivated rows; everything else mirrors `CategoryView`.
 */
export interface AdminCategoryView extends CategoryView {
    readonly isActive: boolean;
}

export function toAdminCategoryView(category: Category): AdminCategoryView {
    return Object.freeze<AdminCategoryView>({
        ...toCategoryView(category),
        isActive: category.isActive,
    });
}
