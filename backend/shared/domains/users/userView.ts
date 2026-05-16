// EthioLink — JSON shapes for a user row.
//
// The repository's `User` type carries internal fields (cognito_sub, status)
// that should not appear in regular API responses. This module is the boundary
// between domain types and wire types for the users domain.
//
// Two projections:
//   * `UserView` — public/self-facing. Hides `cognito_sub` and `status`.
//     Used by `/v1/auth/sync`, `/v1/me`, and any non-admin path that
//     surfaces a user.
//   * `AdminUserView` — admin-facing. Extends `UserView` with `status`
//     so the admin dashboard can render ACTIVE / SUSPENDED / DELETED
//     bands. `cognito_sub` stays hidden — there's no admin use case
//     for it in MVP.

import type { UserRole } from '../../adapters/auth/AuthProvider.js';

import type { User, UserLocale, UserStatus } from './userRepository.js';

/** Wire shape for a user. ISO-8601 timestamps, omits internal fields. */
export interface UserView {
    readonly id: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly displayName: string | null;
    readonly role: UserRole;
    /**
     * Phase 9 Track 5: preferred UI + notification locale. Mirrors
     * `users.locale`. The Flutter app reads this at sign-in to prime
     * its UI locale; `PATCH /v1/me` lets the user mutate it.
     */
    readonly locale: UserLocale;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export function toUserView(user: User): UserView {
    return Object.freeze<UserView>({
        id: user.id,
        email: user.email,
        phone: user.phone,
        displayName: user.displayName,
        role: user.role,
        locale: user.locale,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
    });
}

/**
 * Admin projection. Adds `status` so the dashboard can colour-code
 * rows by suspension state; everything else mirrors `UserView`.
 * `cognito_sub` deliberately stays hidden.
 */
export interface AdminUserView extends UserView {
    readonly status: UserStatus;
}

export function toAdminUserView(user: User): AdminUserView {
    return Object.freeze<AdminUserView>({
        ...toUserView(user),
        status: user.status,
    });
}
