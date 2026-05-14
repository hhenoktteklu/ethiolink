// EthioLink — CategoryService unit tests.
//
// CategoryService is read-only in Phase 2. Coverage:
//
//   * listActive — active-only filter, sort order
//     (`sort_order ASC, name->'en' ASC`), empty-state, localized name
//     preserved as a structured object on the way out.
//   * getBySlug — hit, miss. Returns inactive rows too — filtering
//     by `isActive` is a listing-only concern; lookups by slug are
//     used internally (e.g. the businesses-list handler resolves a
//     slug → id and *then* checks `isActive`).
//   * getById — hit, miss.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Category } from '../../shared/domains/categories/categoryRepository.js';
import { CategoryService } from '../../shared/domains/categories/categoryService.js';

import { InMemoryCategoryRepository } from '../_fakes/InMemoryCategoryRepository.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCategory(overrides: Partial<Category> = {}): Category {
    const now = new Date('2026-05-14T12:00:00.000Z');
    return Object.freeze({
        id: '11111111-1111-1111-1111-111111111111',
        slug: 'salon',
        name: Object.freeze({ en: 'Salon' }),
        sortOrder: 10,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    });
}

function build(): { service: CategoryService; repo: InMemoryCategoryRepository } {
    const repo = new InMemoryCategoryRepository();
    return { service: new CategoryService(repo), repo };
}

// ---------------------------------------------------------------------------
// listActive
// ---------------------------------------------------------------------------

describe('CategoryService.listActive', () => {
    it('returns only active categories', async () => {
        const { service, repo } = build();
        repo.seed(makeCategory({ id: 'a', slug: 'salon', isActive: true }));
        repo.seed(makeCategory({ id: 'b', slug: 'barber', isActive: false }));
        repo.seed(makeCategory({ id: 'c', slug: 'spa', isActive: true }));

        const items = await service.listActive();

        assert.deepStrictEqual(
            items.map((c) => c.id).sort(),
            ['a', 'c'],
        );
    });

    it('orders by sort_order ASC, then name.en ASC', async () => {
        const { service, repo } = build();
        // Within sort_order=10, "Barber" < "Salon" alphabetically.
        repo.seed(
            makeCategory({
                id: 'salon',
                slug: 'salon',
                sortOrder: 10,
                name: { en: 'Salon' },
            }),
        );
        repo.seed(
            makeCategory({
                id: 'barber',
                slug: 'barber',
                sortOrder: 10,
                name: { en: 'Barber' },
            }),
        );
        // Higher sort_order comes after.
        repo.seed(
            makeCategory({
                id: 'spa',
                slug: 'spa',
                sortOrder: 20,
                name: { en: 'Spa' },
            }),
        );
        repo.seed(
            makeCategory({
                id: 'beauty',
                slug: 'beauty_professional',
                sortOrder: 30,
                name: { en: 'Beauty Professional' },
            }),
        );

        const items = await service.listActive();

        assert.deepStrictEqual(
            items.map((c) => c.id),
            ['barber', 'salon', 'spa', 'beauty'],
        );
    });

    it('returns an empty array when no categories exist', async () => {
        const { service } = build();
        assert.deepStrictEqual(await service.listActive(), []);
    });

    it('preserves the localized name as a structured object', async () => {
        const { service, repo } = build();
        repo.seed(
            makeCategory({
                id: 'salon',
                name: { en: 'Salon', am: 'ሳሎን' },
            }),
        );

        const [item] = await service.listActive();

        assert.strictEqual(typeof item?.name, 'object');
        assert.strictEqual(item?.name.en, 'Salon');
        assert.strictEqual(item?.name.am, 'ሳሎን');
    });
});

// ---------------------------------------------------------------------------
// getBySlug
// ---------------------------------------------------------------------------

describe('CategoryService.getBySlug', () => {
    it('returns the matching category', async () => {
        const { service, repo } = build();
        repo.seed(makeCategory({ id: 'a', slug: 'salon' }));
        repo.seed(makeCategory({ id: 'b', slug: 'barber' }));

        const found = await service.getBySlug('barber');

        assert.strictEqual(found?.id, 'b');
        assert.strictEqual(found?.slug, 'barber');
    });

    it('returns null when the slug is unknown', async () => {
        const { service, repo } = build();
        repo.seed(makeCategory({ id: 'a', slug: 'salon' }));

        assert.strictEqual(await service.getBySlug('does-not-exist'), null);
    });

    it('returns inactive categories too — filtering is the caller\'s job', async () => {
        // The businesses-list handler does the active check after this
        // lookup; the service must not silently hide inactive rows.
        const { service, repo } = build();
        repo.seed(
            makeCategory({ id: 'inactive', slug: 'old-category', isActive: false }),
        );

        const found = await service.getBySlug('old-category');

        assert.strictEqual(found?.id, 'inactive');
        assert.strictEqual(found?.isActive, false);
    });
});

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

describe('CategoryService.getById', () => {
    it('returns the matching category', async () => {
        const { service, repo } = build();
        repo.seed(makeCategory({ id: 'a', slug: 'salon' }));
        repo.seed(makeCategory({ id: 'b', slug: 'barber' }));

        const found = await service.getById('b');

        assert.strictEqual(found?.id, 'b');
        assert.strictEqual(found?.slug, 'barber');
    });

    it('returns null when the id is unknown', async () => {
        const { service } = build();
        assert.strictEqual(
            await service.getById('99999999-9999-9999-9999-999999999999'),
            null,
        );
    });

    it('returns inactive categories too', async () => {
        const { service, repo } = build();
        repo.seed(
            makeCategory({ id: 'inactive', slug: 'old', isActive: false }),
        );

        const found = await service.getById('inactive');

        assert.strictEqual(found?.id, 'inactive');
        assert.strictEqual(found?.isActive, false);
    });
});
