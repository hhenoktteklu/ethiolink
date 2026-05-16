// EthioLink — payment_intents repository.
//
// Phase 10 commit 3 — Chapa webhook handler. The webhook needs to
// look up the `payment_intents` row matching the inbound `tx_ref`
// (via the partial unique index added in migration 0019) and
// idempotently flip it to SUCCEEDED or FAILED. The service layer
// also uses this repo (in a follow-up wiring step) to INSERT a
// PENDING row when `ChapaGateway.authorize` returns a `tx_ref`.
//
// Design notes:
//
//   * **Idempotent status writes.** Both `markSucceeded` and
//     `markFailed` use a CAS-style update (`UPDATE … WHERE id = $1
//     AND status NOT IN ('SUCCEEDED', 'FAILED')`) so a replayed
//     webhook against an already-SUCCEEDED row is a no-op. The
//     methods return the current row regardless — callers branch
//     on the returned `status` rather than on whether the update
//     touched anything.
//
//   * **Insert is upsert by `provider_ref`.** The webhook may land
//     before the service-side insert in race conditions where the
//     gateway returned PENDING but the application-side INSERT
//     errored. `insertOrFindByProviderRef` uses `INSERT … ON
//     CONFLICT (provider_ref) DO NOTHING` followed by a SELECT so
//     the webhook can always produce a row to operate on. The
//     unique partial index on `provider_ref` (migration 0019) is
//     the binding guard.
//
//   * **No deletes.** Payment intents are immutable except for
//     status / raw_response. A future admin "void" tool that
//     wants to mark a SUCCEEDED row as CANCELLED for refund
//     reasons is out of scope for this commit.

import type { Pool, PoolClient } from 'pg';

import type { PaymentProvider } from '../../adapters/payments/PaymentGateway.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Status lifecycle. Matches the migration-0011 CHECK constraint.
 * `CANCELLED` is reserved for an admin-driven future surface; the
 * webhook handler only writes `SUCCEEDED` / `FAILED`.
 */
export type PaymentIntentStatus =
    | 'PENDING'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'CANCELLED';

/** Domain object — a single row of `payment_intents`. */
export interface PaymentIntent {
    readonly id: string;
    readonly appointmentId: string | null;
    readonly featuringSubscriptionId: string | null;
    readonly provider: PaymentProvider;
    readonly amountEtb: number;
    readonly status: PaymentIntentStatus;
    readonly providerRef: string | null;
    readonly rawResponse: unknown | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/**
 * Input for `insertOrFindByProviderRef`. The XOR target-id rule is
 * enforced by the DB constraint `payment_intents_target_xor` —
 * exactly one of `appointmentId` / `featuringSubscriptionId` must
 * be non-null. The repo layer relays the inputs verbatim and
 * surfaces the constraint-violation error if the caller passes
 * both / neither.
 */
export interface InsertPaymentIntentInput {
    readonly appointmentId: string | null;
    readonly featuringSubscriptionId: string | null;
    readonly provider: PaymentProvider;
    readonly amountEtb: number;
    readonly providerRef: string;
    /** Optional initial status. Defaults to `'PENDING'`. */
    readonly status?: PaymentIntentStatus;
    /** Optional raw response from the upstream initialize call. */
    readonly rawResponse?: unknown | null;
}

/** Phase 10 commit 6 — filters accepted by `listAll`. */
export interface ListPaymentIntentsFilters {
    /** Inclusive lower bound on `created_at`. */
    readonly fromUtc?: Date;
    /** Exclusive upper bound on `created_at`. */
    readonly toUtc?: Date;
    /** Restrict to a specific provider. */
    readonly provider?: PaymentProvider;
    /** Restrict to a specific status. */
    readonly status?: PaymentIntentStatus;
}

export interface PaymentIntentsRepository {
    /**
     * Look up a row by its upstream `tx_ref`. Returns null when no
     * row matches — the webhook handler treats this as the
     * "unknown tx_ref" case and replies 200 with a warning so
     * Chapa stops retrying.
     */
    findByProviderRef(providerRef: string): Promise<PaymentIntent | null>;

    /**
     * Phase 10 commit 6 — per-business reconciliation read. Returns
     * every `payment_intents` row attached to the business
     * directly (`appointment.business_id`) OR via a featuring
     * subscription. Newest first.
     */
    listForBusiness(
        businessId: string,
        limit: number,
    ): Promise<readonly PaymentIntent[]>;

    /**
     * Phase 10 commit 6 — admin cross-business reconciliation read.
     * Filters on `created_at` window, `provider`, and `status`;
     * orders newest first. Used by the admin reconciliation page
     * + (future) CSV export.
     */
    listAll(
        filters: ListPaymentIntentsFilters,
        limit: number,
    ): Promise<readonly PaymentIntent[]>;

