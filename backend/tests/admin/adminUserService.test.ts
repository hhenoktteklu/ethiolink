// EthioLink — AdminUserService unit tests.
//
// Mirrors the shape of `adminBusinessService.test.ts` against the
// user-suspension surface. Coverage matches the brief in
// PHASE_5_ADMIN_DASHBOARD.md:
//
//   * suspendUser ACTIVE → SUSPENDED (with and without `notes`).
//   * restoreUser SUSPENDED → ACTIVE (with and without `notes`).
//   * DELETED is terminal — both methods refuse with
//     `AdminUserInvalidTransitionError`.
//   * Non-ADMIN callers refused with `AdminForbiddenError`.
//   * Missing user id → `AdminUserNotFoundError`.
//   * Audit invariant: exactly one `admin_actions` row per
//     successful action with `targetType: 'user'` and the correct
//     `adminUserId` / `action` / `targetId` / `notes`. Zero rows on
//     failure.
//
// Uses `InMemoryUserRepository` unchanged — users are constructed
// via `upsertFromAuth` (the only production write path) plus
// `setStatus` to move them into SUSPENDED / DELETED for the test
// matrix. No new test-fake methods.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { UserRole } from '../../shared/adapters/auth/AuthProvider.js';
import {
    AdminForbiddenError,
    type AdminCallerContext,
} from '../../shared/domains/admin/adminBusinessService.js';
import {
    AdminUserInvalidTransitionError,
    AdminUserNotFoundError,
    AdminUserService,
} from '../../shared/domains/admin/adminUserService.js';
import type {
    User,
    UserStatus,
} from '../../shared/domains/users/userRepository.js';

import { InMemoryAdminActionRepository } from '../_fakes/InMemoryAdminActionRepository.js';
import { InMemoryUserRepository } from '../_fakes/InMemoryUserRepository.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ADMIN_ID = '22222222-2222-2222-2222-222222222222';
const NON_ADMIN_USER_ID = '33333333-3333-3333-3333-333333333333';
const MISSING_USER_ID = '99999999-9999-9999-9999-999999999999';

const TARGET_TYPE = 'user' as const;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function caller(
    userId: string,
    role: UserRole = 'ADMIN',
): AdminCallerContext {
    return { userId, role };
}

interface Env {
    readonly service: AdminUserService;
    readonly userRepo: InMemoryUserRepository;
    readonly actionRepo: InMemoryAdminActionRepository;
}

function build(): Env {
    const userRepo = new InMemoryUserRepository();
    const actionRepo = new InMemoryAdminActionRepository();
    const service = new AdminUserService(userRepo, actionRepo);
    return { service, userRepo, actionRepo };
}

/**
 * Seed a target user via the production write path. The fake's
 * `upsertFromAuth` always creates an ACTIVE row; we follow it with
 * `setStatus` when the test needs SUSPENDED or DELETED. Each call
 * uses a fresh `cognitoSub` so multiple seeded users coexist.
 */
async function seedUser(
    userRepo: InMemoryUserRepository,
    overrides: { status?: UserStatus; role?: UserRole } = {},
): Promise<User> {
    const user = await userRepo.upsertFromAuth({
        cognitoSub: `cog-${randomUUID()}`,
        email: 'target@example.com',
        phone: null,
        role: overrides.role ?? 'CUSTOMER',
        displayName: 'Target User',
    });
    if (overrides.status !== undefined && overrides.status !== 'ACTIVE') {
        return userRepo.setStatus(user.id, overrides.status);
    }
    return user;
}

// ---------------------------------------------------------------------------
// suspendUser
// ---------------------------------------------------------------------------

