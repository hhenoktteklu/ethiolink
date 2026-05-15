// EthioLink admin — Businesses list page.
//
// Server-side filtering by status, no cursor pagination in MVP
// (the backend caps responses at 100). Default filter is
// PENDING_REVIEW because that's the queue admins open this page to
// work; "All" surfaces every status including DRAFT / REJECTED /
// SUSPENDED for support inquiries.
//
// Each row links to `/businesses/:id` where the detail page hosts
// approve / reject / suspend / feature actions.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
    ApiError,
    type BusinessStatus,
    type BusinessOwnerView,
    listAdminBusinesses,
} from '../lib/api';

const STATUS_OPTIONS: ReadonlyArray<{
    readonly label: string;
    readonly value: BusinessStatus | 'ALL';
}> = [
    { label: 'Pending review', value: 'PENDING_REVIEW' },
    { label: 'Approved', value: 'APPROVED' },
    { label: 'Draft', value: 'DRAFT' },
    { label: 'Rejected', value: 'REJECTED' },
    { label: 'Suspended', value: 'SUSPENDED' },
    { label: 'All statuses', value: 'ALL' },
];

export function BusinessesPage() {
    const [filter, setFilter] = useState<BusinessStatus | 'ALL'>('PENDING_REVIEW');

    const { data, isLoading, error, isFetching } = useQuery({
        queryKey: ['adminBusinesses', filter],
        queryFn: () =>
            listAdminBusinesses({
                status: filter === 'ALL' ? undefined : filter,
                limit: 100,
            }),
    });

    return (
        <section>
            <h1 style={{ marginTop: 0 }}>Businesses</h1>

            <label style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                <span>Status</span>
                <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as BusinessStatus | 'ALL')}
                    style={{ padding: '0.25rem 0.5rem' }}
                >
                    {STATUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                            {opt.label}
                        </option>
                    ))}
                </select>
                {isFetching && !isLoading && (
                    <span style={{ marginLeft: '0.5rem', color: '#666', fontSize: '0.875rem' }}>
                        Refreshing…
                    </span>
                )}
            </label>

            {isLoading && <p>Loading…</p>}
            {error && <ErrorBanner error={error} />}
            {data && data.items.length === 0 && (
                <p style={{ marginTop: '1.5rem', color: '#666' }}>
                    No businesses in this status.
                </p>
            )}
            {data && data.items.length > 0 && (
                <BusinessesTable rows={data.items} />
            )}
        </section>
    );
}

function BusinessesTable({ rows }: { rows: readonly BusinessOwnerView[] }) {
    return (
        <table
            style={{
                marginTop: '1rem',
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.95rem',
            }}
        >
            <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                    <th style={th}>Name</th>
                    <th style={th}>City</th>
                    <th style={th}>Status</th>
                    <th style={th}>Rating</th>
                    <th style={th}>Created</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => (
                    <tr key={row.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={td}>
                            <Link to={`/businesses/${row.id}`}>
                                {row.name ?? <em style={{ color: '#888' }}>(unnamed)</em>}
                            </Link>
                        </td>
                        <td style={td}>{row.city ?? '—'}</td>
                        <td style={td}>
                            <StatusBadge status={row.status} />
                        </td>
                        <td style={td}>
                            {row.ratingCount > 0
                                ? `${row.ratingAvg.toFixed(2)} (${row.ratingCount})`
                                : '—'}
                        </td>
                        <td style={td}>
                            {new Date(row.createdAt).toLocaleDateString()}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function StatusBadge({ status }: { status: BusinessStatus }) {
    const color: Record<BusinessStatus, string> = {
        DRAFT: '#666',
        PENDING_REVIEW: '#d97706',
        APPROVED: '#15803d',
        REJECTED: '#b91c1c',
        SUSPENDED: '#7c3aed',
    };
    return (
        <span
            style={{
                display: 'inline-block',
                padding: '0.125rem 0.5rem',
                borderRadius: 4,
                fontSize: '0.8rem',
                fontWeight: 600,
                color: 'white',
                background: color[status],
            }}
        >
            {status.replace('_', ' ')}
        </span>
    );
}

function ErrorBanner({ error }: { error: unknown }) {
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

const th: React.CSSProperties = { padding: '0.5rem 0.75rem' };
const td: React.CSSProperties = { padding: '0.5rem 0.75rem' };
