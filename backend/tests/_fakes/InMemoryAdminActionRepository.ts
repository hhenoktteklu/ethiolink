// EthioLink — in-memory `AdminActionRepository` for tests.
//
// Mirrors `PgAdminActionRepository`'s append-only contract: only
// `insert`, `listByAdmin`, and `listForTarget`. No mutation knobs,
// no UNIQUE-constraint simulation — migration 0012 has no UNIQUE on
// `admin_actions` so there's no race-loss path to model.
//
// Production code goes through the interface only. Tests get a few
// inspection helpers (`size`, `all`, `rowsForTarget`, `rowsByAdmin`)
// for compact `assert`s.

import { randomUUID } from 'node:crypto';

import type {
    AdminActionRepository,
    AdminActionRow,
    AdminTargetType,
    InsertAdminActionInput,
} from '../../shared/domains/admin/adminActionRepository.js';

export class InMemoryAdminActionRepository implements AdminActionRepository {
    private readonly rows: AdminActionRow[] = [];

    // ----- Test helpers -----------------------------------------------------

    /** Total appended rows. */
    size(): number {
        return this.rows.length;
    }

    /** Snapshot of every row, in insertion order. */
    all(): readonly AdminActionRow[] {
        return Object.freeze([...this.rows]);
    }

    /** Rows targeting a specific entity, in insertion order. */
    rowsForTarget(
        targetType: AdminTargetType,
        targetId: string,
    ): readonly AdminActionRow[] {
        return this.rows.filter(
            (r) => r.targetType === targetType && r.targetId === targetId,
        );
    }

    /** Rows authored by a specific admin, in insertion order. */
    rowsByAdmin(adminUserId: string): readonly AdminActionRow[] {
        return this.rows.filter((r) => r.adminUserId === adminUserId);
    }

    // ----- AdminActionRepository surface ------------------------------------

    async insert(input: InsertAdminActionInput): Promise<AdminActionRow> {
        const row: AdminActionRow = Object.freeze({
            id: randomUUID(),
            adminUserId: input.adminUserId,
            action: input.action,
            targetType: input.targetType,
            targetId: input.targetId,
            notes: input.notes ?? null,
            createdAt: new Date(),
        });
        this.rows.push(row);
        return row;
    }

    async listByAdmin(
        adminUserId: string,
        limit = 100,
    ): Promise<readonly AdminActionRow[]> {
        return this.rows
            .filter((r) => r.adminUserId === adminUserId)
            .sort(
                (a, b) =>
                    b.createdAt.getTime() - a.createdAt.getTime() ||
                    (a.id < b.id ? 1 : -1),
            )
            .slice(0, limit);
    }

    async listForTarget(
        targetType: AdminTargetType,
        targetId: string,
        limit = 100,
    ): Promise<readonly AdminActionRow[]> {
        return this.rows
            .filter(
                (r) => r.targetType === targetType && r.targetId === targetId,
            )
            .sort(
                (a, b) =>
                    b.createdAt.getTime() - a.createdAt.getTime() ||
                    (a.id < b.id ? 1 : -1),
            )
            .slice(0, limit);
    }
}
