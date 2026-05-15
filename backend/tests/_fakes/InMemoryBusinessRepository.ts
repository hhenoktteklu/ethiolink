// EthioLink — in-memory `BusinessRepository` for tests.
//
// Implements the same surface as `PgBusinessRepository` (minus SQL) so
// we can exercise `BusinessService` without booting Postgres. Behavior
// mirrors the production repository:
//
//   * `insert` produces a fresh row with `status = 'DRAFT'`,
//     `rating_avg = 0`, `rating_count = 0`, both timestamps set to now.
//   * `update` applies only fields where `patch[k] !== undefined`. If
//     no field is defined, returns the existing row unchanged (no
//     `updated_at` bump), matching the SQL `update` no-op branch.
//   * `setStatus` mutates only the status column and bumps `updated_at`.
//   * `findById` / `findByOwnerUserId` return `null` when not found.
//   * `listPublic` filters `status='APPROVED'` and honors every filter
//     and the sort + cursor logic the SQL version uses.
//
// Plus a test-only `seed(business)` method for setting up rows with
// arbitrary `status`, `ratingAvg`, `featuredUntil`, and `createdAt`
// (none of which the production `insert` exposes).

import { randomUUID } from 'node:crypto';

import { RepositoryError } from '../../shared/repositories/baseRepository.js';
import type {
    AdminBusinessFilters,
    Business,
    BusinessRepository,
    BusinessStatus,
    InsertBusinessInput,
    ParsedCursor,
    PublicBusinessFilters,
    UpdateBusinessFields,
} from '../../shared/domains/businesses/businessRepository.js';

const PATCH_KEYS: ReadonlyArray<keyof UpdateBusinessFields> = [
    'categoryId',
    'name',
    'description',
    'city',
    'addressLine',
    'latitude',
    'longitude',
    'phone',
    'telegramHandle',
    'whatsappPhone',
];

export class InMemoryBusinessRepository implements BusinessRepository {
    private readonly rowsById = new Map<string, Business>();

    /** Test seed: bypass normal write paths to set status/rating/featured/etc. */
    seed(business: Business): void {
        this.rowsById.set(business.id, Object.freeze({ ...business }));
    }

    /** Test helper: total number of rows stored. */
    size(): number {
        return this.rowsById.size;
    }

    async insert(input: InsertBusinessInput): Promise<Business> {
        const now = new Date();
        const business: Business = Object.freeze({
            id: randomUUID(),
            ownerUserId: input.ownerUserId,
            categoryId: input.categoryId,
            name: input.name ?? null,
            description: input.description ?? null,
            city: input.city ?? null,
            addressLine: input.addressLine ?? null,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            phone: input.phone ?? null,
            telegramHandle: input.telegramHandle ?? null,
            whatsappPhone: input.whatsappPhone ?? null,
            status: 'DRAFT',
            featuredUntil: null,
            ratingAvg: 0,
            ratingCount: 0,
            createdAt: now,
            updatedAt: now,
        });
        this.rowsById.set(business.id, business);
        return business;
    }

