// EthioLink — admin user service.
//
// Suspend and restore users on behalf of an `ADMIN` caller, with one
// `admin_actions` audit row per successful write. Mirrors the
// design of `AdminBusinessService`:
//
//   * Same `AdminCallerContext` shape (re-exported below for handler
//     convenience; defined once in `adminBusinessService.ts` so the
//     two services share a single source of truth).
//   * Same `AdminForbiddenError` (re-exported for the same reason).
//   * Same audit invariant — exactly one row on success, zero on
//     failure.
//
// Methods:
//   * `suspendUser(id, caller, notes?)` — ACTIVE → SUSPENDED.
//   * `restoreUser(id, caller, notes?)` — SUSPENDED → ACTIVE.
//
// Status rules (per `users.status` CHECK in migration 0002):
//
//   * `ACTIVE`    — normal account state. Eligible for SUSPEND.
//   * `SUSPENDED` — admin-disabled. Eligible for RESTORE.
//   * `DELETED`   — terminal. Not eligible for either path. A
//                   future admin tool may restore a DELETED user as
//                   a separate workflow (likely with stricter
//                   confirmation); MVP does not expose that path
//                   and the service refuses any transition out of
//                   DELETED.
//
// Atomicity caveat (same as `AdminBusinessService`): the mutation
// and the audit insert are two sequential statements. A failing
// audit insert after a successful mutation leaves the row updated
// and no audit row — the same window the business service
// documents. The fix lands when `withTransaction` is threaded
// through both repos.

import type { UserRole } from '../../adapters/auth/AuthProvider.js';
import type {
    User,
    UserRepository,
    UserStatus,
} from '../users/userRepository.js';

import type {
    AdminAction,
    AdminActionRepository,
} from './adminActionRepository.js';
import {
    type AdminCallerContext,
    AdminForbiddenError,
} from './adminBusinessService.js';

// Re-exports so handlers can import the union of admin-side caller
// + forbidden error from one module per service.
export { AdminForbiddenError };
export type { AdminCallerContext };

// ---------------------------------------------------------------------------
// Errors specific to user transitions
// ---------------------------------------------------------------------------

/** Raised when the target user id doesn't exist. → 404 NOT_FOUND. */
export class AdminUserNotFoundError extends Error {
    public readonly userId: string;
    constructor(userId: string) {
        super(`User ${userId} not found.`);
        this.name = 'AdminUserNotFoundError';
        this.userId = userId;
    }
}

/**
 * Raised when an admin action is not legal given the user's current
 * status. → 409 CONFLICT.
 *
 * Carries the current status and the attempted action so the dashboard
 * can render unambiguous error copy ("RESTORE_USER is not allowed
 * from user status DELETED").
 */
export class AdminUserInvalidTransitionError extends Error {
    public readonly fromStatus: UserStatus;
    public readonly attemptedAction: AdminAction;
    constructor(fromStatus: UserStatus, attemptedAction: AdminAction) {
        super(
            `Action ${attemptedAction} is not allowed from user status ${fromStatus}.`,
        );
        this.name = 'AdminUserInvalidTransitionError';
        this.fromStatus = fromStatus;
        this.attemptedAction = attemptedAction;
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const TARGET_TYPE = 'user' as const;

export class AdminUserService {
    constructor(
        private readonly userRepo: UserRepository,
        private readonly actionRepo: AdminActionRepository,
    ) {}

    /** ACTIVE → SUSPENDED. */
    async suspendUser(
        id: string,
        caller: AdminCallerContext,
        notes?: string | null,
    ): Promise<User> {
        this.assertAdmin(caller);
        const existing = await this.findOrThrow(id);
        if (existing.status !== 'ACTIVE') {
            throw new AdminUserInvalidTransitionError(
                existing.status,
                'SUSPEND_USER',
            );
        }

        const updated = await this.userRepo.setStatus(id, 'SUSPENDED');
        await this.recordAction(caller, 'SUSPEND_USER', id, notes);
        return updated;
    }

    /** SUSPENDED → ACTIVE. */
    async restoreUser(
        id: string,
        caller: AdminCallerContext,
        notes?: string | null,
    ): Promise<User> {
        this.assertAdmin(caller);
        const existing = await this.findOrThrow(id);
        if (existing.status !== 'SUSPENDED') {
            throw new AdminUserInvalidTransitionError(
                existing.status,
                'RESTORE_USER',
            );
        }

        const updated = await this.userRepo.setStatus(id, 'ACTIVE');
        await this.recordAction(caller, 'RESTORE_USER', id, notes);
        return updated;
    }

    // ----- Internals --------------------------------------------------------

    private assertAdmin(caller: AdminCallerContext): void {
        if (caller.role !== ('ADMIN' satisfies UserRole)) {
            throw new AdminForbiddenError();
        }
    }

    private async findOrThrow(id: string): Promise<User> {
        const existing = await this.userRepo.findById(id);
        if (!existing) {
            throw new AdminUserNotFoundError(id);
        }
        return existing;
    }

    private async recordAction(
        caller: AdminCallerContext,
        action: AdminAction,
        userId: string,
        notes: string | null | undefined,
    ): Promise<void> {
        await this.actionRepo.insert({
            adminUserId: caller.userId,
            action,
            targetType: TARGET_TYPE,
            targetId: userId,
            notes: notes ?? null,
        });
    }
}
