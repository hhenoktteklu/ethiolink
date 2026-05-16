// EthioLink — in-memory `ServiceRepository` for tests.
//
// Mirrors `PgServiceRepository` semantics:
//   * `insert` creates with `is_active = true` and now() timestamps.
//   * `update` applies only fields where `patch[k] !== undefined`. An
//     all-undefined patch is a no-op and returns the existing row
//     unchanged (matches the SQL repo's "skip the UPDATE when no SETs").
//   * `setIsActive` flips the flag and bumps updatedAt.
//   * Lookups return `null` when not found.
//   * `listActiveForBusiness` filters `is_active = true` and sorts by
//     `created_at ASC, id ASC` — same as the SQL `ORDER BY`.

import { randomUUID } from 'node:crypto';

import { RepositoryError } from '../../shared/repositories/baseRepository.js';
import type {
    InsertServiceInput,
    Service,
    ServiceRepository,
    UpdateServiceFields,
} from '../../shared/domains/services/serviceRepository.js';

const PATCH_KEYS: ReadonlyArray<keyof UpdateServiceFields> = [
    'name',
    'description',
    'durationMinutes',
    'priceEtb',
];

export class InMemoryServiceRepository implements ServiceRepository {
    private readonly rowsById = new Map<string, Service>();

    /**
     * Monotonic clock for `createdAt`. `new Date()` on its own collides
     * at sub-millisecond resolution when two inserts happen back-to-back
     * in the same event-loop turn, which collapses the `created_at ASC,
     * id ASC` order into pure UUID-lex order. Pg's `now()` has μs
     * precision so the production listing is naturally strict-monotonic;
     * the fake mirrors that by bumping by 1ms per insert.
     */
    private nextTimestampMs = Date.now();

    private nextTimestamp(): Date {
        const candidate = Math.max(this.nextTimestampMs + 1, Date.now());
        this.nextTimestampMs = candidate;
        return new Date(candidate);
    }

    /** Test seed: bypass `insert` to fix the id / timestamps / isActive. */
    seed(service: Service): void {
        this.rowsById.set(service.id, Object.freeze({ ...service }));
    }

    size(): number {
        return this.rowsById.size;
    }

    async insert(input: InsertServiceInput): Promise<Service> {
        const now = this.nextTimestamp();
        const row: Service = Object.freeze({
            id: randomUUID(),
            businessId: input.businessId,
            name: Object.freeze({ ...input.name }),
            description: input.description ? Object.freeze({ ...input.description }) : null,
            durationMinutes: input.durationMinutes,
            priceEtb: input.priceEtb ?? null,
            isActive: true,
            createdAt: now,
            updatedAt: now,
        });
        this.rowsById.set(row.id, row);
        return row;
    }

    async update(id: string, patch: UpdateServiceFields): Promise<Service> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`Service ${id} not found.`);
        }

        const hasAny = PATCH_KEYS.some((k) => patch[k] !== undefined);
        if (!hasAny) {
            return existing;
        }

        // `-readonly` strips the readonly modifier so we can assign
        // to `updatedAt` below; the row is frozen again before being
        // stored.
        const next: { -readonly [K in keyof Service]: Service[K] } = { ...existing };
        for (const key of PATCH_KEYS) {
            const v = patch[key];
            if (v !== undefined) {
                (next as unknown as Record<string, unknown>)[key] = v as unknown;
            }
        }
        next.updatedAt = new Date();
        const frozen = Object.freeze(next) as Service;
        this.rowsById.set(id, frozen);
        return frozen;
    }

    async setIsActive(id: string, isActive: boolean): Promise<Service> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`Service ${id} not found.`);
        }
        const next = Object.freeze<Service>({
            ...existing,
            isActive,
            updatedAt: new Date(),
        });
        this.rowsById.set(id, next);
        return next;
    }

    async findById(id: string): Promise<Service | null> {
        return this.rowsById.get(id) ?? null;
    }

    async listActiveForBusiness(businessId: string): Promise<readonly Service[]> {
        return Array.from(this.rowsById.values())
            .filter((s) => s.businessId === businessId && s.isActive)
            .sort((a, b) => {
                const ca = a.createdAt.getTime();
                const cb = b.createdAt.getTime();
                if (ca !== cb) return ca - cb;
                return a.id.localeCompare(b.id);
            });
    }
}
