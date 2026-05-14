// EthioLink — staff (members) service.
//
// Domain rules for staff members (the bookable people of a business):
//
//   * Public listing returns active staff only — `is_active = true`
//     filter lives in the repository.
//   * Every write requires the caller to own the target business.
//     Ownership is checked by looking up the parent business through
//     `BusinessRepository` and comparing `business.ownerUserId` to the
//     caller's `users.id`.
//   * Phase 3 scope is strict owner-only. The API spec lists every
//     write path as "owner or ADMIN"; the admin half lands in Phase 5
//     alongside the rest of the admin write surface. `CallerContext`
//     carries the role today so the relaxation in Phase 5 is a
//     one-line change here.
//   * DELETE is modeled as soft-delete (`is_active = false`) rather
//     than row removal — historical appointments reference staff
//     via `appointments.staff_id ON DELETE RESTRICT`.

import type { BusinessRepository } from '../businesses/businessRepository.js';
import type { CallerContext } from '../businesses/businessService.js';

import type {
    InsertStaffInput,
    StaffMember,
    StaffRepository,
    UpdateStaffFields,
} from './staffRepository.js';

/** Fields accepted by `create` (the handler supplies `businessId` from the path). */
export type CreateStaffInput = Omit<InsertStaffInput, 'businessId'>;

/** Same shape as the repository patch type. */
export type UpdateStaffInput = UpdateStaffFields;

// ---------------------------------------------------------------------------
// Errors — each maps to one HTTP code in handlers
// ---------------------------------------------------------------------------

export class StaffNotFoundError extends Error {
    public readonly staffId: string;
    constructor(staffId: string) {
        super(`Staff member ${staffId} not found.`);
        this.name = 'StaffNotFoundError';
        this.staffId = staffId;
    }
}

export class StaffNotOwnedError extends Error {
    constructor() {
        super('Caller does not own the business this staff member belongs to.');
        this.name = 'StaffNotOwnedError';
    }
}

export class StaffBusinessNotFoundError extends Error {
    public readonly businessId: string;
    constructor(businessId: string) {
        super(`Business ${businessId} not found.`);
        this.name = 'StaffBusinessNotFoundError';
        this.businessId = businessId;
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class StaffService {
    constructor(
        private readonly repository: StaffRepository,
        private readonly businessRepo: BusinessRepository,
    ) {}

    // ----- Public reads ------------------------------------------------------

    /**
     * Active staff for a business. The dominant public listing query.
     * Returns an empty array for a nonexistent business; the handler may
     * choose to 404 the business id first if it wants to distinguish
     * "business doesn't exist" from "business has no staff".
     */
    async listActiveForBusiness(businessId: string): Promise<readonly StaffMember[]> {
        return this.repository.listActiveForBusiness(businessId);
    }

    // ----- Owner writes ------------------------------------------------------

    /**
     * Create a new active staff member for `businessId`. Caller must own
     * the business. Throws `StaffBusinessNotFoundError` if the business id
     * is unknown — surfaces as 404, not 403, so callers can distinguish
     * "wrong business id" from "wrong caller".
     */
    async create(
        caller: CallerContext,
        businessId: string,
        input: CreateStaffInput,
    ): Promise<StaffMember> {
        await this.assertOwnsBusiness(caller, businessId);
        return this.repository.insert({ ...input, businessId });
    }

    /**
     * Edit a staff member's mutable fields. Caller must own the business
     * the staff member belongs to. Cannot change `businessId` or
     * `isActive` — `isActive` flips via `deactivate`, never through a
     * free-form PATCH.
     */
    async update(
        id: string,
        caller: CallerContext,
        patch: UpdateStaffInput,
    ): Promise<StaffMember> {
        const existing = await this.repository.findById(id);
        if (!existing) throw new StaffNotFoundError(id);
        await this.assertOwnsBusiness(caller, existing.businessId);
        return this.repository.update(id, patch);
    }

    /**
     * Soft-delete: set `is_active = false`. The row stays for referential
     * integrity (future appointments will RESTRICT delete). Public
     * listing will stop returning the row immediately; owner endpoints
     * can surface inactive staff in a later phase.
     */
    async deactivate(id: string, caller: CallerContext): Promise<StaffMember> {
        const existing = await this.repository.findById(id);
        if (!existing) throw new StaffNotFoundError(id);
        await this.assertOwnsBusiness(caller, existing.businessId);
        return this.repository.setIsActive(id, false);
    }

    // ----- internals ---------------------------------------------------------

    private async assertOwnsBusiness(
        caller: CallerContext,
        businessId: string,
    ): Promise<void> {
        const business = await this.businessRepo.findById(businessId);
        if (!business) {
            throw new StaffBusinessNotFoundError(businessId);
        }
        if (business.ownerUserId !== caller.userId) {
            throw new StaffNotOwnedError();
        }
    }
}