    /**
     * Insert a PENDING row keyed by `providerRef`. If a row with the
     * same `provider_ref` already exists (replayed webhook race),
     * the existing row is returned unchanged. Idempotent.
     */
    insertOrFindByProviderRef(
        input: InsertPaymentIntentInput,
    ): Promise<PaymentIntent>;

    /**
     * Flip the row to SUCCEEDED with the verify-response payload.
     * Idempotent — repeat calls against an already-SUCCEEDED row
     * return the current row without touching `updated_at`.
     * Returns null if the row id no longer exists (impossible
     * under the CASCADE FKs, but the typed return makes the
     * caller robust).
     */
    markSucceeded(
        id: string,
        rawResponse: unknown | null,
    ): Promise<PaymentIntent | null>;

    /**
     * Flip the row to FAILED. Idempotent under the same CAS rule
     * — re-marking an already-FAILED row is a no-op; re-marking a
     * SUCCEEDED row is REFUSED (returns the SUCCEEDED row
     * unchanged). The webhook handler swallows the
     * "SUCCEEDED-can't-become-FAILED" branch as a logical no-op
     * because Chapa is the authority and a SUCCEEDED row reflects
     * a verified canonical state.
     */
    markFailed(
        id: string,
        rawResponse: unknown | null,
    ): Promise<PaymentIntent | null>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

export class PgPaymentIntentsRepository implements PaymentIntentsRepository {
    constructor(private readonly pool: Pool | PoolClient) {}

    async findByProviderRef(
        providerRef: string,
    ): Promise<PaymentIntent | null> {
        const trimmed = providerRef.trim();
        if (!trimmed) return null;
        const { rows } = await this.pool.query<DbRow>(SELECT_BY_PROVIDER_REF, [
            trimmed,
        ]);
        if (rows.length === 0) return null;
        return rowToDomain(rows[0]!);
    }

    async insertOrFindByProviderRef(
        input: InsertPaymentIntentInput,
    ): Promise<PaymentIntent> {
        const status = input.status ?? 'PENDING';
        // INSERT ... ON CONFLICT (provider_ref) DO NOTHING returns
        // no row when the conflict fires. The follow-up SELECT
        // guarantees we always have something to return.
        await this.pool.query(INSERT_PENDING_ON_CONFLICT, [
            input.appointmentId,
            input.featuringSubscriptionId,
            input.provider,
            input.amountEtb,
            status,
            input.providerRef,
            input.rawResponse ?? null,
        ]);
        const found = await this.findByProviderRef(input.providerRef);
        if (!found) {
            // Should be unreachable: the INSERT just happened (or
            // the ON CONFLICT branch fired, leaving the existing
            // row in place). Throwing makes a serialisable-isolation
            // race or migration drift loud.
            throw new Error(
                `insertOrFindByProviderRef: row not found after upsert (provider_ref=${input.providerRef}).`,
            );
        }
        return found;
    }

    async markSucceeded(
        id: string,
        rawResponse: unknown | null,
    ): Promise<PaymentIntent | null> {
        // CAS update: only mutate rows that aren't already terminal.
        // The follow-up SELECT returns the current row regardless,
        // so the caller sees the idempotent post-state.
        await this.pool.query(MARK_SUCCEEDED, [id, JSON.stringify(rawResponse)]);
        return this.findById(id);
    }

    async markFailed(
        id: string,
        rawResponse: unknown | null,
    ): Promise<PaymentIntent | null> {
        // SUCCEEDED is the only state we refuse to overwrite —
        // Chapa is the canonical authority and a verified
        // SUCCEEDED row should not be downgraded to FAILED by a
        // late replay against a different transaction.
        await this.pool.query(MARK_FAILED, [id, JSON.stringify(rawResponse)]);
        return this.findById(id);
    }

    private async findById(id: string): Promise<PaymentIntent | null> {
        const { rows } = await this.pool.query<DbRow>(SELECT_BY_ID, [id]);
        if (rows.length === 0) return null;
        return rowToDomain(rows[0]!);
    }

    async listForBusiness(
        businessId: string,
        limit: number,
    ): Promise<readonly PaymentIntent[]> {
        // Two-arm UNION: appointment-attached intents joined
        // through `appointments.business_id`, plus featuring
        // intents attached to subscriptions owned by the business.
        // ORDER BY created_at DESC across the union; LIMIT applies
        // post-union.
        const { rows } = await this.pool.query<DbRow>(
            SELECT_FOR_BUSINESS,
            [businessId, limit],
        );
        return rows.map(rowToDomain);
    }

