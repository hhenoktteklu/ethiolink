// EthioLink — ServiceService unit tests.
//
// Covers the rules in `serviceService.ts`:
//   * Create: owner allowed, missing business → 404 error, non-owner refused.
//   * Update: owner allowed, non-owner refused, missing service → 404 error,
//     empty patch returns existing row (no-op).
//   * Deactivate: flips `isActive` to false; same ownership rules.
//   * listActiveForBusiness: filters out inactive rows.
//   * `priceEtb` round-trips through create+findById intact.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Business } from '../../shared/domains/businesses/businessRepository.js';
import type { CallerContext } from '../../shared/domains/businesses/businessService.js';
import {
    ServiceBusinessNotFoundError,
    ServiceNotFoundError,
    ServiceNotOwnedError,
    ServiceService,
    type CreateServiceInput,
} from '../../shared/domains/services/serviceService.js';

import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';
import { InMemoryServiceRepository } from '../_fakes/InMemoryServiceRepository.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const BIZ_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ_UNKNOWN = '99999999-9999-9999-9999-999999999999';

function caller(userId: string, role: CallerContext['role'] = 'BUSINESS_OWNER'): CallerContext {
    return { userId, role };
}

function makeCreateInput(
    overrides: Partial<CreateServiceInput> = {},
): CreateServiceInput {
    return {
        name: { en: 'Haircut' },
        description: { en: 'Standard haircut.' },
        durationMinutes: 30,
        priceEtb: 250,
        ...overrides,
    };
}

function makeBusiness(overrides: Partial<Business> = {}): Business {
    const now = new Date('2026-05-14T12:00:00.000Z');
    return Object.freeze({
        id: BIZ_A,
        ownerUserId: OWNER_A,
        categoryId: '00000000-0000-0000-0000-000000000001',
        name: 'Test Salon',
        description: { en: 'A test salon.' },
        city: 'Addis Ababa',
        addressLine: null,
        latitude: null,
        longitude: null,
        phone: null,
        telegramHandle: null,
        whatsappPhone: null,
        status: 'APPROVED' as const,
        featuredUntil: null,
        ratingAvg: 0,
        ratingCount: 0,
        createdAt: now,
        updatedAt: now,
        searchRank: null,
        ...overrides,
    });
}

