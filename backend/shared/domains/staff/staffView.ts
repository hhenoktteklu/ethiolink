// EthioLink — public JSON shape for a staff member.
//
// Single projection used by both the public listing endpoint and the
// owner-side write endpoints. `isActive` is exposed so:
//
//   * Owners can confirm a successful DELETE flipped the flag.
//   * Owners can see the active state of staff returned by future
//     "list mine including inactive" endpoints.
//
// Public listing always pre-filters to `is_active = true` at the
// repository layer, so anonymous consumers never see `isActive: false`
// in practice. Keeping the field present means a single view shape and
// no semantic ambiguity. Matches the pattern in `serviceView.ts`.

import type { StaffMember } from './staffRepository.js';

export interface StaffView {
    readonly id: string;
    readonly businessId: string;
    readonly displayName: string;
    readonly role: string | null;
    readonly isActive: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export function toStaffView(staff: StaffMember): StaffView {
    return Object.freeze<StaffView>({
        id: staff.id,
        businessId: staff.businessId,
        displayName: staff.displayName,
        role: staff.role,
        isActive: staff.isActive,
        createdAt: staff.createdAt.toISOString(),
        updatedAt: staff.updatedAt.toISOString(),
    });
}
