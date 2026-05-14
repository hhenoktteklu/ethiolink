// EthioLink — BusinessService unit tests.
//
// Covers the Phase 2 test-plan items called out in
// PHASE_2_BUSINESS_PROFILES.md:
//
//   * create — happy path + one-business-per-owner enforcement
//   * update — owner allowed, non-owner refused, missing target rejected
//   * submit — DRAFT → PENDING_REVIEW happy path, required-field
//              validation (name / description.en / city), invalid
//              source status, ownership refusal
//   * listPublic — status filter, individual + combined filters, sort
//                  order, cursor pagination roundtrip, invalid cursor
//   * findApproved — visible only when APPROVED
//   * getByOwner — any status

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { Business, BusinessStatus } from '../../shared/domains/businesses/businessRepository.js';
import {
    BusinessAlreadyExistsError,
    BusinessIncompleteForSubmitError,
    BusinessInvalidTransitionError,
    BusinessNotFoundError,
    BusinessNotOwnedError,
    BusinessService,
    InvalidCursorError,
    type CallerContext,
    type CreateBusinessInput,
} from '../../shared/domains/businesses/businessService.js';

import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const CATEGORY_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID_A = '22222222-2222-2222-2222-222222222222';
const OWNER_ID_B = '33333333-3333-3333-3333-333333333333';

function caller(userId: string, role: CallerContext['role'] = 'BUSINESS_OWNER'): CallerContext {
    return { userId, role };
}

function makeCreateInput(
    overrides: Partial<CreateBusinessInput> = {},
): CreateBusinessInput {
    return {
        categoryId: CATEGORY_ID,
        name: 'Test Salon',
        description: { en: 'A test salon.' },
        city: 'Addis Ababa',
        ...overrides,
    };
}

function makeBusiness(overrides: Partial<Business> = {}): Business {
    const now = new Date('2026-05-14T12:00:00.000Z');
    return Object.freeze({
        id: overrides.id ?? randomUUID(),
        ownerUserId: OWNER_ID_A,
        categoryId: CATEGORY_ID,
        name: 'Test Salon',
        description: { en: 'A test salon.' },
        city: 'Addis Ababa',
        addressLine: null,
        latitude: null,
        longitude: null,
        phone: null,
        telegramHandle: null,
        whatsappPhone: null,
        status: 'APPROVED' as BusinessStatus,
        featuredUntil: null,
        ratingAvg: 0,
        ratingCount: 0,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    });
}

