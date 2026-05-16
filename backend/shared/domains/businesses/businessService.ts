// EthioLink — business service.
//
// Domain rules for the business profile feature. The handler layer
// translates HTTP envelopes; this service owns the actual policy:
//
//   * Ownership — only the owner can edit or submit a business. Admin
//     write paths come in Phase 5 (API_SPEC marks PATCH as "owner or
//     ADMIN", but Phase 2's scope is owner-only — we wire admin in
//     Phase 5).
//   * One business per owner — MVP shape (`API_SPEC.md`: `GET
//     /v1/me/business`). A second `create` for the same owner is a
//     `CONFLICT`.
//   * State machine — only DRAFT → PENDING_REVIEW is permitted in
//     Phase 2 (`POST /v1/businesses/:id/submit`). Resubmits after
//     rejection are a Phase 5 concern.
//   * Required-before-submit — submission requires `name`, `description`
//     (non-empty `en`), `city`, and `categoryId`. All four are validated
//     here; the database keeps them nullable so DRAFTs can be partial.
//
// Cursor pagination:
//   * The wire format is opaque: `base64url(JSON.stringify({ id, sortKey }))`.
//   * The repository owns the sort order; this service owns the codec.

import type {
    Business,
    BusinessRepository,
    BusinessStatus,
    InsertBusinessInput,
    ParsedCursor,
    PublicBusinessFilters,
    UpdateBusinessFields,
} from './businessRepository.js';

import type { UserRole } from '../../adapters/auth/AuthProvider.js';
import {
    clampLimit,
    decodeCursor,
    encodeCursor,
    InvalidCursorError,
} from '../../http/pagination.js';

// Re-export for backwards compatibility: handlers and tests import
// `InvalidCursorError` from this module since Phase 2.
export { InvalidCursorError };

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/** Identity of an authenticated caller. Built by the handler from `AuthPrincipal`. */
export interface CallerContext {
    readonly userId: string;
    readonly role: UserRole;
}

/** Fields accepted by `create`. `categoryId` required; everything else optional. */
export type CreateBusinessInput = Omit<InsertBusinessInput, 'ownerUserId'>;

/** Fields accepted by `update`. Same shape as the repository patch type. */
export type UpdateBusinessInput = UpdateBusinessFields;

