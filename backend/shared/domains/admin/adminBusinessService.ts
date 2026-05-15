// EthioLink — admin business service.
//
// Closes MVP-done item #3: "An admin can approve a business and
// feature a listing from the web dashboard." Composes
// `BusinessRepository` (for status / featured_until mutations) with
// `AdminActionRepository` (for the audit-log row that lands alongside
// every successful write).
//
// Methods:
//   * `approveBusiness`    — PENDING_REVIEW → APPROVED
//   * `rejectBusiness`     — PENDING_REVIEW → REJECTED
//   * `suspendBusiness`    — APPROVED or PENDING_REVIEW → SUSPENDED
//   * `setFeaturedUntil`   — set / clear `featured_until` on an
//                            APPROVED business; emits
//                            `FEATURE_BUSINESS` (set) or
//                            `UNFEATURE_BUSINESS` (clear)
//
// Authorization: every method asserts `caller.role === 'ADMIN'` at
// the service layer. The HTTP handlers will also gate by role, but
// the service is the authoritative enforcement point so any future
// admin-tooling (cron, CLI) cannot bypass it.
//
// Audit invariants:
//   * On success, exactly one `admin_actions` row is appended,
//     carrying the matching `AdminAction`, `'business_profile'` as
//     the target type, and the caller-supplied optional `notes`.
//   * On failure (admin forbidden / business not found / invalid
//     transition), no audit row is written. The mutation never
//     starts.
//
// Atomicity caveat (documented, deferred):
//
//   The mutation and the audit-row insert run as two sequential
//   statements. Between them, the row is committed but the audit
//   log is empty — a vanishingly small window in MVP, but a real
//   correctness gap. The proper fix is `withTransaction` from
//   `pgClient.ts` threading a `PoolClient` through both repos. That
//   pattern hasn't landed for any service yet (review-insert +
//   recompute has the same shape); it'll land in a single follow-up
//   commit once the test surface needs it. For now, ordering is
//   "mutation, then audit": if the audit-insert fails after a
//   successful mutation, the mutation stands and the missing audit
//   row is recoverable from CloudWatch logs (the handler logs the
//   admin action context before calling this method).

import type { UserRole } from '../../adapters/auth/AuthProvider.js';
import type {
    Business,
    BusinessRepository,
    BusinessStatus,
} from '../businesses/businessRepository.js';

import type {
    AdminAction,
    AdminActionRepository,
} from './adminActionRepository.js';

// ---------------------------------------------------------------------------
// Caller context
// ---------------------------------------------------------------------------

/** Identity of an authenticated admin caller. */
export interface AdminCallerContext {
    readonly userId: string;
    readonly role: UserRole;
}

// ---------------------------------------------------------------------------
// Errors — each maps to one HTTP code in handlers
// ---------------------------------------------------------------------------

/**
 * Raised when the caller's role is not `ADMIN`. The HTTP layer maps
 * this to 403 FORBIDDEN. Service-layer authorization is the
 * authoritative gate; the handler-layer role check is an early-out
 * for nicer error messages.
 */
export class AdminForbiddenError extends Error {
    constructor() {
        super('Admin role required.');
        this.name = 'AdminForbiddenError';
    }
}

/** Raised when the target business id doesn't exist. → 404 NOT_FOUND. */
export class AdminBusinessNotFoundError extends Error {
    public readonly businessId: string;
    constructor(businessId: string) {
        super(`Business ${businessId} not found.`);
        this.name = 'AdminBusinessNotFoundError';
        this.businessId = businessId;
    }
}

/**
 * Raised when an admin action is not legal given the business's
 * current status. → 409 CONFLICT.
 *
 * Carries both the current status and the action that was attempted
 * (not a target status, because some actions like FEATURE_BUSINESS
 * don't change the status). Handlers render both for clearer error
 * messages on the admin dashboard.
 */