    async update(id: string, patch: UpdateBusinessFields): Promise<Business> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`Business ${id} not found.`);
        }

        const hasAny = PATCH_KEYS.some((k) => patch[k] !== undefined);
        if (!hasAny) {
            return existing;
        }

        const next: { [K in keyof Business]: Business[K] } = { ...existing };
        for (const key of PATCH_KEYS) {
            const v = patch[key];
            if (v !== undefined) {
                // Cast is safe: each key maps to its matching value type in Business.
                (next as unknown as Record<string, unknown>)[key] = v as unknown;
            }
        }
        next.updatedAt = new Date();
        const frozen = Object.freeze(next) as Business;
        this.rowsById.set(id, frozen);
        return frozen;
    }

    async setStatus(id: string, status: BusinessStatus): Promise<Business> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`Business ${id} not found.`);
        }
        const next = Object.freeze<Business>({
            ...existing,
            status,
            updatedAt: new Date(),
        });
        this.rowsById.set(id, next);
        return next;
    }

    async setFeaturedUntil(
        id: string,
        featuredUntil: Date | null,
    ): Promise<Business> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`Business ${id} not found.`);
        }
        const next = Object.freeze<Business>({
            ...existing,
            featuredUntil,
            updatedAt: new Date(),
        });
        this.rowsById.set(id, next);
        return next;
    }

    async findById(id: string): Promise<Business | null> {
        return this.rowsById.get(id) ?? null;
    }

    async findByOwnerUserId(ownerUserId: string): Promise<Business | null> {
        for (const b of this.rowsById.values()) {
            if (b.ownerUserId === ownerUserId) return b;
        }
        return null;
    }

    async listPublic(
        filters: PublicBusinessFilters,
        cursor: ParsedCursor | null,
        limit: number,
    ): Promise<readonly Business[]> {
        let rows = Array.from(this.rowsById.values()).filter(
            (b) => b.status === 'APPROVED',
        );

        if (filters.categoryId !== undefined) {
            rows = rows.filter((b) => b.categoryId === filters.categoryId);
        }
        if (filters.city !== undefined) {
            const wanted = filters.city.toLowerCase();
            rows = rows.filter(
                (b) => b.city !== null && b.city.toLowerCase() === wanted,
            );
        }
        if (filters.query !== undefined) {
            const q = filters.query.toLowerCase();
            rows = rows.filter(
                (b) => b.name !== null && b.name.toLowerCase().includes(q),
            );
        }
        if (filters.ratingMin !== undefined) {
            const min = filters.ratingMin;
            rows = rows.filter((b) => b.ratingAvg >= min);
        }

        rows.sort(compareDesc);

        if (cursor) {
            rows = rows.filter((row) => rowComesAfterCursor(row, cursor));
        }

        return rows.slice(0, limit);
    }

    async listForAdmin(
        filters: AdminBusinessFilters,
        limit: number,
    ): Promise<readonly Business[]> {
        let rows = Array.from(this.rowsById.values());
        if (filters.status !== undefined) {
            rows = rows.filter((b) => b.status === filters.status);
        }
        rows.sort(
            (a, b) =>
                b.createdAt.getTime() - a.createdAt.getTime() ||
                (a.id < b.id ? 1 : -1),
        );
        return rows.slice(0, limit);
    }
}

// ---------------------------------------------------------------------------
// Sort + cursor helpers (mirror the SQL row-value comparison)
// ---------------------------------------------------------------------------

function featuredMs(featuredUntil: Date | null): number {
    return featuredUntil === null ? Number.NEGATIVE_INFINITY : featuredUntil.getTime();
}

function compareDesc(a: Business, b: Business): number {
    const aFu = featuredMs(a.featuredUntil);
    const bFu = featuredMs(b.featuredUntil);
    if (aFu !== bFu) return bFu - aFu;
    if (a.ratingAvg !== b.ratingAvg) return b.ratingAvg - a.ratingAvg;
    const aCa = a.createdAt.getTime();
    const bCa = b.createdAt.getTime();
    if (aCa !== bCa) return bCa - aCa;
    return b.id.localeCompare(a.id);
}

function rowComesAfterCursor(row: Business, cursor: ParsedCursor): boolean {
    const rowFu = featuredMs(row.featuredUntil);
    const curFu =
        cursor.sortKey.featuredUntil === null
            ? Number.NEGATIVE_INFINITY
            : Date.parse(cursor.sortKey.featuredUntil);
    if (rowFu !== curFu) return rowFu < curFu;
    if (row.ratingAvg !== cursor.sortKey.ratingAvg) {
        return row.ratingAvg < cursor.sortKey.ratingAvg;
    }
    const rowCa = row.createdAt.getTime();
    const curCa = Date.parse(cursor.sortKey.createdAt);
    if (rowCa !== curCa) return rowCa < curCa;
    return row.id < cursor.id;
}
