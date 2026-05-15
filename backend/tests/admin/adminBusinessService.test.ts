// EthioLink — AdminBusinessService unit tests.
//
// Exercises the headline Phase 5 service that closes MVP-done item
// #3 ("An admin can approve a business and feature a listing from
// the web dashboard"). Coverage matches the brief in
// PHASE_5_ADMIN_DASHBOARD.md:
//
//   * Happy paths for approve / reject / suspend / setFeaturedUntil
//     (both set and clear), each verifying the business status / column
//     change AND the audit-row contents.
//   * Authorization — non-ADMIN callers refused with `AdminForbiddenError`.
//   * Not-found — missing business id → `AdminBusinessNotFoundError`.
//   * Invalid transitions — every method refuses from the wrong
//     fromStatus with `AdminBusinessInvalidTransitionError`.
//   * Audit invariant — every successful action writes exactly one
//     `admin_actions` row; every failed action writes zero. The audit
//     row carries the right `adminUserId`, `action`, `targetType`,
//     `targetId`, and `notes`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UserRole } from '../../shared/adapters/auth/AuthProvider.js';
import {
    AdminBusinessInvalidTransitionError,
    AdminBusinessNotFoundError,
    AdminBusinessService,
    AdminForbiddenError,
    type AdminCallerContext,
} from '../../shared/domains/admin/adminBusinessService.js';
import type {
    Business,
    BusinessStatus,
} from '../../shared/domains/businesses/businessRepository.js';

import { InMemoryAdminActionRepository } from '../_fakes/InMemoryAdminActionRepository.js';
import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '22222222-2222-2222-2222-222222222222';
const CUSTOMER_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_ADMIN_ID = '44444444-4444-4444-4444-444444444444';

const BUSINESS_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MISSING_BUSINESS_ID = '99999999-9999-9999-9999-999999999999';

const TARGET_TYPE = 'business_profile' as const;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function caller(
    userId: string,
    role: UserRole = 'ADMIN',
): AdminCallerContext {
    return { userId, role };
}

function makeBusiness(overrides: Partial<Business> = {}): Business {
    const now = new Date('2026-05-14T12:00:00.000Z');
    return Object.freeze({
        id: BUSINESS_ID,
        ownerUserId: OWNER_ID,
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
        status: 'PENDING_REVIEW' as BusinessStatus,
        featuredUntil: null,
        ratingAvg: 0,
        ratingCount: 0,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    });
}

interface Env {
    readonly service: AdminBusinessService;
    readonly businessRepo: InMemoryBusinessRepository;
    readonly actionRepo: InMemoryAdminActionRepository;
}

function build(): Env {
    const businessRepo = new InMemoryBusinessRepository();
    const actionRepo = new InMemoryAdminActionRepository();
    const service = new AdminBusinessService(businessRepo, actionRepo);
    return { service, businessRepo, actionRepo };
}

// ---------------------------------------------------------------------------
// approveBusiness — happy path + audit contents
// ---------------------------------------------------------------------------

