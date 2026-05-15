// EthioLink — notification log repository.
//
// SQL access to the `notification_logs` table (migration 0013).
// The dispatch lifecycle is "create QUEUED row → call gateway →
// transition to SENT / FAILED", which the repository encodes as
// exactly two write paths:
//
//   * `insert(input)` — writes the row at `status = 'QUEUED'`
//     (the DB default). Returns the inserted `NotificationLogRow`.
//   * `updateStatus(id, update)` — the only mutation. Writes
//     `status`, `provider_ref`, `error_message`. Nothing else moves
//     after the row is created: `recipient_user_id`, `channel`,
//     `template_key`, `payload` are all immutable post-insert. A
//     notification attempt represents a fixed intent against a
//     specific recipient; rewriting any of those columns would
//     defeat the audit-trail purpose of the table.
//
// Reads:
//   * `findById(id)` — point lookup. No filter; soft-delete is not
//     a concept here (the schema deliberately omits `deleted_at`).
//   * `listForAdmin(filters, limit)` — newest-first listing for
//     the admin troubleshooting endpoint. Filters by `status` /
//     `channel` / `recipientUserId` / a `created_at` date range
//     bounded by `fromUtc` / `toUtc`. No cursor pagination in
//     MVP — the admin caps the result at the call site.
//
// Design notes:
//   * `NotificationChannel` is a closed union (matches the
//     migration 0013 CHECK constraint). Adding a new channel is a
//     coupled change with a real provider integration, so the
//     CHECK + the TS union both move together.
//   * `NotificationStatus` is a closed union mirroring the CHECK
//     list. `DELIVERED` has no MVP producer; it's reserved for a
//     future read-receipt flow. The repository accepts it on
//     `updateStatus` without ceremony so the producer can land
//     without a repository change.
//   * `templateKey` is `string`, not a union — application-layer
//     additive enum, no DB CHECK (same stance as
//     `admin_actions.action`). The future `templateRegistry`
//     module owns the authoritative TS union; this layer stays
//     permissive so the registry can grow without a repository
//     touch.
//   * `provider` is `string` for the same reason — real provider
//     names (e.g. `'TELEBIRR_SMS'`, `'CHAPA_EMAIL'`) ship as
//     code-only changes.

import { BaseRepository, RepositoryError } from '../../repositories/baseRepository.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationChannel = 'SMS' | 'EMAIL' | 'TELEGRAM' | 'PUSH' | 'MOCK';

export type NotificationStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED';

/**
 * Domain shape of a `notification_logs` row. `payload` is the
 * JSONB column the dispatcher writes (template variables) — the
 * repository deliberately doesn't type it beyond
 * `Record<string, unknown>` because each `templateKey` has its
 * own shape that the registry module owns.
 */