export interface BusinessListPage {
    readonly items: readonly Business[];
    readonly nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Errors — each maps to one HTTP code in handlers
// ---------------------------------------------------------------------------

export class BusinessNotFoundError extends Error {
    public readonly businessId: string;
    constructor(businessId: string) {
        super(`Business ${businessId} not found.`);
        this.name = 'BusinessNotFoundError';
        this.businessId = businessId;
    }
}

export class BusinessNotOwnedError extends Error {
    constructor() {
        super('Caller does not own this business.');
        this.name = 'BusinessNotOwnedError';
    }
}

export class BusinessAlreadyExistsError extends Error {
    constructor() {
        super('Caller already owns a business; only one is permitted per owner.');
        this.name = 'BusinessAlreadyExistsError';
    }
}

export class BusinessInvalidTransitionError extends Error {
    public readonly from: BusinessStatus;
    public readonly to: BusinessStatus;
    constructor(from: BusinessStatus, to: BusinessStatus) {
        super(`Invalid status transition: ${from} → ${to}.`);
        this.name = 'BusinessInvalidTransitionError';
        this.from = from;
        this.to = to;
    }
}

export class BusinessIncompleteForSubmitError extends Error {
    public readonly missing: readonly string[];
    constructor(missing: readonly string[]) {
        super(`Business is missing required fields for submit: ${missing.join(', ')}.`);
        this.name = 'BusinessIncompleteForSubmitError';
        this.missing = missing;
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class BusinessService {
    constructor(private readonly repository: BusinessRepository) {}

    // ----- Public reads ------------------------------------------------------

    /**
     * Public listing. Filters by status APPROVED, applies optional filters,
     * and paginates with the opaque cursor format.
     */
    async listPublic(
        filters: PublicBusinessFilters,
        encodedCursor?: string,
        requestedLimit?: number,
    ): Promise<BusinessListPage> {
        const limit = clampLimit(requestedLimit, {
            default: DEFAULT_LIST_LIMIT,
            max: MAX_LIST_LIMIT,
        });
        // Phase 9 Track 6 — only the `featured` sort supports cursor
        // pagination in this commit. For relevance / rating / newest
        // sorts we ignore any incoming cursor (rather than reject
        // it — clients that paginated under the default sort and
        // switched modes shouldn't get a 400) and emit a null
        // nextCursor.
        const sort = filters.sort ?? 'featured';
        const cursorSupported = sort === 'featured';
        const cursor = cursorSupported && encodedCursor
            ? decodeCursor<ParsedCursor>(encodedCursor, isParsedCursor)
            : null;

        // Ask for one extra row to detect "is there another page".
        const rows = await this.repository.listPublic(filters, cursor, limit + 1);
        const items = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        const last = items[items.length - 1];
        const nextCursor =
            cursorSupported && hasMore && last
                ? encodeBusinessCursor(last)
                : null;

        return Object.freeze<BusinessListPage>({
            items: Object.freeze([...items]),
            nextCursor,
        });
    }

    /**
     * Return a business by id only if it is APPROVED. The public detail
     * endpoint uses this; APPROVED is the only state visible to anonymous
     * callers.
     */
    async findApproved(id: string): Promise<Business | null> {
        const business = await this.repository.findById(id);
        if (!business || business.status !== 'APPROVED') return null;
        return business;
    }

    // ----- Owner reads -------------------------------------------------------

    /** The caller's own business at any status. `null` if they don't have one. */
    async getByOwner(ownerUserId: string): Promise<Business | null> {
        return this.repository.findByOwnerUserId(ownerUserId);
    }

    // ----- Owner writes ------------------------------------------------------

    /**
     * Create a fresh DRAFT business for `ownerUserId`. Refuses if the caller
     * already owns one — MVP enforces one-business-per-owner.
     */
    async create(ownerUserId: string, input: CreateBusinessInput): Promise<Business> {
        const existing = await this.repository.findByOwnerUserId(ownerUserId);
        if (existing) {
            throw new BusinessAlreadyExistsError();
        }
        return this.repository.insert({ ...input, ownerUserId });
    }

    /**
     * Edit a business. Caller must own the business (Phase 2 scope); admin
     * write paths land in Phase 5. The update can never change `status`,
     * `owner_user_id`, the rating counters, or `featured_until` — those have
     * their own dedicated mutation paths.
     */
    async update(
        id: string,
        caller: CallerContext,
        patch: UpdateBusinessInput,
    ): Promise<Business> {
        const existing = await this.repository.findById(id);
        if (!existing) throw new BusinessNotFoundError(id);
        if (existing.ownerUserId !== caller.userId) {
            throw new BusinessNotOwnedError();
        }
        return this.repository.update(id, patch);
    }

    /**
     * Submit a business for admin review. Transitions DRAFT → PENDING_REVIEW.
     * Caller must own the business. The business must satisfy the
     * required-before-submit invariants; missing fields are reported in the
     * raised `BusinessIncompleteForSubmitError`.
     */
    async submit(id: string, ownerUserId: string): Promise<Business> {
        const existing = await this.repository.findById(id);
        if (!existing) throw new BusinessNotFoundError(id);
        if (existing.ownerUserId !== ownerUserId) {
            throw new BusinessNotOwnedError();
        }
        if (existing.status !== 'DRAFT') {
            throw new BusinessInvalidTransitionError(existing.status, 'PENDING_REVIEW');
        }
        const missing = missingForSubmit(existing);
        if (missing.length > 0) {
            throw new BusinessIncompleteForSubmitError(missing);
        }
        return this.repository.setStatus(id, 'PENDING_REVIEW');
    }
}

// ---------------------------------------------------------------------------
// Submit validation
// ---------------------------------------------------------------------------

function missingForSubmit(business: Business): readonly string[] {
    const missing: string[] = [];
    if (isBlank(business.name)) missing.push('name');
    if (!hasNonEmptyDescription(business.description)) missing.push('description');
    if (isBlank(business.city)) missing.push('city');
    // categoryId is NOT NULL at the DB level, so it's always present — but
    // we keep the check explicit in case future migrations change that.
    if (!business.categoryId) missing.push('categoryId');
    return missing;
}

function isBlank(value: string | null | undefined): boolean {
    return value === null || value === undefined || value.trim() === '';
}

function hasNonEmptyDescription(
    description: { readonly en?: string } | null | undefined,
): boolean {
    if (!description) return false;
    return typeof description.en === 'string' && description.en.trim() !== '';
}

// ---------------------------------------------------------------------------
// Cursor — business-specific shape + type guard
//
// The opaque encode/decode/clamp helpers live in shared/http/pagination.ts.
// This file only owns the business-specific payload shape (`ParsedCursor`)
// and its runtime validator.
// ---------------------------------------------------------------------------

function encodeBusinessCursor(business: Business): string {
    return encodeCursor<ParsedCursor>({
        id: business.id,
        sortKey: {
            featuredUntil: business.featuredUntil
                ? business.featuredUntil.toISOString()
                : null,
            ratingAvg: business.ratingAvg,
            createdAt: business.createdAt.toISOString(),
        },
    });
}

function isParsedCursor(value: unknown): value is ParsedCursor {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== 'string') return false;
    const sortKey = v.sortKey;
    if (!sortKey || typeof sortKey !== 'object') return false;
    const sk = sortKey as Record<string, unknown>;
    const featuredUntilOk = sk.featuredUntil === null || typeof sk.featuredUntil === 'string';
    const ratingAvgOk = typeof sk.ratingAvg === 'number';
    const createdAtOk = typeof sk.createdAt === 'string';
    return featuredUntilOk && ratingAvgOk && createdAtOk;
}
