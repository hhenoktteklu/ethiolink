// EthioLink — featuring subscriptions repository.
//
// Phase 9 Track 6 — owns SQL access to `featuring_subscriptions`
// (migration 0018). The service layer (`featuringService.ts`)
// holds the rules — package pricing, sweep semantics, ownership
// gating — and talks to the repository through this interface so
// unit tests swap in an in-memory fake.
//
// Notes:
//   * Column lists are spelled out (project rule).
//   * `price_etb` is `numeric(12,2)` so pg returns it as a string;
//     `mapRow` normalises to JS `number`.
//   * The active-subscription invariant is enforced by the partial
//     unique index. A second `ACTIVE` insert raises 23505; the
//     service translates that into a domain error.
//   * Sweep methods are intentionally thin — service-layer logic
//     composes them with the projection write to
//     `business_profiles.featured_until`.

import { BaseRepository, RepositoryError } from '../../repositories/baseRepository.js';

export type FeaturingPackageCode = 'FEATURING_7D' | 'FEATURING_30D';

export type FeaturingStatus =
    | 'PENDING_PAYMENT'
    | 'ACTIVE'
    | 'EXPIRED'
    | 'CANCELLED'
    | 'REFUNDED';

export type FeaturingSource = 'OWNER_PURCHASE' | 'ADMIN_COMP';

