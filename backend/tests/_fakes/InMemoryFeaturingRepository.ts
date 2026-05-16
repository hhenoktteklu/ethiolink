// EthioLink — in-memory `FeaturingRepository` for tests.
//
// Mirrors `PgFeaturingRepository` (minus SQL) so we can exercise
// `FeaturingService` without booting Postgres. Notable parity:
//
//   * `insert` enforces the partial unique "one ACTIVE row per
//     business" rule that the SQL index enforces — a second ACTIVE
//     insert throws (simulating Postgres 23505).
//   * `findActiveByBusinessId` returns at most one row.
//   * `expireActive` flips eligible rows + returns deduped
//     business ids; idempotent.
//   * `purgePendingOlderThan` returns the count of rows deleted.
//   * `maxActiveEndsAtForBusiness` returns the max `endsAt`
//     across ACTIVE rows or `null`.
//
// Plus a test-only `seed(...)` for setting up arbitrary rows.

import { randomUUID } from 'node:crypto';

import { RepositoryError } from '../../shared/repositories/baseRepository.js';
import type {
    FeaturingRepository,
    FeaturingSubscription,
    InsertFeaturingSubscriptionInput,
    UpdateFeaturingStatusFields,
} from '../../shared/domains/featuring/featuringRepository.js';

export class InMemoryFeaturingRepository implements FeaturingRepository {
    private readonly rowsById = new Map<string, FeaturingSubscription>();

    /** Test seed: bypass `insert` to land an arbitrary row. */
    seed(subscription: FeaturingSubscription): void {
        this.rowsById.set(subscription.id, Object.freeze({ ...subscription }));
    }

    /** Test helper: total number of rows stored. */
    size(): number {
        return this.rowsById.size;
    }

    /** Test helper: snapshot every row. */
    all(): readonly FeaturingSubscription[] {
        return [...this.rowsById.values()];
    }

    async insert(
        input: InsertFeaturingSubscriptionInput,
    ): Promise<FeaturingSubscription> {
        const status = input.status ?? 'PENDING_PAYMENT';
        if (status === 'ACTIVE') {
            for (const existing of this.rowsById.values()) {
                if (
                    existing.businessId === input.businessId &&
                    existing.status === 'ACTIVE'
                ) {
                    throw new RepositoryError(
                        `Duplicate ACTIVE subscription for ${input.businessId}`,
                    );
                }
            }
        }
        const now = new Date();
        const row: FeaturingSubscription = Object.freeze({
            id: randomUUID(),
            businessId: input.businessId,
            packageCode: input.packageCode,
            priceEtb: input.priceEtb,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            status,
            source: input.source ?? 'OWNER_PURCHASE',
            cancelledAt: null,
            cancelledReason: null,
            createdByUserId: input.createdByUserId,
            createdAt: now,
            updatedAt: now,
        });
        this.rowsById.set(row.id, row);
        return row;
    }

    async findById(id: string): Promise<FeaturingSubscription | null> {
        return this.rowsById.get(id) ?? null;
    }

    async findActiveByBusinessId(
        businessId: string,
    ): Promise<FeaturingSubscription | null> {
        for (const row of this.rowsById.values()) {
            if (row.businessId === businessId && row.status === 'ACTIVE') {
                return row;
            }
        }
        return null;
    }

    async listForBusiness(
        businessId: string,
        limit: number,
    ): Promise<readonly FeaturingSubscription[]> {
        return Array.from(this.rowsById.values())
            .filter((row) => row.businessId === businessId)
            .sort(
                (a, b) =>
                    b.createdAt.getTime() - a.createdAt.getTime() ||
                    (a.id < b.id ? 1 : -1),
            )
            .slice(0, limit);
    }

    async setStatus(
        id: string,
        fields: UpdateFeaturingStatusFields,
    ): Promise<FeaturingSubscription> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`Featuring subscription ${id} not found.`);
        }
        // Mirror the partial unique index check — a second ACTIVE
        // for the same business is rejected.
        if (
            fields.status === 'ACTIVE' &&
            existing.status !== 'ACTIVE'
        ) {
            for (const row of this.rowsById.values()) {
                if (
                    row.id !== id &&
                    row.businessId === existing.businessId &&
                    row.status === 'ACTIVE'
                ) {
                    throw new RepositoryError(
                        `Duplicate ACTIVE subscription for ${existing.businessId}`,
                    );
                }
            }
        }
        const updated: FeaturingSubscription = Object.freeze({
            ...existing,
            status: fields.status,
            cancelledAt:
                fields.cancelledAt === undefined
                    ? existing.cancelledAt
                    : fields.cancelledAt,
            cancelledReason:
                fields.cancelledReason === undefined
                    ? existing.cancelledReason
                    : fields.cancelledReason,
            updatedAt: new Date(),
        });
        this.rowsById.set(id, updated);
        return updated;
    }

    async expireActive(now: Date): Promise<readonly string[]> {
        const affected = new Set<string>();
        for (const [id, row] of this.rowsById.entries()) {
            if (row.status === 'ACTIVE' && row.endsAt.getTime() < now.getTime()) {
                this.rowsById.set(
                    id,
                    Object.freeze({
                        ...row,
                        status: 'EXPIRED' as const,
                        updatedAt: new Date(),
                    }),
                );
                affected.add(row.businessId);
            }
        }
        return [...affected];
    }

    async purgePendingOlderThan(cutoff: Date): Promise<number> {
        let count = 0;
        for (const [id, row] of this.rowsById.entries()) {
            if (
                row.status === 'PENDING_PAYMENT' &&
                row.createdAt.getTime() < cutoff.getTime()
            ) {
                this.rowsById.delete(id);
                count += 1;
            }
        }
        return count;
    }

    async maxActiveEndsAtForBusiness(
        businessId: string,
    ): Promise<Date | null> {
        let max: Date | null = null;
        for (const row of this.rowsById.values()) {
            if (row.businessId === businessId && row.status === 'ACTIVE') {
                if (max === null || row.endsAt.getTime() > max.getTime()) {
                    max = row.endsAt;
                }
            }
        }
        return max;
    }
}