describe('AdminBusinessService.approveBusiness', () => {
    it('moves PENDING_REVIEW → APPROVED and records one APPROVE_BUSINESS row', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'PENDING_REVIEW' }));

        const updated = await env.service.approveBusiness(
            BUSINESS_ID,
            caller(ADMIN_ID),
            'Looks good.',
        );

        assert.strictEqual(updated.status, 'APPROVED');
        assert.strictEqual(env.actionRepo.size(), 1);

        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, BUSINESS_ID);
        assert.ok(row);
        assert.strictEqual(row.adminUserId, ADMIN_ID);
        assert.strictEqual(row.action, 'APPROVE_BUSINESS');
        assert.strictEqual(row.targetType, TARGET_TYPE);
        assert.strictEqual(row.targetId, BUSINESS_ID);
        assert.strictEqual(row.notes, 'Looks good.');
    });

    it('accepts a missing `notes` argument and records `null`', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'PENDING_REVIEW' }));

        await env.service.approveBusiness(BUSINESS_ID, caller(ADMIN_ID));
        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, BUSINESS_ID);
        assert.ok(row);
        assert.strictEqual(row.notes, null);
    });

    it('refuses an already-APPROVED business with InvalidTransitionError', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'APPROVED' }));

        await assert.rejects(
            () => env.service.approveBusiness(BUSINESS_ID, caller(ADMIN_ID)),
            (err: unknown) => {
                assert.ok(err instanceof AdminBusinessInvalidTransitionError);
                assert.strictEqual(err.fromStatus, 'APPROVED');
                assert.strictEqual(err.attemptedAction, 'APPROVE_BUSINESS');
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// rejectBusiness — happy path + audit contents
// ---------------------------------------------------------------------------

describe('AdminBusinessService.rejectBusiness', () => {
    it('moves PENDING_REVIEW → REJECTED and records one REJECT_BUSINESS row', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'PENDING_REVIEW' }));

        const updated = await env.service.rejectBusiness(
            BUSINESS_ID,
            caller(ADMIN_ID),
            'Photos missing.',
        );

        assert.strictEqual(updated.status, 'REJECTED');
        assert.strictEqual(env.actionRepo.size(), 1);

        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, BUSINESS_ID);
        assert.ok(row);
        assert.strictEqual(row.action, 'REJECT_BUSINESS');
        assert.strictEqual(row.notes, 'Photos missing.');
        assert.strictEqual(row.adminUserId, ADMIN_ID);
        assert.strictEqual(row.targetType, TARGET_TYPE);
        assert.strictEqual(row.targetId, BUSINESS_ID);
    });

    it('refuses an APPROVED business with InvalidTransitionError', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'APPROVED' }));

        await assert.rejects(
            () => env.service.rejectBusiness(BUSINESS_ID, caller(ADMIN_ID)),
            (err: unknown) => {
                assert.ok(err instanceof AdminBusinessInvalidTransitionError);
                assert.strictEqual(err.attemptedAction, 'REJECT_BUSINESS');
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// suspendBusiness — APPROVED + PENDING_REVIEW both accepted
// ---------------------------------------------------------------------------

describe('AdminBusinessService.suspendBusiness', () => {
    it('moves APPROVED → SUSPENDED and records one SUSPEND_BUSINESS row', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'APPROVED' }));

        const updated = await env.service.suspendBusiness(
            BUSINESS_ID,
            caller(ADMIN_ID),
            'Complaints filed.',
        );

        assert.strictEqual(updated.status, 'SUSPENDED');
        assert.strictEqual(env.actionRepo.size(), 1);

        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, BUSINESS_ID);
        assert.ok(row);
        assert.strictEqual(row.action, 'SUSPEND_BUSINESS');
        assert.strictEqual(row.notes, 'Complaints filed.');
    });

    it('moves PENDING_REVIEW → SUSPENDED', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'PENDING_REVIEW' }));

        const updated = await env.service.suspendBusiness(
            BUSINESS_ID,
            caller(ADMIN_ID),
        );
        assert.strictEqual(updated.status, 'SUSPENDED');
        assert.strictEqual(env.actionRepo.size(), 1);
    });

    it('refuses a SUSPENDED business with InvalidTransitionError', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'SUSPENDED' }));

        await assert.rejects(
            () => env.service.suspendBusiness(BUSINESS_ID, caller(ADMIN_ID)),
            (err: unknown) => {
                assert.ok(err instanceof AdminBusinessInvalidTransitionError);
                assert.strictEqual(err.fromStatus, 'SUSPENDED');
                assert.strictEqual(err.attemptedAction, 'SUSPEND_BUSINESS');
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });

    it('refuses a DRAFT business with InvalidTransitionError', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'DRAFT' }));

        await assert.rejects(
            () => env.service.suspendBusiness(BUSINESS_ID, caller(ADMIN_ID)),
            AdminBusinessInvalidTransitionError,
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// setFeaturedUntil — feature + unfeature, APPROVED only
// ---------------------------------------------------------------------------

describe('AdminBusinessService.setFeaturedUntil — feature', () => {
    it('sets featuredUntil on an APPROVED business and records FEATURE_BUSINESS', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'APPROVED' }));
        const until = new Date('2026-06-30T00:00:00.000Z');

        const updated = await env.service.setFeaturedUntil(
            BUSINESS_ID,
            caller(ADMIN_ID),
            until,
            'Featured for June campaign.',
        );

        assert.strictEqual(updated.status, 'APPROVED'); // unchanged
        assert.ok(updated.featuredUntil instanceof Date);
        assert.strictEqual(
            updated.featuredUntil?.toISOString(),
            until.toISOString(),
        );

        assert.strictEqual(env.actionRepo.size(), 1);
        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, BUSINESS_ID);
        assert.ok(row);
        assert.strictEqual(row.action, 'FEATURE_BUSINESS');
        assert.strictEqual(row.notes, 'Featured for June campaign.');
        assert.strictEqual(row.adminUserId, ADMIN_ID);
        assert.strictEqual(row.targetType, TARGET_TYPE);
        assert.strictEqual(row.targetId, BUSINESS_ID);
    });

    it('refuses a non-APPROVED business with InvalidTransitionError', async () => {
        for (const status of ['DRAFT', 'PENDING_REVIEW', 'REJECTED', 'SUSPENDED'] as const) {
            const env = build();
            env.businessRepo.seed(makeBusiness({ status }));

            await assert.rejects(
                () =>
                    env.service.setFeaturedUntil(
                        BUSINESS_ID,
                        caller(ADMIN_ID),
                        new Date('2026-06-30T00:00:00.000Z'),
                    ),
                (err: unknown) => {
                    assert.ok(err instanceof AdminBusinessInvalidTransitionError);
                    assert.strictEqual(err.fromStatus, status);
                    assert.strictEqual(err.attemptedAction, 'FEATURE_BUSINESS');
                    return true;
                },
            );
            assert.strictEqual(env.actionRepo.size(), 0);
        }
    });
});

