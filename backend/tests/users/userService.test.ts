// EthioLink — UserService unit tests.
//
// Covers the Phase 1 test-plan items:
//   * Happy-path sync (first call creates a row).
//   * Idempotent sync (second call leaves a single row).
//   * Role mapping per Cognito group (all three roles plus the default).
//   * get by id and by cognito_sub (hit and miss).
//   * Update happy path, no-op, and missing-user error.
//
// Plus a direct test of `deriveRole`, which carries the precedence rule
// the rest of the codebase depends on but is not exercised by UserService
// itself (the service receives a pre-derived role on the principal).
//
// Run with: `npm test` from the `backend/` directory.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveRole } from '../../shared/adapters/auth/AuthProvider.js';
import type { AuthPrincipal, UserRole } from '../../shared/adapters/auth/AuthProvider.js';
import {
    UserNotFoundError,
    UserService,
} from '../../shared/domains/users/userService.js';

import { InMemoryUserRepository } from '../_fakes/InMemoryUserRepository.js';

function principal(overrides: Partial<AuthPrincipal> = {}): AuthPrincipal {
    return {
        sub: 'sub-1',
        email: 'henok@example.com',
        phone: null,
        displayName: 'Henok',
        groups: ['CUSTOMER'],
        role: 'CUSTOMER',
        ...overrides,
    };
}

describe('UserService.syncFromPrincipal', () => {
    it('creates a row on the first call with the principal-derived role', async () => {
        const repo = new InMemoryUserRepository();
        const service = new UserService(repo);

        const user = await service.syncFromPrincipal(principal());

        assert.strictEqual(user.cognitoSub, 'sub-1');
        assert.strictEqual(user.email, 'henok@example.com');
        assert.strictEqual(user.role, 'CUSTOMER');
        assert.strictEqual(user.status, 'ACTIVE');
        assert.strictEqual(user.displayName, 'Henok');
        assert.strictEqual(repo.size(), 1);
    });

    it('is idempotent for the same principal (no duplicate row)', async () => {
        const repo = new InMemoryUserRepository();
        const service = new UserService(repo);

        const first = await service.syncFromPrincipal(principal());
        const second = await service.syncFromPrincipal(principal());

        assert.strictEqual(first.id, second.id);
        assert.strictEqual(first.cognitoSub, second.cognitoSub);
        assert.strictEqual(repo.size(), 1);
    });

    it('refreshes principal-derived fields when they change between calls', async () => {
        const repo = new InMemoryUserRepository();
        const service = new UserService(repo);

        await service.syncFromPrincipal(
            principal({ displayName: 'Henok', email: 'old@example.com' }),
        );
        const updated = await service.syncFromPrincipal(
            principal({ displayName: 'Henok T.', email: 'new@example.com' }),
        );

        assert.strictEqual(updated.displayName, 'Henok T.');
        assert.strictEqual(updated.email, 'new@example.com');
        assert.strictEqual(repo.size(), 1);
    });

    it('persists each role exactly as derived', async () => {
        for (const role of ['CUSTOMER', 'BUSINESS_OWNER', 'ADMIN'] as const) {
            const repo = new InMemoryUserRepository();
            const service = new UserService(repo);

            const user = await service.syncFromPrincipal(
                principal({ sub: `sub-${role}`, groups: [role], role }),
            );
            assert.strictEqual(user.role, role);
        }
    });

    it('promotes a user when their Cognito groups change between syncs', async () => {
        const repo = new InMemoryUserRepository();
        const service = new UserService(repo);

        const before = await service.syncFromPrincipal(
            principal({ groups: ['CUSTOMER'], role: 'CUSTOMER' }),
        );
        const after = await service.syncFromPrincipal(
            principal({ groups: ['ADMIN'], role: 'ADMIN' }),
        );

        assert.strictEqual(before.id, after.id, 'same row');
        assert.strictEqual(before.role, 'CUSTOMER');
        assert.strictEqual(after.role, 'ADMIN');
    });
});

describe('UserService lookups', () => {
    it('getById returns null for unknown id', async () => {
        const service = new UserService(new InMemoryUserRepository());
        assert.strictEqual(await service.getById('does-not-exist'), null);
    });

    it('getByCognitoSub returns null for unknown sub', async () => {
        const service = new UserService(new InMemoryUserRepository());
        assert.strictEqual(await service.getByCognitoSub('does-not-exist'), null);
    });

    it('returns the synced row by id and by cognito_sub', async () => {
        const repo = new InMemoryUserRepository();
        const service = new UserService(repo);
        const synced = await service.syncFromPrincipal(principal());

        const byId = await service.getById(synced.id);
        const bySub = await service.getByCognitoSub(synced.cognitoSub);

        assert.strictEqual(byId?.id, synced.id);
        assert.strictEqual(bySub?.id, synced.id);
    });
});

describe('UserService.update', () => {
    it('updates display_name', async () => {
        const repo = new InMemoryUserRepository();
        const service = new UserService(repo);
        const created = await service.syncFromPrincipal(principal());

        const updated = await service.update(created.id, { displayName: 'New Name' });

        assert.strictEqual(updated.displayName, 'New Name');
    });

    it('clears display_name when patched with null', async () => {
        const repo = new InMemoryUserRepository();
        const service = new UserService(repo);
        const created = await service.syncFromPrincipal(principal({ displayName: 'X' }));

        const updated = await service.update(created.id, { displayName: null });

        assert.strictEqual(updated.displayName, null);
    });

    it('is a no-op for an empty patch', async () => {
        const repo = new InMemoryUserRepository();
        const service = new UserService(repo);
        const created = await service.syncFromPrincipal(principal({ displayName: 'X' }));

        const result = await service.update(created.id, {});

        assert.strictEqual(result.displayName, 'X');
        assert.strictEqual(result.id, created.id);
    });

    it('throws UserNotFoundError when the user does not exist', async () => {
        const service = new UserService(new InMemoryUserRepository());

        await assert.rejects(
            () => service.update('missing-id', { displayName: 'X' }),
            UserNotFoundError,
        );
    });
});

describe('deriveRole', () => {
    const cases: ReadonlyArray<{ groups: string[]; expected: UserRole }> = [
        { groups: [], expected: 'CUSTOMER' },
        { groups: ['CUSTOMER'], expected: 'CUSTOMER' },
        { groups: ['BUSINESS_OWNER'], expected: 'BUSINESS_OWNER' },
        { groups: ['ADMIN'], expected: 'ADMIN' },
        { groups: ['CUSTOMER', 'ADMIN'], expected: 'ADMIN' },
        { groups: ['BUSINESS_OWNER', 'CUSTOMER'], expected: 'BUSINESS_OWNER' },
        { groups: ['ADMIN', 'BUSINESS_OWNER', 'CUSTOMER'], expected: 'ADMIN' },
        { groups: ['UNKNOWN'], expected: 'CUSTOMER' },
        { groups: ['UNKNOWN', 'ADMIN'], expected: 'ADMIN' },
    ];

    for (const { groups, expected } of cases) {
        it(`groups=${JSON.stringify(groups)} → ${expected}`, () => {
            assert.strictEqual(deriveRole(groups), expected);
        });
    }
});