function buildService(): { service: BusinessService; repo: InMemoryBusinessRepository } {
    const repo = new InMemoryBusinessRepository();
    return { service: new BusinessService(repo), repo };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('BusinessService.create', () => {
    it('creates a DRAFT business owned by the caller', async () => {
        const { service, repo } = buildService();

        const business = await service.create(OWNER_ID_A, makeCreateInput());

        assert.strictEqual(business.ownerUserId, OWNER_ID_A);
        assert.strictEqual(business.status, 'DRAFT');
        assert.strictEqual(business.categoryId, CATEGORY_ID);
        assert.strictEqual(business.name, 'Test Salon');
        assert.strictEqual(business.ratingAvg, 0);
        assert.strictEqual(business.ratingCount, 0);
        assert.strictEqual(repo.size(), 1);
    });

    it('refuses a second create for the same owner', async () => {
        const { service } = buildService();

        await service.create(OWNER_ID_A, makeCreateInput());

        await assert.rejects(
            () => service.create(OWNER_ID_A, makeCreateInput()),
            BusinessAlreadyExistsError,
        );
    });

    it('allows different owners to each have a business', async () => {
        const { service, repo } = buildService();

        await service.create(OWNER_ID_A, makeCreateInput());
        await service.create(OWNER_ID_B, makeCreateInput());

        assert.strictEqual(repo.size(), 2);
    });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('BusinessService.update', () => {
    it('lets the owner update mutable fields', async () => {
        const { service } = buildService();
        const created = await service.create(OWNER_ID_A, makeCreateInput());

        const updated = await service.update(created.id, caller(OWNER_ID_A), {
            name: 'New Name',
            city: 'Bahir Dar',
        });

        assert.strictEqual(updated.name, 'New Name');
        assert.strictEqual(updated.city, 'Bahir Dar');
        assert.strictEqual(updated.id, created.id);
    });

    it('refuses non-owner with BusinessNotOwnedError', async () => {
        const { service } = buildService();
        const created = await service.create(OWNER_ID_A, makeCreateInput());

        await assert.rejects(
            () =>
                service.update(created.id, caller(OWNER_ID_B), {
                    name: 'Hijacked',
                }),
            BusinessNotOwnedError,
        );
    });

    it('throws BusinessNotFoundError for an unknown id', async () => {
        const { service } = buildService();

        await assert.rejects(
            () =>
                service.update(
                    '99999999-9999-9999-9999-999999999999',
                    caller(OWNER_ID_A),
                    { name: 'Anything' },
                ),
            BusinessNotFoundError,
        );
    });

    it('returns the existing row for an empty patch', async () => {
        const { service } = buildService();
        const created = await service.create(OWNER_ID_A, makeCreateInput());

        const result = await service.update(created.id, caller(OWNER_ID_A), {});

        assert.strictEqual(result.id, created.id);
        assert.strictEqual(result.name, created.name);
    });
});

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

describe('BusinessService.submit', () => {
    it('transitions DRAFT → PENDING_REVIEW when all required fields are present', async () => {
        const { service } = buildService();
        const created = await service.create(OWNER_ID_A, makeCreateInput());

        const submitted = await service.submit(created.id, OWNER_ID_A);

        assert.strictEqual(submitted.status, 'PENDING_REVIEW');
        assert.strictEqual(submitted.id, created.id);
    });

    it('rejects submission when name is missing', async () => {
        const { service } = buildService();
        const created = await service.create(
            OWNER_ID_A,
            makeCreateInput({ name: null }),
        );

        await assert.rejects(
            () => service.submit(created.id, OWNER_ID_A),
            (err: unknown) =>
                err instanceof BusinessIncompleteForSubmitError &&
                err.missing.includes('name'),
        );
    });

    it('rejects submission when description.en is empty', async () => {
        const { service } = buildService();
        const created = await service.create(
            OWNER_ID_A,
            makeCreateInput({ description: { en: '   ' } }),
        );

        await assert.rejects(
            () => service.submit(created.id, OWNER_ID_A),
            (err: unknown) =>
                err instanceof BusinessIncompleteForSubmitError &&
                err.missing.includes('description'),
        );
    });

    it('rejects submission when city is missing', async () => {
        const { service } = buildService();
        const created = await service.create(
            OWNER_ID_A,
            makeCreateInput({ city: null }),
        );

        await assert.rejects(
            () => service.submit(created.id, OWNER_ID_A),
            (err: unknown) =>
                err instanceof BusinessIncompleteForSubmitError &&
                err.missing.includes('city'),
        );
    });

    it('lists every missing field in the error', async () => {
        const { service } = buildService();
        const created = await service.create(
            OWNER_ID_A,
            makeCreateInput({ name: null, description: null, city: null }),
        );

        try {
            await service.submit(created.id, OWNER_ID_A);
            assert.fail('expected BusinessIncompleteForSubmitError');
        } catch (err) {
            assert.ok(err instanceof BusinessIncompleteForSubmitError);
            assert.deepStrictEqual(
                [...err.missing].sort(),
                ['city', 'description', 'name'],
            );
        }
    });

    it('rejects submission from a non-DRAFT status', async () => {
        const { service, repo } = buildService();
        const created = await service.create(OWNER_ID_A, makeCreateInput());
        await repo.setStatus(created.id, 'APPROVED');

        await assert.rejects(
            () => service.submit(created.id, OWNER_ID_A),
            (err: unknown) =>
                err instanceof BusinessInvalidTransitionError &&
                err.from === 'APPROVED' &&
                err.to === 'PENDING_REVIEW',
        );
    });

    it('refuses non-owner with BusinessNotOwnedError', async () => {
        const { service } = buildService();
        const created = await service.create(OWNER_ID_A, makeCreateInput());

        await assert.rejects(
            () => service.submit(created.id, OWNER_ID_B),
            BusinessNotOwnedError,
        );
    });

    it('throws BusinessNotFoundError for unknown id', async () => {
        const { service } = buildService();

        await assert.rejects(
            () =>
                service.submit(
                    '99999999-9999-9999-9999-999999999999',
                    OWNER_ID_A,
                ),
            BusinessNotFoundError,
        );
    });
});

// ---------------------------------------------------------------------------
// listPublic — status filter, individual filters, sort, pagination
// ---------------------------------------------------------------------------

describe('BusinessService.listPublic — status filter', () => {
    it('only returns APPROVED rows', async () => {
        const { service, repo } = buildService();
        repo.seed(makeBusiness({ id: 'a', status: 'APPROVED' }));
        repo.seed(makeBusiness({ id: 'b', status: 'DRAFT' }));
        repo.seed(makeBusiness({ id: 'c', status: 'PENDING_REVIEW' }));
        repo.seed(makeBusiness({ id: 'd', status: 'REJECTED' }));
        repo.seed(makeBusiness({ id: 'e', status: 'SUSPENDED' }));

        const page = await service.listPublic({});

        assert.strictEqual(page.items.length, 1);
        assert.strictEqual(page.items[0]?.id, 'a');
        assert.strictEqual(page.nextCursor, null);
    });
});

describe('BusinessService.listPublic — filters', () => {
    it('filters by category', async () => {
        const { service, repo } = buildService();
        const otherCategory = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        repo.seed(makeBusiness({ id: 'a', categoryId: CATEGORY_ID }));
        repo.seed(makeBusiness({ id: 'b', categoryId: otherCategory }));

        const page = await service.listPublic({ categoryId: CATEGORY_ID });

        assert.deepStrictEqual(
            page.items.map((b) => b.id).sort(),
            ['a'],
        );
    });

    it('filters by city case-insensitively', async () => {
        const { service, repo } = buildService();
        repo.seed(makeBusiness({ id: 'a', city: 'Addis Ababa' }));
        repo.seed(makeBusiness({ id: 'b', city: 'Hawassa' }));

        const page = await service.listPublic({ city: 'addis ababa' });

        assert.strictEqual(page.items.length, 1);
        assert.strictEqual(page.items[0]?.id, 'a');
    });

    it('applies partial-name query', async () => {
        const { service, repo } = buildService();
        repo.seed(makeBusiness({ id: 'a', name: 'Sunrise Salon' }));
        repo.seed(makeBusiness({ id: 'b', name: 'Moonset Spa' }));

        const page = await service.listPublic({ query: 'salon' });

        assert.strictEqual(page.items.length, 1);
        assert.strictEqual(page.items[0]?.id, 'a');
    });

    it('applies ratingMin filter', async () => {
        const { service, repo } = buildService();
        repo.seed(makeBusiness({ id: 'low', ratingAvg: 3.0 }));
        repo.seed(makeBusiness({ id: 'mid', ratingAvg: 4.0 }));
        repo.seed(makeBusiness({ id: 'high', ratingAvg: 4.8 }));

        const page = await service.listPublic({ ratingMin: 4.0 });

        assert.deepStrictEqual(
            page.items.map((b) => b.id).sort(),
            ['high', 'mid'],
        );
    });

    it('combines multiple filters with AND', async () => {
        const { service, repo } = buildService();
        repo.seed(makeBusiness({ id: 'match', city: 'X', ratingAvg: 5 }));
        repo.seed(makeBusiness({ id: 'low-rating', city: 'X', ratingAvg: 1 }));
        repo.seed(makeBusiness({ id: 'wrong-city', city: 'Y', ratingAvg: 5 }));

        const page = await service.listPublic({ city: 'X', ratingMin: 4 });

        assert.deepStrictEqual(page.items.map((b) => b.id), ['match']);
    });
});

describe('BusinessService.listPublic — sort order', () => {
    it('orders by featured_until DESC NULLS LAST, then rating, then created, then id', async () => {
        const { service, repo } = buildService();
        const t0 = new Date('2026-01-01T00:00:00.000Z');
        const t1 = new Date('2026-02-01T00:00:00.000Z');
        const t2 = new Date('2026-03-01T00:00:00.000Z');
        const future = new Date('2027-01-01T00:00:00.000Z');

        // Featured (newest expiry first)
        repo.seed(makeBusiness({ id: 'b-featured', featuredUntil: future, ratingAvg: 1, createdAt: t0 }));
        // Non-featured high rating
        repo.seed(makeBusiness({ id: 'a-high-rating', ratingAvg: 5, createdAt: t0 }));
        // Same rating, newer createdAt wins
        repo.seed(makeBusiness({ id: 'c-newer', ratingAvg: 4, createdAt: t2 }));
        repo.seed(makeBusiness({ id: 'd-older', ratingAvg: 4, createdAt: t1 }));

        const page = await service.listPublic({});

        assert.deepStrictEqual(
            page.items.map((b) => b.id),
            ['b-featured', 'a-high-rating', 'c-newer', 'd-older'],
        );
    });
});

describe('BusinessService.listPublic — cursor pagination', () => {
    it('roundtrips a multi-page listing without overlap or gaps', async () => {
        const { service, repo } = buildService();

        // Five APPROVED businesses with distinct sort tuples.
        const ids = ['001', '002', '003', '004', '005'];
        ids.forEach((id, idx) => {
            repo.seed(
                makeBusiness({
                    id,
                    ratingAvg: 5 - idx, // 5, 4, 3, 2, 1
                    createdAt: new Date(`2026-01-0${idx + 1}T00:00:00.000Z`),
                }),
            );
        });

        const page1 = await service.listPublic({}, undefined, 2);
        assert.strictEqual(page1.items.length, 2);
        assert.ok(page1.nextCursor !== null, 'page1 nextCursor should be set');

        const page2 = await service.listPublic({}, page1.nextCursor!, 2);
        assert.strictEqual(page2.items.length, 2);
        assert.ok(page2.nextCursor !== null, 'page2 nextCursor should be set');

        const page3 = await service.listPublic({}, page2.nextCursor!, 2);
        assert.strictEqual(page3.items.length, 1);
        assert.strictEqual(page3.nextCursor, null, 'page3 nextCursor should be null');

        // All five ids appear, in DESC-rating order, no overlap.
        const seen = [...page1.items, ...page2.items, ...page3.items].map((b) => b.id);
        assert.deepStrictEqual(seen, ['001', '002', '003', '004', '005']);
    });

    it('throws InvalidCursorError for an unparseable cursor', async () => {
        const { service } = buildService();

        await assert.rejects(
            () => service.listPublic({}, 'not-a-base64-cursor!!!'),
            InvalidCursorError,
        );
    });

    it('throws InvalidCursorError for a structurally invalid cursor', async () => {
        const { service } = buildService();
        // Valid base64url but wrong shape (`sortKey` missing).
        const badPayload = Buffer.from(
            JSON.stringify({ id: 'abc' }),
            'utf8',
        ).toString('base64url');

        await assert.rejects(
            () => service.listPublic({}, badPayload),
            InvalidCursorError,
        );
    });
});

// ---------------------------------------------------------------------------
// findApproved + getByOwner
// ---------------------------------------------------------------------------

describe('BusinessService.findApproved', () => {
    it('returns the row when APPROVED', async () => {
        const { service, repo } = buildService();
        repo.seed(makeBusiness({ id: 'live', status: 'APPROVED' }));

        const result = await service.findApproved('live');
        assert.strictEqual(result?.id, 'live');
    });

    it('returns null for a non-APPROVED row', async () => {
        const { service, repo } = buildService();
        repo.seed(makeBusiness({ id: 'pending', status: 'PENDING_REVIEW' }));

        assert.strictEqual(await service.findApproved('pending'), null);
    });

    it('returns null for an unknown id', async () => {
        const { service } = buildService();
        assert.strictEqual(await service.findApproved('nope'), null);
    });
});

describe('BusinessService.getByOwner', () => {
    it('returns the owner\'s business regardless of status', async () => {
        const { service, repo } = buildService();
        repo.seed(makeBusiness({ id: 'draft', ownerUserId: OWNER_ID_A, status: 'DRAFT' }));

        const result = await service.getByOwner(OWNER_ID_A);

        assert.strictEqual(result?.id, 'draft');
        assert.strictEqual(result?.status, 'DRAFT');
    });

    it('returns null when the owner has no business', async () => {
        const { service } = buildService();
        assert.strictEqual(await service.getByOwner(OWNER_ID_A), null);
    });
});