    async listAll(
        filters: ListPaymentIntentsFilters,
        limit: number,
    ): Promise<readonly PaymentIntent[]> {
        // Hand-built dynamic WHERE — same pattern as the
        // notification-logs admin listing. `from` / `to` use
        // inclusive / exclusive bounds respectively (matches the
        // admin notification API contract).
        const clauses: string[] = [];
        const params: unknown[] = [];
        let i = 1;
        if (filters.fromUtc) {
            clauses.push(`created_at >= $${i++}`);
            params.push(filters.fromUtc);
        }
        if (filters.toUtc) {
            clauses.push(`created_at < $${i++}`);
            params.push(filters.toUtc);
        }
        if (filters.provider) {
            clauses.push(`provider = $${i++}`);
            params.push(filters.provider);
        }
        if (filters.status) {
            clauses.push(`status = $${i++}`);
            params.push(filters.status);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        params.push(limit);
        const sql = `
            SELECT id, appointment_id, featuring_subscription_id, provider,
                   amount_etb, status, provider_ref, raw_response,
                   created_at, updated_at
            FROM   payment_intents
            ${where}
            ORDER  BY created_at DESC, id DESC
            LIMIT  $${i}
        `;
        const { rows } = await this.pool.query<DbRow>(sql, params);
        return rows.map(rowToDomain);
    }
}

// ---------------------------------------------------------------------------
// In-memory implementation — test seam.
// ---------------------------------------------------------------------------

export class InMemoryPaymentIntentsRepository
    implements PaymentIntentsRepository
{
    private readonly rows = new Map<string, PaymentIntent>();
    /**
     * Side-table mapping `payment_intents.id` → owning business id.
     * The Postgres impl resolves this via JOINs through
     * `appointments` / `featuring_subscriptions`; the in-memory
     * impl can't, so the test seeder + the test-only
     * `insertOrFindByProviderRefWithBusiness` helper populate
     * this directly.
     */
    private readonly businessByIntent = new Map<string, string>();
    private autoId = 1;

    /** Test helper — seed an arbitrary row, optionally with the owning business. */
    seed(row: PaymentIntent, businessId?: string): void {
        this.rows.set(row.id, row);
        if (businessId) this.businessByIntent.set(row.id, businessId);
    }

    /** Test helper — read every row newest-first (no filters). */
    listAllRaw(): readonly PaymentIntent[] {
        return [...this.rows.values()].sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        );
    }

    /**
     * Test helper — upsert + record the owning business so the
     * `listForBusiness` path returns the row. The production
     * Postgres impl derives the business via FK JOINs and doesn't
     * need this seam; the in-memory variant does.
     */
    async insertOrFindWithBusiness(
        input: InsertPaymentIntentInput & { readonly businessId: string },
    ): Promise<PaymentIntent> {
        const row = await this.insertOrFindByProviderRef(input);
        this.businessByIntent.set(row.id, input.businessId);
        return row;
    }

    async findByProviderRef(
        providerRef: string,
    ): Promise<PaymentIntent | null> {
        const trimmed = providerRef.trim();
        for (const row of this.rows.values()) {
            if (row.providerRef === trimmed) return row;
        }
        return null;
    }

    async insertOrFindByProviderRef(
        input: InsertPaymentIntentInput,
    ): Promise<PaymentIntent> {
        const existing = await this.findByProviderRef(input.providerRef);
        if (existing) return existing;
        const id = `pi-${this.autoId++}`;
        const now = new Date();
        const row: PaymentIntent = Object.freeze<PaymentIntent>({
            id,
            appointmentId: input.appointmentId,
            featuringSubscriptionId: input.featuringSubscriptionId,
            provider: input.provider,
            amountEtb: input.amountEtb,
            status: input.status ?? 'PENDING',
            providerRef: input.providerRef,
            rawResponse: input.rawResponse ?? null,
            createdAt: now,
            updatedAt: now,
        });
        this.rows.set(id, row);
        return row;
    }

    async markSucceeded(
        id: string,
        rawResponse: unknown | null,
    ): Promise<PaymentIntent | null> {
        const current = this.rows.get(id);
        if (!current) return null;
        if (current.status === 'SUCCEEDED' || current.status === 'FAILED') {
            return current; // CAS no-op — terminal state respected.
        }
        const next: PaymentIntent = Object.freeze<PaymentIntent>({
            ...current,
            status: 'SUCCEEDED',
            rawResponse,
            updatedAt: new Date(),
        });
        this.rows.set(id, next);
        return next;
    }

    async markFailed(
        id: string,
        rawResponse: unknown | null,
    ): Promise<PaymentIntent | null> {
        const current = this.rows.get(id);
        if (!current) return null;
        if (current.status === 'SUCCEEDED' || current.status === 'FAILED') {
            return current;
        }
        const next: PaymentIntent = Object.freeze<PaymentIntent>({
            ...current,
            status: 'FAILED',
            rawResponse,
            updatedAt: new Date(),
        });
        this.rows.set(id, next);
        return next;
    }

