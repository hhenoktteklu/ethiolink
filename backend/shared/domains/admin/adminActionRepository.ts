// EthioLink — admin actions repository.
//
// Append-only access to the `admin_actions` table (migration 0012).
// Three methods only — `insert`, `listByAdmin`, `listForTarget`. No
// `update`, no `delete`, no `setStatus`, and there never will be: the
// whole value of the audit log is that recorded rows cannot be
// quietly rewritten. A bug that recorded the wrong action is fixed
// forward by appending a new row, not by editing history.
//
// Design notes:
//   * **`AdminAction` is the application-layer enum.** The
//     `admin_actions.action` column has no CHECK constraint at the
//     DB (per migration 0012 — "additive: extend, never rename" is
//     a code-only contract). Adding a new variant lands in this
//     file; no migration required. Removing or renaming an existing
//     variant is a breaking change to the audit history and should
//     be done via a `*_V2` rename pattern, never an in-place
//     mutation.
//   * **`AdminTargetType` is the polymorphic discriminator.** The
//     `target_id` column is `uuid NOT NULL` without a foreign key
//     (migration 0012's "soft constraint" stance). The admin service
//     validates that `(targetType, targetId)` resolves to a real row
//     at write time; the repository does not.
//   * **Sort order: `created_at DESC, id DESC`.** Both list paths
//     return newest-first to match the indexes from migration 0012
//     (`admin_actions_admin_created_idx`,
//     `admin_actions_target_created_idx`). `id` is the deterministic
//     tiebreaker for rows that share a microsecond timestamp.
//   * **`limit` is clamped at the repository.** Default 100, max 200
//     — generous defaults; admin audit reads are rare and small.
//     Out-of-range values are silently clamped rather than thrown,
//     mirroring the pattern in `reviewService.clampLimit`.

import { BaseRepository } from '../../repositories/baseRepository.js';

/**
 * Known admin action types. Additive: extend by appending new
 * variants, never rename or remove. Removing a variant would break
 * deserialization of historical rows persisted under that string.
 */
export type AdminAction =
    | 'APPROVE_BUSINESS'
    | 'REJECT_BUSINESS'
    | 'SUSPEND_BUSINESS'
    | 'FEATURE_BUSINESS'
    | 'UNFEATURE_BUSINESS'
    | 'SUSPEND_USER'
    | 'RESTORE_USER'
    | 'CREATE_CATEGORY'
    | 'UPDATE_CATEGORY'
    | 'DEACTIVATE_CATEGORY';

/**
 * Known admin target types. Strings match the canonical table name
 * for the parent row so support inquiries (`grep target_type=`) are
 * unambiguous. Additive — same rules as `AdminAction`.
 */
export type AdminTargetType =
    | 'business_profile'
    | 'user'
    | 'business_category';

/** Domain shape of an `admin_actions` row. */
export interface AdminActionRow {
    readonly id: string;
    readonly adminUserId: string;
    readonly action: AdminAction;
    readonly targetType: AdminTargetType;
    readonly targetId: string;
    readonly notes: string | null;
    readonly createdAt: Date;
}

/** Fields written by `insert`. `notes` is the only nullable field. */
export interface InsertAdminActionInput {
    readonly adminUserId: string;
    readonly action: AdminAction;
    readonly targetType: AdminTargetType;
    readonly targetId: string;
    readonly notes?: string | null;
}

export interface AdminActionRepository {
    insert(input: InsertAdminActionInput): Promise<AdminActionRow>;
    listByAdmin(
        adminUserId: string,
        limit?: number,
    ): Promise<readonly AdminActionRow[]>;
    listForTarget(
        targetType: AdminTargetType,
        targetId: string,
        limit?: number,
    ): Promise<readonly AdminActionRow[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface AdminActionDbRow {
    id: string;
    admin_user_id: string;
    action: AdminAction;
    target_type: AdminTargetType;
    target_id: string;
    notes: string | null;
    created_at: Date;
}

const ADMIN_ACTION_COLUMNS = [
    'id',
    'admin_user_id',
    'action',
    'target_type',
    'target_id',
    'notes',
    'created_at',
].join(', ');

export class PgAdminActionRepository
    extends BaseRepository
    implements AdminActionRepository
{
    async insert(input: InsertAdminActionInput): Promise<AdminActionRow> {
        const row = await this.one<AdminActionDbRow>(
            `
            INSERT INTO admin_actions (
                admin_user_id, action, target_type, target_id, notes
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING ${ADMIN_ACTION_COLUMNS};
            `,
            [
                input.adminUserId,
                input.action,
                input.targetType,
                input.targetId,
                input.notes ?? null,
            ],
        );
        return mapRow(row);
    }

    async listByAdmin(
        adminUserId: string,
        limit?: number,
    ): Promise<readonly AdminActionRow[]> {
        const rows = await this.many<AdminActionDbRow>(
            `
            SELECT ${ADMIN_ACTION_COLUMNS}
              FROM admin_actions
             WHERE admin_user_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2;
            `,
            [adminUserId, clampLimit(limit)],
        );
        return rows.map(mapRow);
    }

    async listForTarget(
        targetType: AdminTargetType,
        targetId: string,
        limit?: number,
    ): Promise<readonly AdminActionRow[]> {
        const rows = await this.many<AdminActionDbRow>(
            `
            SELECT ${ADMIN_ACTION_COLUMNS}
              FROM admin_actions
             WHERE target_type = $1
               AND target_id   = $2
             ORDER BY created_at DESC, id DESC
             LIMIT $3;
            `,
            [targetType, targetId, clampLimit(limit)],
        );
        return rows.map(mapRow);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRow(row: AdminActionDbRow): AdminActionRow {
    return Object.freeze<AdminActionRow>({
        id: row.id,
        adminUserId: row.admin_user_id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        notes: row.notes,
        createdAt: row.created_at,
    });
}

function clampLimit(requested: number | undefined): number {
    if (requested === undefined) return DEFAULT_LIST_LIMIT;
    if (
        !Number.isInteger(requested) ||
        requested < 1 ||
        requested > MAX_LIST_LIMIT
    ) {
        return DEFAULT_LIST_LIMIT;
    }
    return requested;
}
