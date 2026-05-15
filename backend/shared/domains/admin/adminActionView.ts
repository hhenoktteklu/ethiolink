// EthioLink — JSON projection for an `AdminAction` audit row.
//
// One projection serves both admin-detail audit history (everything
// admin X has done) and per-target audit history (everything that's
// been done to entity Y). Timestamps serialize as ISO-8601; no
// fields are hidden — the whole row is administratively interesting.
//
// The admin dashboard renders the per-target view alongside the
// business / user / category row so reviewers can see "approved on
// 2026-…-… by admin X with notes Y" inline with the entity itself.

import type {
    AdminAction,
    AdminActionRow,
    AdminTargetType,
} from './adminActionRepository.js';

export interface AdminActionView {
    readonly id: string;
    readonly adminUserId: string;
    readonly action: AdminAction;
    readonly targetType: AdminTargetType;
    readonly targetId: string;
    readonly notes: string | null;
    /** UTC ISO-8601. */
    readonly createdAt: string;
}

export function toAdminActionView(row: AdminActionRow): AdminActionView {
    return Object.freeze<AdminActionView>({
        id: row.id,
        adminUserId: row.adminUserId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        notes: row.notes,
        createdAt: row.createdAt.toISOString(),
    });
}
