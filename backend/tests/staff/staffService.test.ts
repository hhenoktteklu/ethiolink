// EthioLink — StaffService unit tests.
//
// Mirrors the services-domain test shape (the staff domain is the same
// pattern with simpler fields). Coverage:
//   * Create: owner allowed, missing business → 404 error, non-owner refused.
//   * Update: owner allowed, non-owner refused, missing staff → 404 error,
//     empty patch returns existing row, `role` cleared with null.
//   * Deactivate: flips `isActive` to false; same ownership rules.
//   * listActiveForBusiness: filters out inactive rows.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Business } from '../../shared/domains/businesses/businessRepository.js';
import type { CallerContext } from '../../shared/domains/businesses/businessService.js';
import {
    StaffBusinessNotFoundError,
    StaffNotFoundError,
    StaffNotOwnedError,
    StaffService,
    type CreateStaffInput,
} from '../../shared/domains/staff/staffService.js';

import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';
import { InMemoryStaffRepository } from '../_fakes/InMemoryStaffRepository.js';

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
    overrides: Partial<CreateStaffInput> = {},
): CreateStaffInput {
    return {
        displayName: 'Helen',
        role: 'Senior Stylist',
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
        ...overrides,
    });
}

function build(): {
    service: StaffService;
    repo: InMemoryStaffRepository;
    businessRepo: InMemoryBusinessRepository;
} {
    const repo = new InMemoryStaffRepository();
    const businessRepo = new InMemoryBusinessRepository();
    const service = new StaffService(repo, businessRepo);
    return { service, repo, businessRepo };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('StaffService.create', () => {
    it('creates an active staff member when the owner targets their own business', async () => {
        const { service, repo, businessRepo } = build();
        businessRepo.seed(makeBusiness());

        const created = await service.create(caller(OWNER_A), BIZ_A, makeCreateInput());

        assert.strictEqual(created.businessId, BIZ_A);
        assert.strictEqual(created.displayName, 'Helen');
        assert.strictEqual(created.role, 'Senior Stylist');
        assert.strictEqual(created.isActive, true);
        assert.strictEqual(repo.size(), 1);
    });

    it('accepts null role on create', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());

        const created = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ role: null }),
        );
        assert.strictEqual(created.role, null);
    });

    it('throws StaffBusinessNotFoundError for an unknown business id', async () => {
        const { service } = build();

        await assert.rejects(
            () => service.create(caller(OWNER_A), BIZ_UNKNOWN, makeCreateInput()),
            (err: unknown) =>
                err instanceof StaffBusinessNotFoundError &&
                err.businessId === BIZ_UNKNOWN,
        );
    });

    it('refuses non-owners with StaffNotOwnedError', async () => {
        const { service, businessRepo, repo } = build();
        businessRepo.seed(makeBusiness());

        await assert.rejects(
            () => service.create(caller(OWNER_B), BIZ_A, makeCreateInput()),
            StaffNotOwnedError,
        );
        assert.strictEqual(repo.size(), 0, 'no row written on auth failure');
    });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('StaffService.update', () => {
    it('lets the owner update mutable fields', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const created = await service.create(caller(OWNER_A), BIZ_A, makeCreateInput());

        const updated = await service.update(created.id, caller(OWNER_A), {
            displayName: 'Helen T.',
            role: 'Master Stylist',
        });

        assert.strictEqual(updated.displayName, 'Helen T.');
        assert.strictEqual(updated.role, 'Master Stylist');
        assert.strictEqual(updated.id, created.id);
    });

    it('clears role when patched with null', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const created = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ role: 'Stylist' }),
        );

        const updated = await service.update(created.id, caller(OWNER_A), {
            role: null,
        });

        assert.strictEqual(updated.role, null);
    });

    it('refuses non-owners with StaffNotOwnedError', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const created = await service.create(caller(OWNER_A), BIZ_A, makeCreateInput());

        await assert.rejects(
            () =>
                service.update(created.id, caller(OWNER_B), {
                    displayName: 'Hijacked',
                }),
            StaffNotOwnedError,
        );
    });

    it('throws StaffNotFoundError for an unknown id', async () => {
        const { service } = build();

        await assert.rejects(
            () =>
                service.update(
                    '00000000-0000-0000-0000-000000000099',
                    caller(OWNER_A),
                    { displayName: 'Anything' },
                ),
            StaffNotFoundError,
        );
    });

    it('returns the existing row for an empty patch', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const created = await service.create(caller(OWNER_A), BIZ_A, makeCreateInput());

        const result = await service.update(created.id, caller(OWNER_A), {});

        assert.strictEqual(result.id, created.id);
        assert.strictEqual(result.displayName, created.displayName);
        assert.strictEqual(result.role, created.role);
    });
});

// ---------------------------------------------------------------------------
// deactivate
// ---------------------------------------------------------------------------

describe('StaffService.deactivate', () => {
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
            StaffNotOwnedError,
        );
    });

    it('throws StaffNotFoundError for an unknown id', async () => {
        const { service } = build();

        await assert.rejects(
            () => service.deactivate('00000000-0000-0000-0000-000000000099', caller(OWNER_A)),
            StaffNotFoundError,
        );
    });
});

// ---------------------------------------------------------------------------
// listActiveForBusiness
// ---------------------------------------------------------------------------

describe('StaffService.listActiveForBusiness', () => {
    it('returns active staff in created-order for the business', async () => {
        const { service, repo, businessRepo } = build();
        businessRepo.seed(makeBusiness());

        // Seed with explicit, distinct `createdAt` timestamps so the
        // `createdAt ASC, id ASC` listing order is deterministic. Going
        // through `service.create` was previously flaky here: two
        // back-to-back `new Date()` calls inside
        // `InMemoryStaffRepository.insert` can collapse onto the same
        // millisecond, after which the sort falls through to the random
        // UUID tiebreaker. Seeding directly pins the timestamps.
        const earlier = new Date('2026-05-14T08:00:00.000Z');
        const later = new Date('2026-05-14T08:00:01.000Z');
        const firstId = '00000000-0000-4000-8000-000000000001';
        const secondId = '00000000-0000-4000-8000-000000000002';
        repo.seed({
            id: firstId,
            businessId: BIZ_A,
            displayName: 'Aaron',
            role: null,
            isActive: true,
            createdAt: earlier,
            updatedAt: earlier,
        });
        repo.seed({
            id: secondId,
            businessId: BIZ_A,
            displayName: 'Bekele',
            role: null,
            isActive: true,
            createdAt: later,
            updatedAt: later,
        });

        const items = await service.listActiveForBusiness(BIZ_A);

        assert.deepStrictEqual(
            items.map((s) => s.id),
            [firstId, secondId],
        );
    });

    it('filters out inactive staff', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness());
        const active = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ displayName: 'Active' }),
        );
        const dropped = await service.create(
            caller(OWNER_A),
            BIZ_A,
            makeCreateInput({ displayName: 'Dropped' }),
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
