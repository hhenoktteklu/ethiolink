// EthioLink admin — Notifications page (read-only).
//
// Troubleshooting surface for the `notification_logs` table. Five
// filters at the top — status, channel, recipientUserId, from, to
// — all optional, all AND-combined. The backend caps the result
// at `limit=100`; the page passes that explicitly so the
// "showing first 100" hint can render when we're at the cap.
//
// No mutations on this page. A future retry / clear-failed flow
// lands as a new button + endpoint pair; the existing GET is
// deliberately read-only because forcing a re-dispatch from the
// dashboard demands a deliberate operator action and the
// idempotency story (see `existsForAppointmentSlot`) needs a
// matching "clear" path before that's safe.
//
// The `payload` column is rendered as a wrapped `<pre>` block.
// Booking notification payloads are small (5-6 string fields);
// a future template that ships a fat payload would benefit from
// a click-to-expand, but the simple approach is enough until a
// real notification with 30+ fields surfaces.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
    type NotificationChannel,
    type NotificationLogView,
    type NotificationStatus,
    ApiError,
    listAdminNotifications,
} from '../lib/api';

const STATUS_OPTIONS: ReadonlyArray<{
    readonly label: string;
    readonly value: NotificationStatus | 'ALL';
}> = [
    { label: 'All', value: 'ALL' },
    { label: 'Queued', value: 'QUEUED' },
    { label: 'Sent', value: 'SENT' },
    { label: 'Delivered', value: 'DELIVERED' },
    { label: 'Failed', value: 'FAILED' },
];

const CHANNEL_OPTIONS: ReadonlyArray<{
    readonly label: string;
    readonly value: NotificationChannel | 'ALL';
}> = [
    { label: 'All', value: 'ALL' },
    { label: 'Mock', value: 'MOCK' },
    { label: 'SMS', value: 'SMS' },
    { label: 'Email', value: 'EMAIL' },
    { label: 'Telegram', value: 'TELEGRAM' },
    { label: 'Push', value: 'PUSH' },
];

const QUERY_KEY = ['adminNotifications'] as const;
const DEFAULT_LIMIT = 100;

