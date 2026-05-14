// EthioLink — user repository.
//
// Owns SQL access to the `users` table. The service layer talks to the
// `UserRepository` interface, not directly to `PgUserRepository`, so unit
// tests can swap in an in-memory fake (see the Phase 1 task file:
// "Unit tests for userService ... using an in-memory repository fake").
//
// Notes:
//   * No `SELECT *` (project rule). Column lists are spelled out.
//   * `email` is `citext` in the database; comparisons and storage are
//     case-insensitive. We still lower-case at the adapter boundary so
//     application logic can rely on a canonical form.
//   * `upsertFromAuth` is the only write path used by `/v1/auth/sync`. It is
//     deliberately idempotent: same Cognito principal → same row state.
//     `status` is set on INSERT and never touched on UPDATE, because admin
//     actions (suspend/restore) are the only legitimate status mutators.

import type { UserRole } from '../../adapters/auth/AuthProvider.js';
import { BaseRepository, RepositoryError } from '../../repositories/baseRepository.js';

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

/** Domain shape of a user row. Dates are JavaScript `Date` (pg parses timestamptz). */
export interface User {
    readonly id: string;
    readonly cognitoSub: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly role: UserRole;
    readonly status: UserStatus;
    readonly displayName: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/** Fields written by `/v1/auth/sync`. Email may already be lower-cased by the adapter. */
export interface UpsertUserFromAuthInput {
    readonly cognitoSub: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly role: UserRole;
    readonly displayName: string | null;
}

/**
 * Fields mutable through `PATCH /v1/me`. Only `displayName` is mutable in
 * Phase 1; `preferredCity` will be added once the `customer_profiles` table
 * is created (currently out of scope for Phase 1).
 *
 * `undefined` means "leave unchanged"; an explicit `null` means "clear the
 * field". This shape mirrors the JSON patch semantics expected at the HTTP
 * boundary.
 */
export interface UpdateUserFields {
    readonly displayName?: string | null;
}

export interface UserRepository {
    upsertFromAuth(input: UpsertUserFromAuthInput): Promise<User>;
    findById(id: string): Promise<User | null>;
    findByCognitoSub(cognitoSub: string): Promise<User | null>;
    update(id: string, patch: UpdateUserFields): Promise<User>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface UserRow {
    id: string;
    cognito_sub: string;
    email: string | null;
    phone: string | null;
    role: UserRole;
    status: UserStatus;
    display_name: string | null;
    created_at: Date;
    updated_at: Date;
}

const USER_COLUMNS =
    'id, cognito_sub, email, phone, role, status, display_name, created_at, updated_at';

export class PgUserRepository extends BaseRepository implements UserRepository {
    async upsertFromAuth(input: UpsertUserFromAuthInput): Promise<User> {
        const row = await this.one<UserRow>(
            `
            INSERT INTO users (cognito_sub, email, phone, role, display_name)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (cognito_sub) DO UPDATE
                SET email        = EXCLUDED.email,
                    phone        = EXCLUDED.phone,
                    role         = EXCLUDED.role,
                    display_name = EXCLUDED.display_name
            RETURNING ${USER_COLUMNS};
            `,
            [input.cognitoSub, input.email, input.phone, input.role, input.displayName],
        );
        return mapRow(row);
    }

    async findById(id: string): Promise<User | null> {
        const row = await this.oneOrNone<UserRow>(
            `SELECT ${USER_COLUMNS} FROM users WHERE id = $1;`,
            [id],
        );
        return row ? mapRow(row) : null;
    }

    async findByCognitoSub(cognitoSub: string): Promise<User | null> {
        const row = await this.oneOrNone<UserRow>(
            `SELECT ${USER_COLUMNS} FROM users WHERE cognito_sub = $1;`,
            [cognitoSub],
        );
        return row ? mapRow(row) : null;
    }

    async update(id: string, patch: UpdateUserFields): Promise<User> {
        // Phase 1 only allows display_name. Skip the round-trip if nothing changed.
        if (patch.displayName === undefined) {
            const existing = await this.findById(id);
            if (!existing) {
                throw new RepositoryError(`User ${id} not found.`);
            }
            return existing;
        }

        const row = await this.oneOrNone<UserRow>(
            `
            UPDATE users
               SET display_name = $2
             WHERE id = $1
            RETURNING ${USER_COLUMNS};
            `,
            [id, patch.displayName],
        );
        if (!row) {
            throw new RepositoryError(`User ${id} not found.`);
        }
        return mapRow(row);
    }
}

function mapRow(row: UserRow): User {
    return Object.freeze<User>({
        id: row.id,
        cognitoSub: row.cognito_sub,
        email: row.email,
        phone: row.phone,
        role: row.role,
        status: row.status,
        displayName: row.display_name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}
