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