describe('AdminUserService.suspendUser', () => {
    it('moves ACTIVE → SUSPENDED and records one SUSPEND_USER row', async () => {
        const env = build();
        const target = await seedUser(env.userRepo, { status: 'ACTIVE' });

        const updated = await env.service.suspendUser(
            target.id,
            caller(ADMIN_ID),
            'Multiple complaints.',
        );

        assert.strictEqual(updated.status, 'SUSPENDED');
        assert.strictEqual(env.actionRepo.size(), 1);

        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, target.id);
        assert.ok(row);
        assert.strictEqual(row.adminUserId, ADMIN_ID);
        assert.strictEqual(row.action, 'SUSPEND_USER');
        assert.strictEqual(row.targetType, TARGET_TYPE);
        assert.strictEqual(row.targetId, target.id);
        assert.strictEqual(row.notes, 'Multiple complaints.');
    });

    it('accepts a missing `notes` argument and records `null`', async () => {
        const env = build();
        const target = await seedUser(env.userRepo, { status: 'ACTIVE' });

        await env.service.suspendUser(target.id, caller(ADMIN_ID));
        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, target.id);
        assert.ok(row);
        assert.strictEqual(row.notes, null);
    });

    it('refuses an already-SUSPENDED user with InvalidTransitionError', async () => {
        const env = build();
        const target = await seedUser(env.userRepo, { status: 'SUSPENDED' });

        await assert.rejects(
            () => env.service.suspendUser(target.id, caller(ADMIN_ID)),
            (err: unknown) => {
                assert.ok(err instanceof AdminUserInvalidTransitionError);
                assert.strictEqual(err.fromStatus, 'SUSPENDED');
                assert.strictEqual(err.attemptedAction, 'SUSPEND_USER');
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
        // State unchanged.
        const after = await env.userRepo.findById(target.id);
        assert.strictEqual(after?.status, 'SUSPENDED');
    });

    it('refuses a DELETED user (terminal) with InvalidTransitionError', async () => {
        const env = build();
        const target = await seedUser(env.userRepo, { status: 'DELETED' });

        await assert.rejects(
            () => env.service.suspendUser(target.id, caller(ADMIN_ID)),
            (err: unknown) => {
                assert.ok(err instanceof AdminUserInvalidTransitionError);
                assert.strictEqual(err.fromStatus, 'DELETED');
                assert.strictEqual(err.attemptedAction, 'SUSPEND_USER');
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// restoreUser
// ---------------------------------------------------------------------------

describe('AdminUserService.restoreUser', () => {
    it('moves SUSPENDED → ACTIVE and records one RESTORE_USER row', async () => {
        const env = build();
        const target = await seedUser(env.userRepo, { status: 'SUSPENDED' });

        const updated = await env.service.restoreUser(
            target.id,
            caller(ADMIN_ID),
            'Resolved complaint.',
        );

        assert.strictEqual(updated.status, 'ACTIVE');
        assert.strictEqual(env.actionRepo.size(), 1);

        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, target.id);
        assert.ok(row);
        assert.strictEqual(row.adminUserId, ADMIN_ID);
        assert.strictEqual(row.action, 'RESTORE_USER');
        assert.strictEqual(row.targetType, TARGET_TYPE);
        assert.strictEqual(row.targetId, target.id);
        assert.strictEqual(row.notes, 'Resolved complaint.');
    });

    it('accepts a missing `notes` argument and records `null`', async () => {
        const env = build();
        const target = await seedUser(env.userRepo, { status: 'SUSPENDED' });

        await env.service.restoreUser(target.id, caller(ADMIN_ID));
        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, target.id);
        assert.ok(row);
        assert.strictEqual(row.notes, null);
    });

    it('refuses an ACTIVE user with InvalidTransitionError', async () => {
        const env = build();
        const target = await seedUser(env.userRepo, { status: 'ACTIVE' });

        await assert.rejects(
            () => env.service.restoreUser(target.id, caller(ADMIN_ID)),
            (err: unknown) => {
                assert.ok(err instanceof AdminUserInvalidTransitionError);
                assert.strictEqual(err.fromStatus, 'ACTIVE');
                assert.strictEqual(err.attemptedAction, 'RESTORE_USER');
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });

    it('refuses a DELETED user (terminal) with InvalidTransitionError', async () => {
        const env = build();
        const target = await seedUser(env.userRepo, { status: 'DELETED' });

        await assert.rejects(
            () => env.service.restoreUser(target.id, caller(ADMIN_ID)),
            (err: unknown) => {
                assert.ok(err instanceof AdminUserInvalidTransitionError);
                assert.strictEqual(err.fromStatus, 'DELETED');
                assert.strictEqual(err.attemptedAction, 'RESTORE_USER');
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// Authorization — non-ADMIN callers
// ---------------------------------------------------------------------------

describe('AdminUserService — authorization', () => {
    const NON_ADMIN_ROLES: UserRole[] = ['CUSTOMER', 'BUSINESS_OWNER'];

    for (const role of NON_ADMIN_ROLES) {
        it(`refuses suspendUser when caller role is ${role}`, async () => {
            const env = build();
            const target = await seedUser(env.userRepo, { status: 'ACTIVE' });

            await assert.rejects(
                () =>
                    env.service.suspendUser(
                        target.id,
                        caller(NON_ADMIN_USER_ID, role),
                    ),
                AdminForbiddenError,
            );
            // Mutation didn't happen.
            const after = await env.userRepo.findById(target.id);
            assert.strictEqual(after?.status, 'ACTIVE');
            // Audit row didn't happen.
            assert.strictEqual(env.actionRepo.size(), 0);
        });

        it(`refuses restoreUser when caller role is ${role}`, async () => {
            const env = build();
            const target = await seedUser(env.userRepo, { status: 'SUSPENDED' });

            await assert.rejects(
                () =>
                    env.service.restoreUser(
                        target.id,
                        caller(NON_ADMIN_USER_ID, role),
                    ),
                AdminForbiddenError,
            );
            const after = await env.userRepo.findById(target.id);
            assert.strictEqual(after?.status, 'SUSPENDED');
            assert.strictEqual(env.actionRepo.size(), 0);
        });
    }
});

// ---------------------------------------------------------------------------
// Not-found
// ---------------------------------------------------------------------------

describe('AdminUserService — missing user', () => {
    it('suspendUser throws AdminUserNotFoundError for an unknown id', async () => {
        const env = build();

        await assert.rejects(
            () => env.service.suspendUser(MISSING_USER_ID, caller(ADMIN_ID)),
            (err: unknown) => {
                assert.ok(err instanceof AdminUserNotFoundError);
                assert.strictEqual(err.userId, MISSING_USER_ID);
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });

    it('restoreUser throws AdminUserNotFoundError for an unknown id', async () => {
        const env = build();

        await assert.rejects(
            () => env.service.restoreUser(MISSING_USER_ID, caller(ADMIN_ID)),
            (err: unknown) => {
                assert.ok(err instanceof AdminUserNotFoundError);
                assert.strictEqual(err.userId, MISSING_USER_ID);
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// Audit invariant — full surface
// ---------------------------------------------------------------------------

describe('AdminUserService — audit-row invariant', () => {
    it('writes one row per successful action, attributed to the calling admin', async () => {
        const env = build();
        const target = await seedUser(env.userRepo, { status: 'ACTIVE' });

        // suspend → SUSPENDED (admin A)
        await env.service.suspendUser(target.id, caller(ADMIN_ID), 'first');
        // restore → ACTIVE (admin B)
        await env.service.restoreUser(
            target.id,
            caller(OTHER_ADMIN_ID),
            'second',
        );

        assert.strictEqual(env.actionRepo.size(), 2);

        const rows = env.actionRepo.rowsForTarget(TARGET_TYPE, target.id);
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0]?.action, 'SUSPEND_USER');
        assert.strictEqual(rows[0]?.adminUserId, ADMIN_ID);
        assert.strictEqual(rows[0]?.notes, 'first');
        assert.strictEqual(rows[1]?.action, 'RESTORE_USER');
        assert.strictEqual(rows[1]?.adminUserId, OTHER_ADMIN_ID);
        assert.strictEqual(rows[1]?.notes, 'second');

        // Per-admin slicing also reflects the split.
        assert.strictEqual(env.actionRepo.rowsByAdmin(ADMIN_ID).length, 1);
        assert.strictEqual(env.actionRepo.rowsByAdmin(OTHER_ADMIN_ID).length, 1);
    });

    it('writes zero rows when any guard fails before the mutation', async () => {
        const env = build();
        const activeTarget = await seedUser(env.userRepo, { status: 'ACTIVE' });
        const deletedTarget = await seedUser(env.userRepo, { status: 'DELETED' });

        // Wrong status — suspend an already-DELETED user.
        await assert.rejects(
            () => env.service.suspendUser(deletedTarget.id, caller(ADMIN_ID)),
            AdminUserInvalidTransitionError,
        );
        // Wrong role — non-admin calls suspend on an ACTIVE user.
        await assert.rejects(
            () =>
                env.service.suspendUser(
                    activeTarget.id,
                    caller(NON_ADMIN_USER_ID, 'CUSTOMER'),
                ),
            AdminForbiddenError,
        );
        // Missing user — restore an unknown id.
        await assert.rejects(
            () => env.service.restoreUser(MISSING_USER_ID, caller(ADMIN_ID)),
            AdminUserNotFoundError,
        );

        assert.strictEqual(env.actionRepo.size(), 0);
    });
});
