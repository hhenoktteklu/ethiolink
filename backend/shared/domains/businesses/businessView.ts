// EthioLink — public and owner JSON shapes for a business profile.
//
// Two projections of the same domain object:
//
//   * `BusinessPublicView` — what anonymous callers see in
//     `GET /v1/businesses` and `GET /v1/businesses/:id`. Hides the
//     internal `status` (always APPROVED at this surface anyway) and
//     `ownerUserId`. By keeping the public view a strict subset of
//     stored fields, a column added to `business_profiles` does not
//     automatically leak to the public.
//
//   * `BusinessOwnerView` — what the owner sees through
//     `GET /v1/me/business` and what `POST/PATCH /v1/businesses`
//     return. Adds `status` (the owner needs to see DRAFT /
//     PENDING_REVIEW / etc.) and `ownerUserId` for client-side
//     correlation.
//
// Both views serialize timestamps as ISO-8601 and pass the localized
// `description` through as a JSONB object — clients pick their active
// locale themselves.

import type { LocalizedText } from '../categories/categoryRepository.js';

import type { Business, BusinessStatus } from './businessRepository.js';

export interface BusinessPublicView {
    readonly id: string;
    readonly categoryId: string;
    readonly name: string | null;
    readonly description: LocalizedText | null;
    readonly city: string | null;
    readonly addressLine: string | null;
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly phone: string | null;
    readonly telegramHandle: string | null;
    readonly whatsappPhone: string | null;
    readonly featuredUntil: string | null;
    readonly ratingAvg: number;
    readonly ratingCount: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    /**
     * Phase 9 Track 6 — full-text rank for the matching row. Non-null
     * when the listing was issued with `sort=relevance` and a non-empty
     * `q`; `null` for every other call path. Clients can use this to
     * render a debug "match strength" badge but it's not required for
     * normal display.
     */
    readonly searchRank: number | null;
}

export interface BusinessOwnerView extends BusinessPublicView {
    readonly ownerUserId: string;
    readonly status: BusinessStatus;
    /**
     * The most-recent rejection note, populated by
     * `GET /v1/me/business` from the latest `REJECT_BUSINESS`
     * row in `admin_actions` (the canonical rejection-reason
     * store — see migration 0012 + Phase 5's "no dedicated
     * `business_profiles.rejection_reason` column" scoping note
     * in `admin_actions` doc-comment).
     *
     * Non-REJECTED businesses (DRAFT / PENDING_REVIEW / APPROVED
     * / SUSPENDED) leave this `null`. The shape is non-optional
     * so the mobile client can branch on a single field without
     * juggling `undefined` vs `null`.
     */
    readonly rejection: BusinessRejection | null;
}

export interface BusinessRejection {
    /**
     * Free-text reason as typed by the admin in the admin SPA's
     * `BusinessDetailPage` "Reason" textarea. May be `null` when
     * the admin rejected without supplying a note (the admin
     * SPA's reject dialog labels it "Reason (recommended)" —
     * recommended but not required).
     */
    readonly reason: string | null;

    /** ISO-8601 timestamp of the admin's reject action. */
    readonly rejectedAt: string;
}

export function toBusinessPublicView(business: Business): BusinessPublicView {
    return Object.freeze<BusinessPublicView>({
        id: business.id,
        categoryId: business.categoryId,
        name: business.name,
        description: business.description,
        city: business.city,
        addressLine: business.addressLine,
        latitude: business.latitude,
        longitude: business.longitude,
        phone: business.phone,
        telegramHandle: business.telegramHandle,
        whatsappPhone: business.whatsappPhone,
        featuredUntil: business.featuredUntil
            ? business.featuredUntil.toISOString()
            : null,
        ratingAvg: business.ratingAvg,
        ratingCount: business.ratingCount,
        createdAt: business.createdAt.toISOString(),
        updatedAt: business.updatedAt.toISOString(),
        searchRank: business.searchRank,
    });
}

/**
 * Materialize a `BusinessOwnerView`. The optional `rejection`
 * argument lets the caller (`GET /v1/me/business`) attach the
 * latest `REJECT_BUSINESS` admin-action row to the response when
 * the business is in `REJECTED`. Other callers (the
 * `POST/PATCH/SUBMIT` mutations) leave it `null` — those return
 * the freshly-mutated row and there's no need to fetch audit
 * history.
 */
export function toBusinessOwnerView(
    business: Business,
    options: { rejection?: BusinessRejection | null } = {},
): BusinessOwnerView {
    return Object.freeze<BusinessOwnerView>({
        ...toBusinessPublicView(business),
        ownerUserId: business.ownerUserId,
        status: business.status,
        rejection: options.rejection ?? null,
    });
}
