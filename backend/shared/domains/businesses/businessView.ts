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
}

export interface BusinessOwnerView extends BusinessPublicView {
    readonly ownerUserId: string;
    readonly status: BusinessStatus;
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
    });
}

export function toBusinessOwnerView(business: Business): BusinessOwnerView {
    return Object.freeze<BusinessOwnerView>({
        ...toBusinessPublicView(business),
        ownerUserId: business.ownerUserId,
        status: business.status,
    });
}
