// EthioLink — featuring subscription wire shapes.
//
// Phase 9 Track 6 — paid featuring data foundation. Two
// projections of the same domain object:
//
//   * `FeaturingSubscriptionView` — what the owner / admin sees
//     in the history listings + the "current subscription"
//     reads. ISO-8601 timestamps, narrow field set.
//   * `FeaturingPackageView` — the package list emitted by the
//     `listPackages` endpoint. Mirrors `FeaturingPackage` from
//     the service.
//
// Both views are forward-prep — no handlers consume them in
// this commit. They're authored alongside the data layer so the
// owner-side and admin-side endpoint commits don't have to
// re-derive the wire shape.

import type {
    PaymentAuthorization,
    PaymentAuthorizationStatus,
    PaymentProvider,
} from '../../adapters/payments/PaymentGateway.js';

import type {
    FeaturingPackage,
} from './featuringService.js';
import type {
    FeaturingPackageCode,
    FeaturingSource,
    FeaturingStatus,
    FeaturingSubscription,
} from './featuringRepository.js';

export interface FeaturingPackageView {
    readonly code: FeaturingPackageCode;
    readonly durationDays: number;
    readonly priceEtb: number;
}

export interface FeaturingSubscriptionView {
    readonly id: string;
    readonly businessId: string;
    readonly packageCode: FeaturingPackageCode;
    readonly priceEtb: number;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly status: FeaturingStatus;
    readonly source: FeaturingSource;
    readonly cancelledAt: string | null;
    readonly cancelledReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export function toFeaturingPackageView(
    pkg: FeaturingPackage,
): FeaturingPackageView {
    return Object.freeze<FeaturingPackageView>({
        code: pkg.code,
        durationDays: pkg.durationDays,
        priceEtb: pkg.priceEtb,
    });
}

export function toFeaturingSubscriptionView(
    sub: FeaturingSubscription,
): FeaturingSubscriptionView {
    return Object.freeze<FeaturingSubscriptionView>({
        id: sub.id,
        businessId: sub.businessId,
        packageCode: sub.packageCode,
        priceEtb: sub.priceEtb,
        startsAt: sub.startsAt.toISOString(),
        endsAt: sub.endsAt.toISOString(),
        status: sub.status,
        source: sub.source,
        cancelledAt: sub.cancelledAt
            ? sub.cancelledAt.toISOString()
            : null,
        cancelledReason: sub.cancelledReason,
        createdAt: sub.createdAt.toISOString(),
        updatedAt: sub.updatedAt.toISOString(),
    });
}

// ---------------------------------------------------------------------------
// Phase 10 — subscribe-response wrapper
// ---------------------------------------------------------------------------
//
// `POST /v1/businesses/{businessId}/featuring/subscribe` returns
// the subscription plus an inline `payment` block. CashGateway
// returns `SUCCEEDED` + `redirectUrl: null` synchronously; Chapa
// returns `PENDING` + the hosted-checkout URL. The mobile client
// reads `payment.redirectUrl` and opens it via `url_launcher`.
//
// `getActive` / `listHistory` continue to return the plain
// `FeaturingSubscription` shape — payment context is only
// meaningful at the moment of subscribe.

/**
 * Public payment-summary block. Mirrors the appointment-side
 * `PaymentSummary` — same fields, same elisions, defined here for
 * the featuring view layer's local consumption.
 */
export interface SubscribePaymentSummary {
    readonly status: PaymentAuthorizationStatus;
    readonly provider: PaymentProvider;
    readonly providerRef: string | null;
    readonly redirectUrl: string | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
}

/**
 * Wire shape returned by the subscribe handler. The subscription
 * sits in the `subscription` field rather than at the top level
 * to keep the response distinguishable from the
 * `FeaturingSubscription` shape returned by getActive / listHistory.
 */
export interface SubscribeFeaturingResponse {
    readonly subscription: FeaturingSubscriptionView;
    readonly payment: SubscribePaymentSummary;
}

export function toSubscribeFeaturingResponse(
    sub: FeaturingSubscription,
    payment: PaymentAuthorization,
): SubscribeFeaturingResponse {
    return Object.freeze<SubscribeFeaturingResponse>({
        subscription: toFeaturingSubscriptionView(sub),
        payment: Object.freeze<SubscribePaymentSummary>({
            status: payment.status,
            provider: payment.provider,
            providerRef: payment.providerRef ?? null,
            redirectUrl: payment.redirectUrl ?? null,
            errorCode: payment.errorCode ?? null,
            errorMessage: payment.errorMessage ?? null,
        }),
    });
}
