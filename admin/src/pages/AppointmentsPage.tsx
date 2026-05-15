// EthioLink admin — Bookings page (read-only).
//
// Cross-business appointment listing. Five filters at the top —
// status, businessId, customerId, from, to — all optional, all
// AND-combined. The backend caps the result at `limit=100`; the
// page passes that explicitly because we want admins to know
// they're seeing at most 100 rows.
//
// No mutations on this page. The booking lifecycle (accept /
// reject / cancel / reschedule / complete) is the business
// owner's and the customer's surface — admins audit and read, but
// don't act. If a real admin-side intervention need surfaces
// (e.g. force-cancel a booking on a suspended business), it lands
// as a new backend action + a new button, not a relaxation of the
// existing endpoints.
//
// `from` and `to` use native `<input type="datetime-local">`. The
// input value is the admin's local time without a timezone; we
// convert via `new Date(...).toISOString()` so the API receives a
// canonical UTC ISO string. Empty inputs send no filter.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
    type AppointmentStatus,
    type AppointmentView,
    ApiError,
    listAdminAppointments,
} from '../lib/api';

const STATUS_OPTIONS: ReadonlyArray<{
    readonly label: string;
    readonly value: AppointmentStatus | 'ALL';
}> = [
    { label: 'All', value: 'ALL' },
    { label: 'Requested', value: 'REQUESTED' },
    { label: 'Accepted', value: 'ACCEPTED' },
    { label: 'Rejected', value: 'REJECTED' },
    { label: 'Cancelled', value: 'CANCELLED' },
    { label: 'Completed', value: 'COMPLETED' },
    { label: 'No-show', value: 'NO_SHOW' },
];

const QUERY_KEY = ['adminAppointments'] as const;
const DEFAULT_LIMIT = 100;

export function AppointmentsPage() {
    const [statusFilter, setStatusFilter] = useState<AppointmentStatus | 'ALL'>('ALL');
    const [businessId, setBusinessId] = useState('');
    const [customerId, setCustomerId] = useState('');
    const [fromLocal, setFromLocal] = useState('');
    const [toLocal, setToLocal] = useState('');

    // Compute the filter object once per render so the query key
    // stays stable across input keystrokes (it does — every input
    // is in the queryKey).
    const filters = {
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        businessId: businessId.trim() || undefined,
        customerId: customerId.trim() || undefined,
        fromUtc: fromLocal ? localStringToDate(fromLocal) : undefined,
        toUtc: toLocal ? localStringToDate(toLocal) : undefined,
        limit: DEFAULT_LIMIT,
    };

    const { data, isLoading, error, isFetching } = useQuery({
        queryKey: [
            ...QUERY_KEY,
            statusFilter,
            businessId.trim(),
            customerId.trim(),
            fromLocal,
            toLocal,
        ],
        queryFn: () => listAdminAppointments(filters),
    });

    return (
        <section>
            <h1 style={{ marginTop: 0 }}>Bookings</h1>

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
                            setStatusFilter(e.target.value as AppointmentStatus | 'ALL')
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
                <Field label="Business id">
                    <input
                        value={businessId}
                        onChange={(e) => setBusinessId(e.target.value)}
                        placeholder="UUID"
                        style={inputStyle}
                    />
                </Field>
                <Field label="Customer id">
                    <input
                        value={customerId}
                        onChange={(e) => setCustomerId(e.target.value)}
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
                    No bookings match these filters.
                </p>
            )}
            {data && data.items.length > 0 && (
                <>
                    <AppointmentsTable rows={data.items} />
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

function AppointmentsTable({ rows }: { rows: readonly AppointmentView[] }) {
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
                    <th style={th}>Appointment</th>
                    <th style={th}>Business</th>
                    <th style={th}>Customer</th>
                    <th style={th}>Service</th>
                    <th style={th}>Staff</th>
                    <th style={th}>Starts</th>
                    <th style={th}>Ends</th>
                    <th style={th}>Status</th>
                    <th style={th}>Payment</th>
                    <th style={th}>Price (ETB)</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => (
                    <tr key={row.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={td}><IdCell value={row.id} /></td>
                        <td style={td}><IdCell value={row.businessId} /></td>
                        <td style={td}><IdCell value={row.customerId} /></td>
                        <td style={td}><IdCell value={row.serviceId} /></td>
                        <td style={td}><IdCell value={row.staffId} /></td>
                        <td style={td}>{new Date(row.startsAt).toLocaleString()}</td>
                        <td style={td}>{new Date(row.endsAt).toLocaleString()}</td>
                        <td style={td}>
                            <StatusBadge status={row.status} />
                        </td>
                        <td style={td}>{row.paymentMethod}</td>
                        <td style={td}>{row.priceEtb.toFixed(2)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

// ---------------------------------------------------------------------------
// Small bits
// ---------------------------------------------------------------------------

function IdCell({ value }: { value: string }) {
    return (
        <code
            title={value}
            style={{ fontSize: '0.75rem', color: '#444' }}
        >
            {value.slice(0, 8)}…
        </code>
    );
}

function StatusBadge({ status }: { status: AppointmentStatus }) {
    const color: Record<AppointmentStatus, string> = {
        REQUESTED: '#d97706',
        ACCEPTED: '#15803d',
        REJECTED: '#b91c1c',
        CANCELLED: '#6b7280',
        COMPLETED: '#1d4ed8',
        NO_SHOW: '#7c3aed',
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
            {status.replace('_', ' ')}
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

/**
 * Parse the `datetime-local` input value. Browsers emit a string
 * like `2026-05-15T12:00` without a timezone — `new Date(...)`
 * interprets it as local time, which is what the admin typed.
 * `.toISOString()` (called downstream in the API helper) yields
 * the canonical UTC string.
 */
function localStringToDate(local: string): Date {
    return new Date(local);
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