export class AdminBusinessInvalidTransitionError extends Error {
    public readonly fromStatus: BusinessStatus;
    public readonly attemptedAction: AdminAction;
    constructor(fromStatus: BusinessStatus, attemptedAction: AdminAction) {
        super(
            `Action ${attemptedAction} is not allowed from business status ${fromStatus}.`,
        );
        this.name = 'AdminBusinessInvalidTransitionError';
        this.fromStatus = fromStatus;
        this.attemptedAction = attemptedAction;
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const TARGET_TYPE = 'business_profile' as const;

export class AdminBusinessService {
    constructor(
        private readonly businessRepo: BusinessRepository,
        private readonly actionRepo: AdminActionRepository,
    ) {}

    /** PENDING_REVIEW → APPROVED. */
    async approveBusiness(
        id: string,
        caller: AdminCallerContext,
        notes?: string | null,
    ): Promise<Business> {
        this.assertAdmin(caller);
        const existing = await this.findOrThrow(id);
        this.assertFromStatus(existing.status, 'PENDING_REVIEW', 'APPROVE_BUSINESS');

        const updated = await this.businessRepo.setStatus(id, 'APPROVED');
        await this.recordAction(caller, 'APPROVE_BUSINESS', id, notes);
        return updated;
    }

    /** PENDING_REVIEW → REJECTED. */
    async rejectBusiness(
        id: string,
        caller: AdminCallerContext,
        notes?: string | null,
    ): Promise<Business> {
        this.assertAdmin(caller);
        const existing = await this.findOrThrow(id);
        this.assertFromStatus(existing.status, 'PENDING_REVIEW', 'REJECT_BUSINESS');

        const updated = await this.businessRepo.setStatus(id, 'REJECTED');
        await this.recordAction(caller, 'REJECT_BUSINESS', id, notes);
        return updated;
    }

    /** APPROVED or PENDING_REVIEW → SUSPENDED. */
    async suspendBusiness(
        id: string,
        caller: AdminCallerContext,
        notes?: string | null,
    ): Promise<Business> {
        this.assertAdmin(caller);
        const existing = await this.findOrThrow(id);
        if (
            existing.status !== 'APPROVED' &&
            existing.status !== 'PENDING_REVIEW'
        ) {
            throw new AdminBusinessInvalidTransitionError(
                existing.status,
                'SUSPEND_BUSINESS',
            );
        }

        const updated = await this.businessRepo.setStatus(id, 'SUSPENDED');
        await this.recordAction(caller, 'SUSPEND_BUSINESS', id, notes);
        return updated;
    }

    /**
     * Set `featured_until` on an APPROVED business. Pass `null` to
     * clear (unfeature) — emits `UNFEATURE_BUSINESS` instead of
     * `FEATURE_BUSINESS` so the audit history distinguishes the two.
     *
     * The business must be APPROVED. Featuring a DRAFT / PENDING /
     * REJECTED / SUSPENDED row would surface a non-public business
     * at the top of public listings, which is never intended.
     */
    async setFeaturedUntil(
        id: string,
        caller: AdminCallerContext,
        featuredUntil: Date | null,
        notes?: string | null,
    ): Promise<Business> {
        this.assertAdmin(caller);
        const existing = await this.findOrThrow(id);
        const action: AdminAction =
            featuredUntil !== null ? 'FEATURE_BUSINESS' : 'UNFEATURE_BUSINESS';
        if (existing.status !== 'APPROVED') {
            throw new AdminBusinessInvalidTransitionError(existing.status, action);
        }

        const updated = await this.businessRepo.setFeaturedUntil(id, featuredUntil);
        await this.recordAction(caller, action, id, notes);
        return updated;
    }

    // ----- Internals --------------------------------------------------------

    private assertAdmin(caller: AdminCallerContext): void {
        if (caller.role !== 'ADMIN') {
            throw new AdminForbiddenError();
        }
    }

    private async findOrThrow(id: string): Promise<Business> {
        const existing = await this.businessRepo.findById(id);
        if (!existing) {
            throw new AdminBusinessNotFoundError(id);
        }
        return existing;
    }

    private assertFromStatus(
        actual: BusinessStatus,
        expected: BusinessStatus,
        attemptedAction: AdminAction,
    ): void {
        if (actual !== expected) {
            throw new AdminBusinessInvalidTransitionError(actual, attemptedAction);
        }
    }

    private async recordAction(
        caller: AdminCallerContext,
        action: AdminAction,
        businessId: string,
        notes: string | null | undefined,
    ): Promise<void> {
        await this.actionRepo.insert({
            adminUserId: caller.userId,
            action,
            targetType: TARGET_TYPE,
            targetId: businessId,
            notes: notes ?? null,
        });
    }
}