    async listForBusiness(
        businessId: string,
        limit: number,
    ): Promise<readonly PaymentIntent[]> {
        const matches: PaymentIntent[] = [];
        for (const [intentId, ownerBusinessId] of this.businessByIntent) {
            if (ownerBusinessId === businessId) {
                const row = this.rows.get(intentId);
                if (row) matches.push(row);
            }
        }
        matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matches.slice(0, limit);
    }

    async listAll(
        filters: ListPaymentIntentsFilters,
        limit: number,
    ): Promise<readonly PaymentIntent[]> {
        const rows = [...this.rows.values()].filter((r) => {
            if (filters.fromUtc && r.createdAt < filters.fromUtc) return false;
            if (filters.toUtc && r.createdAt >= filters.toUtc) return false;
            if (filters.provider && r.provider !== filters.provider) return false;
            if (filters.status && r.status !== filters.status) return false;
            return true;
        });
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows.slice(0, limit);
    }
}

// ---------------------------------------------------------------------------
// SQL + row mapping
// ---------------------------------------------------------------------------

interface DbRow {
    id: string;
    appointment_id: string | null;
    featuring_subscription_id: string | null;
    provider: string;
    amount_etb: string; // numeric returns as string from pg
    status: string;
    provider_ref: string | null;
    raw_response: unknown | null;
    created_at: Date;
    updated_at: Date;
}

const SELECT_BY_PROVIDER_REF = `
SELECT id, appointment_id, featuring_subscription_id, provider,
       amount_etb, status, provider_ref, raw_response,
       created_at, updated_at
FROM   payment_intents
WHERE  provider_ref = $1
LIMIT  1
`;

const SELECT_BY_ID = `
SELECT id, appointment_id, featuring_subscription_id, provider,
       amount_etb, status, provider_ref, raw_response,
       created_at, updated_at
FROM   payment_intents
WHERE  id = $1
LIMIT  1
`;

// Phase 10 commit 6 — per-business reconciliation listing.
// Joins appointment-attached intents through
// `appointments.business_id` and featuring intents through
// `featuring_subscriptions.business_id`. ORDER BY + LIMIT apply
// post-union.
const SELECT_FOR_BUSINESS = `
SELECT pi.id, pi.appointment_id, pi.featuring_subscription_id,
       pi.provider, pi.amount_etb, pi.status, pi.provider_ref,
       pi.raw_response, pi.created_at, pi.updated_at
FROM   payment_intents pi
JOIN   appointments a ON a.id = pi.appointment_id
WHERE  a.business_id = $1
UNION ALL
SELECT pi.id, pi.appointment_id, pi.featuring_subscription_id,
       pi.provider, pi.amount_etb, pi.status, pi.provider_ref,
       pi.raw_response, pi.created_at, pi.updated_at
FROM   payment_intents pi
JOIN   featuring_subscriptions fs
       ON fs.id = pi.featuring_subscription_id
WHERE  fs.business_id = $1
ORDER  BY created_at DESC, id DESC
LIMIT  $2
`;

const INSERT_PENDING_ON_CONFLICT = `
INSERT INTO payment_intents
    (appointment_id, featuring_subscription_id, provider,
     amount_etb, status, provider_ref, raw_response)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (provider_ref) WHERE provider_ref IS NOT NULL
DO NOTHING
`;

// CAS: only flip non-terminal rows. Idempotent — re-running
// against an already-SUCCEEDED row is a no-op.
const MARK_SUCCEEDED = `
UPDATE payment_intents
SET    status = 'SUCCEEDED',
       raw_response = $2::jsonb
WHERE  id = $1
  AND  status NOT IN ('SUCCEEDED', 'FAILED')
`;

// CAS: refuse to overwrite SUCCEEDED. Re-marking an already-FAILED
// row is a no-op.
const MARK_FAILED = `
UPDATE payment_intents
SET    status = 'FAILED',
       raw_response = $2::jsonb
WHERE  id = $1
  AND  status NOT IN ('SUCCEEDED', 'FAILED')
`;

function rowToDomain(r: DbRow): PaymentIntent {
    return Object.freeze<PaymentIntent>({
        id: r.id,
        appointmentId: r.appointment_id,
        featuringSubscriptionId: r.featuring_subscription_id,
        provider: r.provider as PaymentProvider,
        amountEtb: Number(r.amount_etb),
        status: r.status as PaymentIntentStatus,
        providerRef: r.provider_ref,
        rawResponse: r.raw_response,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    });
}
