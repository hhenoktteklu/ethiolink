// EthioLink — in-memory `NotificationLogRepository` fake for tests.
//
// Mirrors `PgNotificationLogRepository` (sans SQL) for unit testing
// the notification dispatcher without booting Postgres. Behavior
// matches the production repository:
//
//   * `insert` writes the row at `status = 'QUEUED'` (the DB default
//     baked into the SQL); `provider` defaults to `'MOCK'` if the
//     caller omitted it.
//   * `updateStatus` overwrites the three mutable columns;
//     `recipient_user_id` / `channel` / `template_key` / `payload`
//     stay immutable.
//   * `findById` returns `null` when absent (interface contract).
//   * `listForAdmin` applies all filters with the inclusive-lower /
//     exclusive-upper `created_at` semantics, sorted
//     `created_at DESC, id DESC`.

import { randomUUID } from 'node:crypto';

import { RepositoryError } from '../../shared/repositories/baseRepository.js';
import type {
    AdminNotificationLogFilters,
    AppointmentSlotDispatchKey,
    InsertNotificationLogInput,
    NotificationLogRepository,
    NotificationLogRow,
    UpdateNotificationLogStatusInput,
} from '../../shared/domains/notifications/notificationLogRepository.js';

export class InMemoryNotificationLogRepository
    implements NotificationLogRepository
{
    private readonly rows = new Map<string, NotificationLogRow>();

    /** Test helper: snapshot of every row, insertion-order. */
    all(): readonly NotificationLogRow[] {
        return Array.from(this.rows.values());
    }

    size(): number {
        return this.rows.size;
    }

    async insert(input: InsertNotificationLogInput): Promise<NotificationLogRow> {
        const now = new Date();
        const row: NotificationLogRow = Object.freeze({
            id: randomUUID(),
            recipientUserId: input.recipientUserId,
            channel: input.channel,
            templateKey: input.templateKey,
            payload: Object.freeze({ ...input.payload }),
            status: 'QUEUED',
            provider: input.provider ?? 'MOCK',
            providerRef: null,
            errorMessage: null,
            createdAt: now,
            updatedAt: now,
        });
        this.rows.set(row.id, row);
        return row;
    }

    async updateStatus(
        id: string,
        update: UpdateNotificationLogStatusInput,
    ): Promise<NotificationLogRow> {
        const existing = this.rows.get(id);
        if (!existing) {
            throw new RepositoryError(`Notification log ${id} not found.`);
        }
        const updated: NotificationLogRow = Object.freeze({
            ...existing,
            status: update.status,
            providerRef: update.providerRef,
            errorMessage: update.errorMessage,
            updatedAt: new Date(),
        });
        this.rows.set(id, updated);
        return updated;
    }

    async findById(id: string): Promise<NotificationLogRow | null> {
        return this.rows.get(id) ?? null;
    }

    async existsForAppointmentSlot(
        key: AppointmentSlotDispatchKey,
    ): Promise<boolean> {
        for (const row of this.rows.values()) {
            if (
                row.templateKey === key.templateKey &&
                row.recipientUserId === key.recipientUserId &&
                (row.payload as { startsAtUtc?: unknown }).startsAtUtc ===
                    key.startsAtUtc
            ) {
                return true;
            }
        }
        return false;
    }

    async listForAdmin(
        filters: AdminNotificationLogFilters,
        limit: number,
    ): Promise<readonly NotificationLogRow[]> {
        return Array.from(this.rows.values())
            .filter((r) => filters.status === undefined || r.status === filters.status)
            .filter((r) => filters.channel === undefined || r.channel === filters.channel)
            .filter(
                (r) =>
                    filters.recipientUserId === undefined ||
                    r.recipientUserId === filters.recipientUserId,
            )
            .filter(
                (r) =>
                    filters.fromUtc === undefined ||
                    r.createdAt.getTime() >= filters.fromUtc.getTime(),
            )
            .filter(
                (r) =>
                    filters.toUtc === undefined ||
                    r.createdAt.getTime() < filters.toUtc.getTime(),
            )
            .sort(
                (a, b) =>
                    b.createdAt.getTime() - a.createdAt.getTime() ||
                    (a.id < b.id ? 1 : -1),
            )
            .slice(0, limit);
    }
}
