// EthioLink — staff (members) repository.
//
// SQL access to the `staff_members` table. Each row is one bookable
// person — display name and optional free-text role title. The
// `staffService` layer enforces ownership and policy; this repository
// is dumb on purpose.
//
// Listing order: `created_at ASC, id ASC`. Business owners add staff
// in some order; that order is what customers see on the profile.
// Stable across calls.
//
// Soft-delete via `is_active = false`. The DELETE endpoint flips this
// flag, never removes rows — historical appointments reference
// staff via `appointments.staff_id ON DELETE RESTRICT`.

import { BaseRepository, RepositoryError } from '../../repositories/baseRepository.js';

/** Domain shape of a `staff_members` row. */
export interface StaffMember {
    readonly id: string;
    readonly businessId: string;
    readonly displayName: string;
    readonly role: string | null;
    readonly isActive: boolean;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/** Fields written by `insert`. `businessId` and `displayName` required. */
export interface InsertStaffInput {
    readonly businessId: string;
    readonly displayName: string;
    readonly role?: string | null;
}

/**
 * Fields mutable through `update`. `undefined` = no change; `null`
 * (where the type allows) clears the column. `displayName` is NOT
 * NULL in the DB and cannot be cleared. `isActive` is mutated through
 * `setIsActive`, not patched.
 */
export interface UpdateStaffFields {
    readonly displayName?: string;
    readonly role?: string | null;
}

export interface StaffRepository {
    insert(input: InsertStaffInput): Promise<StaffMember>;
    update(id: string, patch: UpdateStaffFields): Promise<StaffMember>;
    setIsActive(id: string, isActive: boolean): Promise<StaffMember>;
    findById(id: string): Promise<StaffMember | null>;
    listActiveForBusiness(businessId: string): Promise<readonly StaffMember[]>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface StaffRow {
    id: string;
    business_id: string;
    display_name: string;
    role: string | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}

const STAFF_COLUMNS =
    'id, business_id, display_name, role, is_active, created_at, updated_at';

const PATCHABLE_COLUMNS: Readonly<Record<keyof UpdateStaffFields, string>> = Object.freeze({
    displayName: 'display_name',
    role: 'role',
});

export class PgStaffRepository extends BaseRepository implements StaffRepository {
    async insert(input: InsertStaffInput): Promise<StaffMember> {
        const row = await this.one<StaffRow>(
            `
            INSERT INTO staff_members (business_id, display_name, role)
            VALUES ($1, $2, $3)
            RETURNING ${STAFF_COLUMNS};
            `,
            [input.businessId, input.displayName, input.role ?? null],
        );
        return mapRow(row);
    }

    async update(id: string, patch: UpdateStaffFields): Promise<StaffMember> {
        const sets: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        for (const [camelKey, column] of Object.entries(PATCHABLE_COLUMNS) as Array<
            [keyof UpdateStaffFields, string]
        >) {
            const value = patch[camelKey];
            if (value === undefined) continue;
            sets.push(`${column} = $${idx}`);
            params.push(value);
            idx += 1;
        }

        if (sets.length === 0) {
            const current = await this.findById(id);
            if (!current) throw new RepositoryError(`Staff member ${id} not found.`);
            return current;
        }

        params.push(id);
        const row = await this.oneOrNone<StaffRow>(
            `
            UPDATE staff_members
               SET ${sets.join(', ')}
             WHERE id = $${idx}
            RETURNING ${STAFF_COLUMNS};
            `,
            params,
        );
        if (!row) throw new RepositoryError(`Staff member ${id} not found.`);
        return mapRow(row);
    }

    async setIsActive(id: string, isActive: boolean): Promise<StaffMember> {
        const row = await this.oneOrNone<StaffRow>(
            `
            UPDATE staff_members
               SET is_active = $2
             WHERE id = $1
            RETURNING ${STAFF_COLUMNS};
            `,
            [id, isActive],
        );
        if (!row) throw new RepositoryError(`Staff member ${id} not found.`);
        return mapRow(row);
    }

    async findById(id: string): Promise<StaffMember | null> {
        const row = await this.oneOrNone<StaffRow>(
            `SELECT ${STAFF_COLUMNS} FROM staff_members WHERE id = $1;`,
            [id],
        );
        return row ? mapRow(row) : null;
    }

    async listActiveForBusiness(businessId: string): Promise<readonly StaffMember[]> {
        const rows = await this.many<StaffRow>(
            `
            SELECT ${STAFF_COLUMNS}
              FROM staff_members
             WHERE business_id = $1
               AND is_active = true
             ORDER BY created_at ASC, id ASC;
            `,
            [businessId],
        );
        return rows.map(mapRow);
    }
}

function mapRow(row: StaffRow): StaffMember {
    return Object.freeze<StaffMember>({
        id: row.id,
        businessId: row.business_id,
        displayName: row.display_name,
        role: row.role,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}