export function NotificationsPage() {
    const [statusFilter, setStatusFilter] = useState<NotificationStatus | 'ALL'>('ALL');
    const [channelFilter, setChannelFilter] = useState<NotificationChannel | 'ALL'>('ALL');
    const [recipientUserId, setRecipientUserId] = useState('');
    const [fromLocal, setFromLocal] = useState('');
    const [toLocal, setToLocal] = useState('');

    const filters = {
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        channel: channelFilter === 'ALL' ? undefined : channelFilter,
        recipientUserId: recipientUserId.trim() || undefined,
        fromUtc: fromLocal ? localStringToDate(fromLocal) : undefined,
        toUtc: toLocal ? localStringToDate(toLocal) : undefined,
        limit: DEFAULT_LIMIT,
    };

    const { data, isLoading, error, isFetching } = useQuery({
        queryKey: [
            ...QUERY_KEY,
            statusFilter,
            channelFilter,
            recipientUserId.trim(),
            fromLocal,
            toLocal,
        ],
        queryFn: () => listAdminNotifications(filters),
    });

    return (
        <section>
            <h1 style={{ marginTop: 0 }}>Notifications</h1>

            <div
                style={{
                    display: 'grid',
                    gap: '0.75rem',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    maxWidth: 960,
                    marginBottom: '1rem',
                }}
            >
                <Field label="Status">
                    <select
                        value={statusFilter}
                        onChange={(e) =>
                            setStatusFilter(e.target.value as NotificationStatus | 'ALL')
                        }
                        style={inputStyle}
                    >
                        {STATUS_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                                {opt.label}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Channel">
                    <select
                        value={channelFilter}
                        onChange={(e) =>
                            setChannelFilter(e.target.value as NotificationChannel | 'ALL')
                        }
                        style={inputStyle}
                    >
                        {CHANNEL_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                                {opt.label}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Recipient user id">
                    <input
                        value={recipientUserId}
                        onChange={(e) => setRecipientUserId(e.target.value)}
                        placeholder="UUID"
                        style={inputStyle}
                    />
                </Field>
                <Field label="From (local time, inclusive)">
                    <input
                        type="datetime-local"
                        value={fromLocal}
                        onChange={(e) => setFromLocal(e.target.value)}
                        style={inputStyle}
                    />
                </Field>
                <Field label="To (local time, exclusive)">
                    <input
                        type="datetime-local"
                        value={toLocal}
                        onChange={(e) => setToLocal(e.target.value)}
                        style={inputStyle}
                    />
                </Field>
            </div>

            {isFetching && !isLoading && (
                <p style={{ color: '#666', fontSize: '0.875rem', marginTop: 0 }}>
                    Refreshing…
                </p>
            )}
            {isLoading && <p>Loading…</p>}
            {error && <ErrorLine error={error} />}
            {data && data.items.length === 0 && (
                <p style={{ marginTop: '1.5rem', color: '#666' }}>
                    No notification logs match these filters.
                </p>
            )}
            {data && data.items.length > 0 && (
                <>
                    <NotificationsTable rows={data.items} />
                    {data.items.length === DEFAULT_LIMIT && (
                        <p style={{ color: '#666', fontSize: '0.875rem' }}>
                            Showing the first {DEFAULT_LIMIT} rows. Tighten the
                            filters to see narrower slices.
                        </p>
                    )}
                </>
            )}
        </section>
    );
}

function NotificationsTable({ rows }: { rows: readonly NotificationLogView[] }) {
    return (
        <table
            style={{
                marginTop: '0.5rem',
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.875rem',
            }}
        >
            <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                    <th style={th}>Id</th>
                    <th style={th}>Recipient</th>
                    <th style={th}>Channel</th>
                    <th style={th}>Template</th>
                    <th style={th}>Status</th>
                    <th style={th}>Provider</th>
                    <th style={th}>Provider ref</th>
                    <th style={th}>Error</th>
                    <th style={th}>Created</th>
                    <th style={th}>Payload</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => (
                    <tr key={row.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={tdMono}>{row.id}</td>
                        <td style={tdMono}>{row.recipientUserId ?? '—'}</td>
                        <td style={td}>{row.channel}</td>
                        <td style={tdMono}>{row.templateKey}</td>
                        <td style={td}>
                            <StatusBadge status={row.status} />
                        </td>
                        <td style={td}>{row.provider}</td>
                        <td style={tdMono}>{row.providerRef ?? '—'}</td>
                        <td style={{ ...td, color: row.errorMessage ? '#b91c1c' : '#666' }}>
                            {row.errorMessage ?? '—'}
                        </td>
                        <td style={td}>{formatTimestamp(row.createdAt)}</td>
                        <td style={td}>
                            <pre
                                style={{
                                    margin: 0,
                                    padding: '0.375rem 0.5rem',
                                    background: '#f8f8f8',
                                    border: '1px solid #eee',
                                    borderRadius: 4,
                                    maxWidth: 320,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    fontSize: '0.75rem',
                                }}
                            >
                                {safeJsonStringify(row.payload)}
                            </pre>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function StatusBadge({ status }: { status: NotificationStatus }) {
    const color: Record<NotificationStatus, string> = {
        QUEUED: '#d97706',
        SENT: '#15803d',
        DELIVERED: '#1d4ed8',
        FAILED: '#b91c1c',
    };
    return (
        <span
            style={{
                display: 'inline-block',
                padding: '0.125rem 0.5rem',
                borderRadius: 4,
                fontSize: '0.75rem',
                fontWeight: 600,
                color: 'white',
                background: color[status],
            }}
        >
            {status}
        </span>
    );
}

function Field({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: '0.875rem', color: '#555', marginBottom: '0.25rem' }}>
                {label}
            </span>
            {children}
        </label>
    );
}

function ErrorLine({ error }: { error: unknown }) {
    return (
        <p style={{ color: 'crimson' }}>
            Failed to load:{' '}
            {error instanceof ApiError
                ? `${error.code ?? 'ERROR'} — ${error.message}`
                : error instanceof Error
                  ? error.message
                  : String(error)}
        </p>
    );
}

function localStringToDate(local: string): Date {
    return new Date(local);
}

function formatTimestamp(iso: string): string {
    // Render in the admin's local time; show ISO seconds for
    // determinism. The default toLocaleString output is plenty
    // for an audit table.
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return iso;
    return dt.toLocaleString();
}

/**
 * Pretty-print the payload, falling back to `String(...)` if
 * something exotic ends up in the JSONB column (e.g. a circular
 * reference reflected by a future test seam — production rows
 * should never have one).
 */
function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.375rem 0.5rem',
    fontFamily: 'inherit',
    fontSize: '0.95rem',
    boxSizing: 'border-box',
};

const th: React.CSSProperties = { padding: '0.5rem 0.5rem', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '0.5rem 0.5rem', verticalAlign: 'top' };
const tdMono: React.CSSProperties = {
    ...td,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.75rem',
};
