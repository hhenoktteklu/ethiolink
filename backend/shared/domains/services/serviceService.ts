// EthioLink — service-offering service.
//
// Domain rules for services (the bookable inventory of a business):
//
//   * Public listing returns active services only — `is_active = true`
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
//     than row removal — historical appointments will reference
//     services via `appointments.service_id ON DELETE RESTRICT`.

import type { BusinessRepository } from '../businesses/businessRepository.js';
import type { CallerContext } from '../businesses/businessService.js';

import type {
    InsertServiceInput,
    Service,
    ServiceRepository,
    UpdateServiceFields,
} from './serviceRepository.js';

/** Fields accepted by `create` (the handler supplies `businessId` from the path). */
export type CreateServiceInput = Omit<InsertServiceInput, 'businessId'>;

/** Same shape as the repository patch type. */
export type UpdateServiceInput = UpdateServiceFields;

// ---------------------------------------------------------------------------
// Errors — each maps to one HTTP code in handlers
// ---------------------------------------------------------------------------

export class ServiceNotFoundError extends Error {
    public readonly serviceId: string;
    constructor(serviceId: string) {
        super(`Service ${serviceId} not found.`);
        this.name = 'ServiceNotFoundError';
        this.serviceId = serviceId;
    }
}

export class ServiceNotOwnedError extends Error {
    constructor() {
        super('Caller does not own the business this service belongs to.');
        this.name = 'ServiceNotOwnedError';
    }
}

export class ServiceBusinessNotFoundError extends Error {
    public readonly businessId: string;
    constructor(businessId: string) {
        super(`Business ${businessId} not found.`);
        this.name = 'ServiceBusinessNotFoundError';
        this.businessId = businessId;
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ServiceService {
    constructor(
        private readonly repository: ServiceRepository,
        private readonly businessRepo: BusinessRepository,
    ) {}

    // ----- Public reads ------------------------------------------------------

    /**
     * Active services for a business. The dominant public listing query.
     * Returns an empty array for a nonexistent business; the handler may
     * choose to 404 the business id first if it wants to distinguish
     * "business doesn't exist" from "business has no services".
     */
    async listActiveForBusiness(businessId: string): Promise<readonly Service[]> {
        return this.repository.listActiveForBusiness(businessId);
    }

    // ----- Owner writes ------------------------------------------------------

    /**
     * Create a new active service for `businessId`. Caller must own the
     * business. Throws `ServiceBusinessNotFoundError` if the business id
     * is unknown — surfaces as 404, not 403, so callers can distinguish
     * "wrong business id" from "wrong caller".
     */
    async create(
        caller: CallerContext,
        businessId: string,
        input: CreateServiceInput,
    ): Promise<Service> {
        await this.assertOwnsBusiness(caller, businessId);
        return this.repository.insert({ ...input, businessId });
    }

    /**
     * Edit a service's mutable fields. Caller must own the business the
     * service belongs to. Cannot change `businessId` or `isActive` —
     * `isActive` flips via `deactivate` / reactivation, never through
     * a free-form PATCH.
     */
    async update(
        id: string,
        caller: CallerContext,
        patch: UpdateServiceInput,
    ): Promise<Service> {
        const existing = await this.repository.findById(id);
        if (!existing) throw new ServiceNotFoundError(id);
        await this.assertOwnsBusiness(caller, existing.businessId);
        return this.repository.update(id, patch);
    }

    /**
     * Soft-delete: set `is_active = false`. The row stays for referential
     * integrity (future appointments will RESTRICT delete). Public listing
     * will stop returning the row immediately; owner endpoints can
     * surface inactive services in a later phase.
     */
    async deactivate(id: string, caller: CallerContext): Promise<Service> {
        const existing = await this.repository.findById(id);
        if (!existing) throw new ServiceNotFoundError(id);
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
            throw new ServiceBusinessNotFoundError(businessId);
        }
        if (business.ownerUserId !== caller.userId) {
            throw new ServiceNotOwnedError();
        }
    }
}
