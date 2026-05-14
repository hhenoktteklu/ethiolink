// EthioLink — public JSON shape for a service (offering).
//
// Single projection used by both the public listing endpoint and the
// owner-side write endpoints. `isActive` is exposed so:
//
//   * Owners can confirm a successful DELETE flipped the flag.
//   * Owners can see the active state of services returned by future
//     "list mine including inactive" endpoints.
//
// Public listing always pre-filters to `is_active = true` at the
// repository layer, so anonymous consumers never see `isActive: false`
// in practice. Keeping the field present means a single view shape and
// no semantic ambiguity.

import type { LocalizedText } from '../categories/categoryRepository.js';

import type { Service } from './serviceRepository.js';

export interface ServiceView {
    readonly id: string;
    readonly businessId: string;
    readonly name: LocalizedText;
    readonly description: LocalizedText | null;
    readonly durationMinutes: number;
    readonly priceEtb: number | null;
    readonly isActive: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export function toServiceView(service: Service): ServiceView {
    return Object.freeze<ServiceView>({
        id: service.id,
        businessId: service.businessId,
        name: service.name,
        description: service.description,
        durationMinutes: service.durationMinutes,
        priceEtb: service.priceEtb,
        isActive: service.isActive,
        createdAt: service.createdAt.toISOString(),
        updatedAt: service.updatedAt.toISOString(),
    });
}