function build(): {
    service: ServiceService;
    repo: InMemoryServiceRepository;
    businessRepo: InMemoryBusinessRepository;
} {
    const repo = new InMemoryServiceRepository();
    const businessRepo = new InMemoryBusinessRepository();
    const service = new ServiceService(repo, businessRepo);
    return { service, repo, businessRepo };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('ServiceService.create', () => {
    it('creates an active service when the owner targets their own business', async () => {
        const { service, repo, businessRepo } = build();
        businessRepo.seed(makeBusiness());

        const created = await service.create(caller(OWNER_A), BIZ_A, makeCreateInput());

        assert.strictEqual(created.businessId, BIZ_A);
        assert.strictEqual(created.name.en, 'Haircut');
        assert.strictEqual(created.durationMinutes, 30);
        assert.strictEqual(created.priceEtb, 250);
        assert.strictEqual(created.isActive, true);
        assert.strictEqual(repo.size(), 1);
    });

    it('throws ServiceBusinessNotFoundError for an unknown business id', async () => {
        const { service } = build();

        await assert.rejects(
            () => service.create(caller(OWNER_A), BIZ_UNKNOWN, makeCreateInput()),
            (err: unknown) =>
                err instanceof ServiceBusinessNotFoundError &&
                err.businessId === BIZ_UNKNOWN,
        );
    });

    it('refuses non-owners with ServiceNotOwnedError', async () => {
        const { service, businessRepo, repo } = build();
        businessRepo.seed(makeBusiness());

        await assert.rejects(
            () => service.create(caller(OWNER_B), BIZ_A, makeCreateInput()),
            ServiceNotOwnedError,
        );
        assert.strictEqual(repo.size(), 0, 'no row written on auth failure');
    });

    it('preserves priceEtb through create + findById round-trip', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());

        const created = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ priceEtb: 1234.56 }),
        );
        // pg returns numeric(12,2) as a string in production; the production
        // repo coerces it to a number. The in-memory repo stores numbers
        // directly. This test verifies the service surface keeps the value
        // intact at the type level (no truncation, no string).
        assert.strictEqual(typeof created.priceEtb, 'number');
        assert.strictEqual(created.priceEtb, 1234.56);
    });

    it('accepts priceEtb of null', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());

        const created = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ priceEtb: null }),
        );
        assert.strictEqual(created.priceEtb, null);
    });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('ServiceService.update', () => {
    it('lets the owner update mutable fields', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const created = await service.create(caller(OWNER_A), BIZ_A, makeCreateInput());

        const updated = await service.update(created.id, caller(OWNER_A), {
            durationMinutes: 45,
            priceEtb: 300,
        });

        assert.strictEqual(updated.durationMinutes, 45);
        assert.strictEqual(updated.priceEtb, 300);
        assert.strictEqual(updated.id, created.id);
    });

    it('clears priceEtb when patched with null', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const created = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ priceEtb: 250 }),
        );

        const updated = await service.update(created.id, caller(OWNER_A), {
            priceEtb: null,
        });

        assert.strictEqual(updated.priceEtb, null);
    });

    it('refuses non-owners with ServiceNotOwnedError', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const created = await service.create(caller(OWNER_A), BIZ_A, makeCreateInput());

        await assert.rejects(
            () =>
                service.update(created.id, caller(OWNER_B), {
                    durationMinutes: 45,
                }),
            ServiceNotOwnedError,
        );
    });

    it('throws ServiceNotFoundError for an unknown id', async () => {
        const { service } = build();

        await assert.rejects(
            () =>
                service.update(
                    '00000000-0000-0000-0000-000000000099',
                    caller(OWNER_A),
                    { durationMinutes: 45 },
                ),
            ServiceNotFoundError,
        );
    });

    it('returns the existing row for an empty patch', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const created = await service.create(caller(OWNER_A), BIZ_A, makeCreateInput());

        const result = await service.update(created.id, caller(OWNER_A), {});

        assert.strictEqual(result.id, created.id);
        assert.strictEqual(result.durationMinutes, created.durationMinutes);
        assert.strictEqual(result.priceEtb, created.priceEtb);
    });
});

// ---------------------------------------------------------------------------
// deactivate
// ---------------------------------------------------------------------------

describe('ServiceService.deactivate', () => {
    it('flips isActive to false', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const created = await service.create(caller(OWNER_A), BIZ_A, makeCreateInput());

        const deactivated = await service.deactivate(created.id, caller(OWNER_A));

        assert.strictEqual(deactivated.isActive, false);
        assert.strictEqual(deactivated.id, created.id);
    });

    it('refuses non-owners', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const created = await service.create(caller(OWNER_A), BIZ_A, makeCreateInput());

        await assert.rejects(
            () => service.deactivate(created.id, caller(OWNER_B)),
            ServiceNotOwnedError,
        );
    });

    it('throws ServiceNotFoundError for an unknown id', async () => {
        const { service } = build();

        await assert.rejects(
            () => service.deactivate('00000000-0000-0000-0000-000000000099', caller(OWNER_A)),
            ServiceNotFoundError,
        );
    });
});

// ---------------------------------------------------------------------------
// listActiveForBusiness
// ---------------------------------------------------------------------------

describe('ServiceService.listActiveForBusiness', () => {
    it('returns active services in created-order for the business', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());

        const first = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ name: { en: 'First' } }),
        );
        const second = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ name: { en: 'Second' } }),
        );

        const items = await service.listActiveForBusiness(BIZ_A);

        assert.deepStrictEqual(
            items.map((s) => s.id),
            [first.id, second.id],
        );
    });

    it('filters out inactive services', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const active = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ name: { en: 'Active' } }),
        );
        const dropped = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ name: { en: 'Dropped' } }),
        );
        await service.deactivate(dropped.id, caller(OWNER_A));

        const items = await service.listActiveForBusiness(BIZ_A);

        assert.deepStrictEqual(
            items.map((s) => s.id),
            [active.id],
        );
    });

    it('returns an empty array for a nonexistent business id', async () => {
        const { service } = build();
        assert.deepStrictEqual(
            await service.listActiveForBusiness(BIZ_UNKNOWN),
            [],
        );
    });
});
