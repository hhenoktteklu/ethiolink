// EthioLink — service (offering) repository.
//
// SQL access to the `services` table. Each row is one bookable
// offering — name, optional description, duration, optional price.
// The `serviceService` layer enforces ownership and policy; this
// repository is dumb on purpose.
//
// Listing order: `created_at ASC, id ASC`. Business owners add their
// services in some order; that order is what customers see on the
// profile. Stable and deterministic across calls.
//
// Soft-delete via `is_active = false`. The DELETE endpoint flips this
// flag, never removes rows — historical appointments will reference
// the service via `appointments.service_id ON DELETE RESTRICT`.

import type { LocalizedText } from '../categories/categoryRepository.js';
import { BaseRepository, RepositoryError } from '../../repositories/baseRepository.js';

/** Domain shape of a `services` row. */
export interface Service {
    readonly id: string;
    readonly businessId: string;
    readonly name: LocalizedText;
    readonly description: LocalizedText | null;
    readonly durationMinutes: number;
    readonly priceEtb: number | null;
    readonly isActive: boolean;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/** Fields written by `insert`. `businessId`, `name`, `durationMinutes` required. */
export interface InsertServiceInput {
    readonly businessId: string;
    readonly name: LocalizedText;
    readonly description?: LocalizedText | null;
    readonly durationMinutes: number;
    readonly priceEtb?: number | null;
}

/**
 * Fields mutable through `update`. `undefined` = no change; `null` (where
 * the type allows) clears the column. `name` and `durationMinutes` are
 * not nullable in the DB and cannot be cleared. `isActive` is mutated
 * through `setIsActive`, not patched, so the soft-delete intent stays
 * explicit at every call site.
 */
export interface UpdateServiceFields {
    readonly name?: LocalizedText;
    readonly description?: LocalizedText | null;
    readonly durationMinutes?: number;
    readonly priceEtb?: number | null;
}

export interface ServiceRepository {
    insert(input: InsertServiceInput): Promise<Service>;
    update(id: string, patch: UpdateServiceFields): Promise<Service>;
    setIsActive(id: string, isActive: boolean): Promise<Service>;
    findById(id: string): Promise<Service | null>;
    listActiveForBusiness(businessId: string): Promise<readonly Service[]>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface ServiceRow {
    id: string;
    business_id: string;
    name: LocalizedText;
    description: LocalizedText | null;
    duration_minutes: number;
    price_etb: string | number | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
}

const SERVICE_COLUMNS =
    'id, business_id, name, description, duration_minutes, price_etb, is_active, created_at, updated_at';

const PATCHABLE_COLUMNS: Readonly<Record<keyof UpdateServiceFields, string>> = Object.freeze({
    name: 'name',
    description: 'description',
    durationMinutes: 'duration_minutes',
    priceEtb: 'price_etb',
});

export class PgServiceRepository extends BaseRepository implements ServiceRepository {
    async insert(input: InsertServiceInput): Promise<Service> {
        const row = await this.one<ServiceRow>(
            `
            INSERT INTO services (
                business_id, name, description, duration_minutes, price_etb
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING ${SERVICE_COLUMNS};
            `,
            [
                input.businessId,
                input.name,
                input.description ?? null,
                input.durationMinutes,
                input.priceEtb ?? null,
            ],
        );
        return mapRow(row);
    }

    async update(id: string, patch: UpdateServiceFields): Promise<Service> {
        const sets: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        for (const [camelKey, column] of Object.entries(PATCHABLE_COLUMNS) as Array<
            [keyof UpdateServiceFields, string]
        >) {
            const value = patch[camelKey];
            if (value === undefined) continue;
            sets.push(`${column} = $${idx}`);
            params.push(value);
            idx += 1;
        }

        if (sets.length === 0) {
            const current = await this.findById(id);
            if (!current) throw new RepositoryError(`Service ${id} not found.`);
            return current;
        }

        params.push(id);
        const row = await this.oneOrNone<ServiceRow>(
            `
            UPDATE services
               SET ${sets.join(', ')}
             WHERE id = $${idx}
            RETURNING ${SERVICE_COLUMNS};
            `,
            params,
        );
        if (!row) throw new RepositoryError(`Service ${id} not found.`);
        return mapRow(row);
    }

    async setIsActive(id: string, isActive: boolean): Promise<Service> {
        const row = await this.oneOrNone<ServiceRow>(
            `
            UPDATE services
               SET is_active = $2
             WHERE id = $1
            RETURNING ${SERVICE_COLUMNS};
            `,
            [id, isActive],
        );
        if (!row) throw new RepositoryError(`Service ${id} not found.`);
        return mapRow(row);
    }

    async findById(id: string): Promise<Service | null> {
        const row = await this.oneOrNone<ServiceRow>(
            `SELECT ${SERVICE_COLUMNS} FROM services WHERE id = $1;`,
            [id],
        );
        return row ? mapRow(row) : null;
    }

    async listActiveForBusiness(businessId: string): Promise<readonly Service[]> {
        const rows = await this.many<ServiceRow>(
            `
            SELECT ${SERVICE_COLUMNS}
              FROM services
             WHERE business_id = $1
               AND is_active = true
             ORDER BY created_at ASC, id ASC;
            `,
            [businessId],
        );
        return rows.map(mapRow);
    }
}

function mapRow(row: ServiceRow): Service {
    // `numeric(12,2)` columns are returned by pg as strings to preserve
    // precision; coerce to a number here so callers don't have to.
    const price =
        row.price_etb === null
            ? null
            : typeof row.price_etb === 'string'
              ? Number(row.price_etb)
              : row.price_etb;

    return Object.freeze<Service>({
        id: row.id,
        businessId: row.business_id,
        name: Object.freeze({ ...row.name }),
        description: row.description ? Object.freeze({ ...row.description }) : null,
        durationMinutes: row.duration_minutes,
        priceEtb: price,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}