/** Domain shape of a `featuring_subscriptions` row. */
export interface FeaturingSubscription {
    readonly id: string;
    readonly businessId: string;
    readonly packageCode: FeaturingPackageCode;
    readonly priceEtb: number;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly status: FeaturingStatus;
    readonly source: FeaturingSource;
    readonly cancelledAt: Date | null;
    readonly cancelledReason: string | null;
    readonly createdByUserId: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/** Fields written by `insert`. Status defaults to `PENDING_PAYMENT`. */
export interface InsertFeaturingSubscriptionInput {
    readonly businessId: string;
    readonly packageCode: FeaturingPackageCode;
    readonly priceEtb: number;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly status?: FeaturingStatus;
    readonly source?: FeaturingSource;
    readonly createdByUserId: string;
}

/** Status fields the service mutates. Mirrors the per-status code path. */
export interface UpdateFeaturingStatusFields {
    readonly status: FeaturingStatus;
    /** Set on the same write when transitioning to CANCELLED. */
    readonly cancelledAt?: Date | null;
    readonly cancelledReason?: string | null;
}

export interface FeaturingRepository {
    insert(input: InsertFeaturingSubscriptionInput): Promise<FeaturingSubscription>;
    findById(id: string): Promise<FeaturingSubscription | null>;
    /** The single ACTIVE row for a business, or `null` when not featured. */
    findActiveByBusinessId(businessId: string): Promise<FeaturingSubscription | null>;
    /** Latest N subscriptions for a business — owner / admin history reads. */
    listForBusiness(
        businessId: string,
        limit: number,
    ): Promise<readonly FeaturingSubscription[]>;
    setStatus(
        id: string,
        fields: UpdateFeaturingStatusFields,
    ): Promise<FeaturingSubscription>;
    /**
     * Phase 9 Track 6 sweep — expire every ACTIVE row whose
     * `ends_at < now`. Returns the affected business ids so the
     * caller can recompute `featured_until` on each. Idempotent:
     * re-running on the same minute is a no-op.
     */
    expireActive(now: Date): Promise<readonly string[]>;
    /**
     * Phase 9 Track 6 sweep — delete PENDING_PAYMENT rows older
     * than the cutoff. Used to GC abandoned checkout sessions.
     */
    purgePendingOlderThan(cutoff: Date): Promise<number>;
    /**
     * Phase 9 Track 6 sweep — compute the max `ends_at` across
     * ACTIVE rows for a business. Returns `null` when none are
     * active. The caller writes the result to
     * `business_profiles.featured_until`.
     */
    maxActiveEndsAtForBusiness(businessId: string): Promise<Date | null>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface FeaturingRow {
    id: string;
    business_id: string;
    package_code: FeaturingPackageCode;
    price_etb: string | number;
    starts_at: Date;
    ends_at: Date;
    status: FeaturingStatus;
    source: FeaturingSource;
    cancelled_at: Date | null;
    cancelled_reason: string | null;
    created_by_user_id: string;
    created_at: Date;
    updated_at: Date;
}

const FEATURING_COLUMNS =
    'id, business_id, package_code, price_etb, starts_at, ends_at, ' +
    'status, source, cancelled_at, cancelled_reason, ' +
    'created_by_user_id, created_at, updated_at';

export class PgFeaturingRepository
    extends BaseRepository
    implements FeaturingRepository
{
    async insert(
        input: InsertFeaturingSubscriptionInput,
    ): Promise<FeaturingSubscription> {
        const row = await this.one<FeaturingRow>(
            `
            INSERT INTO featuring_subscriptions (
                business_id, package_code, price_etb,
                starts_at, ends_at, status, source, created_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING ${FEATURING_COLUMNS};
            `,
            [
                input.businessId,
                input.packageCode,
                input.priceEtb,
                input.startsAt,
                input.endsAt,
                input.status ?? 'PENDING_PAYMENT',
                input.source ?? 'OWNER_PURCHASE',
                input.createdByUserId,
            ],
        );
        return mapRow(row);
    }

    async findById(id: string): Promise<FeaturingSubscription | null> {
        const row = await this.oneOrNone<FeaturingRow>(
            `SELECT ${FEATURING_COLUMNS} FROM featuring_subscriptions WHERE id = $1;`,
            [id],
        );
        return row ? mapRow(row) : null;
    }

    async findActiveByBusinessId(
        businessId: string,
    ): Promise<FeaturingSubscription | null> {
        const row = await this.oneOrNone<FeaturingRow>(
            `
            SELECT ${FEATURING_COLUMNS}
              FROM featuring_subscriptions
             WHERE business_id = $1 AND status = 'ACTIVE'
             LIMIT 1;
            `,
            [businessId],
        );
        return row ? mapRow(row) : null;
    }

    async listForBusiness(
        businessId: string,
        limit: number,
    ): Promise<readonly FeaturingSubscription[]> {
        const rows = await this.many<FeaturingRow>(
            `
            SELECT ${FEATURING_COLUMNS}
              FROM featuring_subscriptions
             WHERE business_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2;
            `,
            [businessId, limit],
        );
        return rows.map(mapRow);
    }

    async setStatus(
        id: string,
        fields: UpdateFeaturingStatusFields,
    ): Promise<FeaturingSubscription> {
        const row = await this.oneOrNone<FeaturingRow>(
            `
            UPDATE featuring_subscriptions
               SET status            = $2,
                   cancelled_at      = CASE WHEN $4::boolean
                                            THEN $3 ELSE cancelled_at END,
                   cancelled_reason  = CASE WHEN $6::boolean
                                            THEN $5 ELSE cancelled_reason END
             WHERE id = $1
            RETURNING ${FEATURING_COLUMNS};
            `,
            [
                id,
                fields.status,
                fields.cancelledAt ?? null,
                fields.cancelledAt !== undefined,
                fields.cancelledReason ?? null,
                fields.cancelledReason !== undefined,
            ],
        );
        if (!row) {
            throw new RepositoryError(`Featuring subscription ${id} not found.`);
        }
        return mapRow(row);
    }

    async expireActive(now: Date): Promise<readonly string[]> {
        const result = await this.query<{ business_id: string }>(
            `
            UPDATE featuring_subscriptions
               SET status = 'EXPIRED', updated_at = now()
             WHERE status = 'ACTIVE' AND ends_at < $1
            RETURNING business_id;
            `,
            [now],
        );
        const businessIds = new Set<string>();
        for (const row of result.rows) businessIds.add(row.business_id);
        return [...businessIds];
    }

    async purgePendingOlderThan(cutoff: Date): Promise<number> {
        const result = await this.query<{ id: string }>(
            `
            DELETE FROM featuring_subscriptions
             WHERE status = 'PENDING_PAYMENT' AND created_at < $1
            RETURNING id;
            `,
            [cutoff],
        );
        return result.rowCount ?? 0;
    }

    async maxActiveEndsAtForBusiness(
        businessId: string,
    ): Promise<Date | null> {
        const row = await this.oneOrNone<{ max_ends_at: Date | null }>(
            `
            SELECT MAX(ends_at) AS max_ends_at
              FROM featuring_subscriptions
             WHERE business_id = $1 AND status = 'ACTIVE';
            `,
            [businessId],
        );
        return row?.max_ends_at ?? null;
    }
}

function mapRow(row: FeaturingRow): FeaturingSubscription {
    return Object.freeze<FeaturingSubscription>({
        id: row.id,
        businessId: row.business_id,
        packageCode: row.package_code,
        priceEtb:
            typeof row.price_etb === 'string'
                ? Number(row.price_etb)
                : row.price_etb,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status,
        source: row.source,
        cancelledAt: row.cancelled_at,
        cancelledReason: row.cancelled_reason,
        createdByUserId: row.created_by_user_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}
