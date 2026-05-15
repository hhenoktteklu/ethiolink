// EthioLink — JSON projection for a `notification_logs` row.
//
// Single admin-facing projection: the admin notifications listing
// endpoint (Phase 6's troubleshooting surface) returns this shape.
// No public projection — recipients never see their own
// notification log; the channel-side delivery is the only
// recipient-visible artifact.
//
// What changes vs. the domain row:
//   * Timestamps serialize as ISO-8601 UTC strings.
//   * The `payload` jsonb passes through verbatim — the dashboard
//     renders it as `<pre>` for debugging.
//
// Nothing is hidden — admins need every column for support
// inquiries.

import type {
    NotificationChannel,
    NotificationLogRow,
    NotificationStatus,
} from './notificationLogRepository.js';

export interface NotificationLogView {
    readonly id: string;
    readonly recipientUserId: string | null;
    readonly channel: NotificationChannel;
    readonly templateKey: string;
    readonly payload: Record<string, unknown>;
    readonly status: NotificationStatus;
    readonly provider: string;
    readonly providerRef: string | null;
    readonly errorMessage: string | null;
    /** UTC ISO-8601. */
    readonly createdAt: string;
    /** UTC ISO-8601. */
    readonly updatedAt: string;
}

export function toNotificationLogView(
    row: NotificationLogRow,
): NotificationLogView {
    return Object.freeze<NotificationLogView>({
        id: row.id,
        recipientUserId: row.recipientUserId,
        channel: row.channel,
        templateKey: row.templateKey,
        payload: row.payload,
        status: row.status,
        provider: row.provider,
        providerRef: row.providerRef,
        errorMessage: row.errorMessage,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    });
}