describe('AdminBusinessService.setFeaturedUntil — unfeature', () => {
    it('clears featuredUntil and records UNFEATURE_BUSINESS', async () => {
        const env = build();
        env.businessRepo.seed(
            makeBusiness({
                status: 'APPROVED',
                featuredUntil: new Date('2026-06-30T00:00:00.000Z'),
            }),
        );

        const updated = await env.service.setFeaturedUntil(
            BUSINESS_ID,
            caller(ADMIN_ID),
            null,
            'Campaign ended.',
        );

        assert.strictEqual(updated.featuredUntil, null);
        assert.strictEqual(env.actionRepo.size(), 1);
        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, BUSINESS_ID);
        assert.ok(row);
        assert.strictEqual(row.action, 'UNFEATURE_BUSINESS');
        assert.strictEqual(row.notes, 'Campaign ended.');
    });

    it('refuses unfeature on a non-APPROVED business', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'SUSPENDED' }));

        await assert.rejects(
            () =>
                env.service.setFeaturedUntil(
                    BUSINESS_ID,
                    caller(ADMIN_ID),
                    null,
                ),
            (err: unknown) => {
                assert.ok(err instanceof AdminBusinessInvalidTransitionError);
                assert.strictEqual(err.attemptedAction, 'UNFEATURE_BUSINESS');
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// Authorization — non-ADMIN callers
// ---------------------------------------------------------------------------

describe('AdminBusinessService — authorization', () => {
    const NON_ADMIN_ROLES: UserRole[] = ['CUSTOMER', 'BUSINESS_OWNER'];

    for (const role of NON_ADMIN_ROLES) {
        it(`refuses approveBusiness when caller is ${role}`, async () => {
            const env = build();
            env.businessRepo.seed(makeBusiness({ status: 'PENDING_REVIEW' }));

            await assert.rejects(
                () =>
                    env.service.approveBusiness(
                        BUSINESS_ID,
                        caller(CUSTOMER_ID, role),
                    ),
                AdminForbiddenError,
            );

            // Mutation didn't happen.
            const after = await env.businessRepo.findById(BUSINESS_ID);
            assert.ok(after);
            assert.strictEqual(after.status, 'PENDING_REVIEW');
            // Audit row didn't happen.
            assert.strictEqual(env.actionRepo.size(), 0);
        });
    }

    it('refuses rejectBusiness for a CUSTOMER caller', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'PENDING_REVIEW' }));

        await assert.rejects(
            () =>
                env.service.rejectBusiness(
                    BUSINESS_ID,
                    caller(CUSTOMER_ID, 'CUSTOMER'),
                ),
            AdminForbiddenError,
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });

    it('refuses suspendBusiness for a BUSINESS_OWNER caller', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'APPROVED' }));

        await assert.rejects(
            () =>
                env.service.suspendBusiness(
                    BUSINESS_ID,
                    caller(OWNER_ID, 'BUSINESS_OWNER'),
                ),
            AdminForbiddenError,
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });

    it('refuses setFeaturedUntil for a CUSTOMER caller', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'APPROVED' }));

        await assert.rejects(
            () =>
                env.service.setFeaturedUntil(
                    BUSINESS_ID,
                    caller(CUSTOMER_ID, 'CUSTOMER'),
                    new Date('2026-06-30T00:00:00.000Z'),
                ),
            AdminForbiddenError,
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// Not-found
// ---------------------------------------------------------------------------

describe('AdminBusinessService — missing business', () => {
    it('approveBusiness throws AdminBusinessNotFoundError for an unknown id', async () => {
        const env = build();

        await assert.rejects(
            () =>
                env.service.approveBusiness(
                    MISSING_BUSINESS_ID,
                    caller(ADMIN_ID),
                ),
            (err: unknown) => {
                assert.ok(err instanceof AdminBusinessNotFoundError);
                assert.strictEqual(err.businessId, MISSING_BUSINESS_ID);
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });

    it('setFeaturedUntil throws AdminBusinessNotFoundError for an unknown id', async () => {
        const env = build();

        await assert.rejects(
            () =>
                env.service.setFeaturedUntil(
                    MISSING_BUSINESS_ID,
                    caller(ADMIN_ID),
                    new Date('2026-06-30T00:00:00.000Z'),
                ),
            AdminBusinessNotFoundError,
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// Audit invariant — full surface
// ---------------------------------------------------------------------------

describe('AdminBusinessService — audit-row invariant', () => {
    it('writes one row per successful action, attributed to the calling admin', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'PENDING_REVIEW' }));

        await env.service.approveBusiness(BUSINESS_ID, caller(ADMIN_ID), 'a');
        await env.service.setFeaturedUntil(
            BUSINESS_ID,
            caller(OTHER_ADMIN_ID),
            new Date('2026-07-01T00:00:00.000Z'),
            'b',
        );

        assert.strictEqual(env.actionRepo.size(), 2);
        const rows = env.actionRepo.rowsForTarget(TARGET_TYPE, BUSINESS_ID);
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0]?.action, 'APPROVE_BUSINESS');
        assert.strictEqual(rows[0]?.adminUserId, ADMIN_ID);
        assert.strictEqual(rows[1]?.action, 'FEATURE_BUSINESS');
        assert.strictEqual(rows[1]?.adminUserId, OTHER_ADMIN_ID);

        // Per-admin slicing also reflects the split.
        assert.strictEqual(env.actionRepo.rowsByAdmin(ADMIN_ID).length, 1);
        assert.strictEqual(env.actionRepo.rowsByAdmin(OTHER_ADMIN_ID).length, 1);
    });

    it('writes zero rows when validation fails before any mutation', async () => {
        const env = build();
        env.businessRepo.seed(makeBusiness({ status: 'APPROVED' }));

        // Wrong status for approve.
        await assert.rejects(
            () => env.service.approveBusiness(BUSINESS_ID, caller(ADMIN_ID)),
            AdminBusinessInvalidTransitionError,
        );
        // Wrong role for any action.
        await assert.rejects(
            () =>
                env.service.suspendBusiness(
                    BUSINESS_ID,
                    caller(CUSTOMER_ID, 'CUSTOMER'),
                ),
            AdminForbiddenError,
        );
        // Missing business.
        await assert.rejects(
            () =>
                env.service.approveBusiness(
                    MISSING_BUSINESS_ID,
                    caller(ADMIN_ID),
                ),
            AdminBusinessNotFoundError,
        );

        assert.strictEqual(env.actionRepo.size(), 0);
    });
});