export interface NotificationLogRow {
    readonly id: string;
    readonly recipientUserId: string | null;
    readonly channel: NotificationChannel;
    readonly templateKey: string;
    readonly payload: Record<string, unknown>;
    readonly status: NotificationStatus;
    readonly provider: string;
    readonly providerRef: string | null;
    readonly errorMessage: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

/**
 * Fields written by `insert`. `status` is intentionally NOT here
 * — the DB default of `'QUEUED'` is the only legal initial state.
 * `provider` is optional; if omitted, the DB default of `'MOCK'`
 * applies. The dispatcher overrides it when it knows which real
 * provider it will call.
 */
export interface InsertNotificationLogInput {
    readonly recipientUserId: string | null;
    readonly channel: NotificationChannel;
    readonly templateKey: string;
    readonly payload: Record<string, unknown>;
    readonly provider?: string;
}

/**
 * Fields written by `updateStatus`. Every field is required so the
 * caller doesn't accidentally clear `provider_ref` when only
 * intending to set `error_message` (or vice versa). On a
 * QUEUED→SENT transition, pass `errorMessage: null`; on a
 * QUEUED→FAILED transition, pass `providerRef: null`.
 */
export interface UpdateNotificationLogStatusInput {
    readonly status: NotificationStatus;
    readonly providerRef: string | null;
    readonly errorMessage: string | null;
}

/**
 * Filters accepted by `listForAdmin`. All optional. The date
 * range bounds `created_at` (not `updated_at`) — the admin's
 * mental model is "what was attempted in this window", not
 * "what changed state in this window".
 */
export interface AdminNotificationLogFilters {
    readonly status?: NotificationStatus;
    readonly channel?: NotificationChannel;
    readonly recipientUserId?: string;
    /** Inclusive lower bound on `created_at`. */
    readonly fromUtc?: Date;
    /** Exclusive upper bound on `created_at`. */
    readonly toUtc?: Date;
}

/**
 * Lookup key for {@link NotificationLogRepository.existsForAppointmentSlot}.
 * The reminder lambda uses this triple as the idempotency
 * fingerprint for a single (template × recipient × appointment-
 * instance) reminder — two scans that pick up the same
 * appointment in the same window will not both fire.
 */
export interface AppointmentSlotDispatchKey {
    readonly templateKey: string;
    readonly recipientUserId: string;
    /** UTC ISO-8601 string. Matched against
     *  `notification_logs.payload->>'startsAtUtc'` (see
     *  `BookingTemplatePayload`). */
    readonly startsAtUtc: string;
}

export interface NotificationLogRepository {
    insert(input: InsertNotificationLogInput): Promise<NotificationLogRow>;
    updateStatus(
        id: string,
        update: UpdateNotificationLogStatusInput,
    ): Promise<NotificationLogRow>;
    findById(id: string): Promise<NotificationLogRow | null>;
    listForAdmin(
        filters: AdminNotificationLogFilters,
        limit: number,
    ): Promise<readonly NotificationLogRow[]>;
    /**
     * Idempotency check for the EventBridge-driven reminder
     * lambda. Returns `true` if ANY row already exists for the
     * given `(template_key, recipient_user_id,
     * payload->>'startsAtUtc')` triple — regardless of status
     * (QUEUED / SENT / DELIVERED / FAILED).
     *
     * Counting FAILED as "already attempted" is deliberate: the
     * reminder cadence (15-minute scans of a 15-minute window)
     * means a permanently-broken provider for one user would
     * otherwise blast the same row every cycle until the cutoff
     * passes. The admin can manually clear a failed log row to
     * force a retry. (See PHASE_6_NOTIFICATIONS.md.)
     *
     * Implemented as a `SELECT 1 … LIMIT 1` — no row data is
     * returned, the call is a `bool` regardless of how many
     * matching rows exist.
     */
    existsForAppointmentSlot(
        key: AppointmentSlotDispatchKey,
    ): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface NotificationLogDbRow {
    id: string;
    recipient_user_id: string | null;
    channel: NotificationChannel;
    template_key: string;
    payload: Record<string, unknown>;
    status: NotificationStatus;
    provider: string;
    provider_ref: string | null;
    error_message: string | null;
    created_at: Date;
    updated_at: Date;
}

const COLUMNS = [
    'id',
    'recipient_user_id',
    'channel',
    'template_key',
    'payload',
    'status',
    'provider',
    'provider_ref',
    'error_message',
    'created_at',
    'updated_at',
].join(', ');

export class PgNotificationLogRepository
    extends BaseRepository
    implements NotificationLogRepository
{
    async insert(input: InsertNotificationLogInput): Promise<NotificationLogRow> {
        // `status` is omitted — the DB default of 'QUEUED' applies.
        // `provider` is COALESCEd against the input so a missing
        // value lets the DB default of 'MOCK' kick in.
        const row = await this.one<NotificationLogDbRow>(
            `
            INSERT INTO notification_logs (
                recipient_user_id, channel, template_key, payload, provider
            )
            VALUES ($1, $2, $3, $4::jsonb, COALESCE($5, 'MOCK'))
            RETURNING ${COLUMNS};
            `,
            [
                input.recipientUserId,
                input.channel,
                input.templateKey,
                JSON.stringify(input.payload),
                input.provider ?? null,
            ],
        );
        return mapRow(row);
    }

    async updateStatus(
        id: string,
        update: UpdateNotificationLogStatusInput,
    ): Promise<NotificationLogRow> {
        const row = await this.oneOrNone<NotificationLogDbRow>(
            `
            UPDATE notification_logs
               SET status        = $2,
                   provider_ref  = $3,
                   error_message = $4
             WHERE id = $1
            RETURNING ${COLUMNS};
            `,
            [id, update.status, update.providerRef, update.errorMessage],
        );
        if (!row) {
            throw new RepositoryError(`Notification log ${id} not found.`);
        }
        return mapRow(row);
    }

    async findById(id: string): Promise<NotificationLogRow | null> {
        const row = await this.oneOrNone<NotificationLogDbRow>(
            `SELECT ${COLUMNS} FROM notification_logs WHERE id = $1;`,
            [id],
        );
        return row ? mapRow(row) : null;
    }

    async existsForAppointmentSlot(
        key: AppointmentSlotDispatchKey,
    ): Promise<boolean> {
        const row = await this.oneOrNone<{ present: number }>(
            `
            SELECT 1 AS present
              FROM notification_logs
             WHERE template_key            = $1
               AND recipient_user_id       = $2
               AND payload->>'startsAtUtc' = $3
             LIMIT 1;
            `,
            [key.templateKey, key.recipientUserId, key.startsAtUtc],
        );
        return row !== null;
    }

    async listForAdmin(
        filters: AdminNotificationLogFilters,
        limit: number,
    ): Promise<readonly NotificationLogRow[]> {
        const rows = await this.many<NotificationLogDbRow>(
            `
            SELECT ${COLUMNS}
              FROM notification_logs
             WHERE ($1::text        IS NULL OR status            = $1)
               AND ($2::text        IS NULL OR channel           = $2)
               AND ($3::uuid        IS NULL OR recipient_user_id = $3)
               AND ($4::timestamptz IS NULL OR created_at       >= $4)
               AND ($5::timestamptz IS NULL OR created_at       <  $5)
             ORDER BY created_at DESC, id DESC
             LIMIT $6;
            `,
            [
                filters.status ?? null,
                filters.channel ?? null,
                filters.recipientUserId ?? null,
                filters.fromUtc ?? null,
                filters.toUtc ?? null,
                limit,
            ],
        );
        return rows.map(mapRow);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRow(row: NotificationLogDbRow): NotificationLogRow {
    return Object.freeze<NotificationLogRow>({
        id: row.id,
        recipientUserId: row.recipient_user_id,
        channel: row.channel,
        templateKey: row.template_key,
        // `pg` parses jsonb into a JavaScript object automatically.
        // Freezing the reference keeps the row immutable post-map.
        payload: Object.freeze({ ...row.payload }),
        status: row.status,
        provider: row.provider,
        providerRef: row.provider_ref,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}
