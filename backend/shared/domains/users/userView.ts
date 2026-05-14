// EthioLink — public JSON shape for a user row.
//
// The repository's `User` type carries internal fields (cognito_sub, status)
// that should not appear in API responses. This module is the boundary
// between domain types and wire types for the users domain.
//
// Used by `/v1/auth/sync`, `/v1/me`, and any future endpoint that needs to
// surface a user. Keeping the projection in one place means a column added
// to `users` does not automatically leak to clients.

import type { UserRole } from '../../adapters/auth/AuthProvider.js';

import type { User } from './userRepository.js';

/** Wire shape for a user. ISO-8601 timestamps, omits internal fields. */
export interface UserView {
    readonly id: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly displayName: string | null;
    readonly role: UserRole;
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
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
    });
}
