// EthioLink admin — Users page.
//
// Single-page view: status + role filters at the top, table of
// users below. The two write actions are per-row:
//
//   * **Suspend** — visible only when status is ACTIVE.
//   * **Restore** — visible only when status is SUSPENDED.
//   * **DELETED** rows show no action — terminal in MVP, no
//     reactivation path exists. The user can sign up again with a
//     fresh Cognito identity if needed.
//
// Both actions prompt for an optional reason via `window.prompt`
// (matches the Categories page's `window.confirm` for destructive
// actions — minimal-styling MVP convention). The reason lands on
// the matching `admin_actions` row's `notes` column.
//
// No create / patch from the admin UI — users are created via the
// customer / business sign-up flow + `/v1/auth/sync`, and profile
// edits live under `/v1/me`. Admin's only writes are the two
// status mutations.

import { useState } from 'react';
import {
    type UseMutationResult,
    useMutation,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';

import {
    type AdminUserView,
    ApiError,
    listAdminUsers,
    restoreUser,
    suspendUser,
    type UserRole,
    type UserStatus,
} from '../lib/api';

const QUERY_KEY = ['adminUsers'] as const;

const STATUS_OPTIONS: ReadonlyArray<{
    readonly label: string;
    readonly value: UserStatus | 'ALL';
}> = [
    { label: 'All', value: 'ALL' },
    { label: 'Active', value: 'ACTIVE' },
    { label: 'Suspended', value: 'SUSPENDED' },
    { label: 'Deleted', value: 'DELETED' },
];

const ROLE_OPTIONS: ReadonlyArray<{
    readonly label: string;
    readonly value: UserRole | 'ALL';
}> = [
    { label: 'All', value: 'ALL' },
    { label: 'Customer', value: 'CUSTOMER' },
    { label: 'Business owner', value: 'BUSINESS_OWNER' },
    { label: 'Admin', value: 'ADMIN' },
];

export function UsersPage() {
    const queryClient = useQueryClient();
    const [statusFilter, setStatusFilter] = useState<UserStatus | 'ALL'>('ALL');
    const [roleFilter, setRoleFilter] = useState<UserRole | 'ALL'>('ALL');

    const { data, isLoading, error, isFetching } = useQuery({
        queryKey: [...QUERY_KEY, statusFilter, roleFilter],
        queryFn: () =>
            listAdminUsers({
                status: statusFilter === 'ALL' ? undefined : statusFilter,
                role: roleFilter === 'ALL' ? undefined : roleFilter,
                limit: 100,
            }),
    });

    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    };

    return (
        <section>
            <h1 style={{ marginTop: 0 }}>Users</h1>

            <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span>Status</span>
                    <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as UserStatus | 'ALL')}
                        style={{ padding: '0.25rem 0.5rem' }}
                    >
                        {STATUS_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                                {opt.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span>Role</span>
                    <select
                        value={roleFilter}
                        onChange={(e) => setRoleFilter(e.target.value as UserRole | 'ALL')}
                        style={{ padding: '0.25rem 0.5rem' }}
                    >
                        {ROLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                                {opt.label}
                            </option>
                        ))}
                    </select>
                </label>
                {isFetching && !isLoading && (
                    <span style={{ color: '#666', fontSize: '0.875rem' }}>Refreshing…</span>
                )}
            </div>

            {isLoading && <p>Loading…</p>}
            {error && <ErrorLine error={error} />}
            {data && data.items.length === 0 && (
                <p style={{ marginTop: '1.5rem', color: '#666' }}>
                    No users match these filters.
                </p>
            )}
            {data && data.items.length > 0 && (
                <UsersTable rows={data.items} onMutated={invalidate} />
            )}
        </section>
    );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function UsersTable({
    rows,
    onMutated,
}: {
    rows: readonly AdminUserView[];
    onMutated: () => void;
}) {
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
                    <th style={th}>Display name</th>
                    <th style={th}>Email</th>
                    <th style={th}>Phone</th>
                    <th style={th}>Role</th>
                    <th style={th}>Status</th>
                    <th style={th}>Created</th>
                    <th style={th}>Actions</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => (
                    <UserRow key={row.id} row={row} onMutated={onMutated} />
                ))}
            </tbody>
        </table>
    );
}

function UserRow({
    row,
    onMutated,
}: {
    row: AdminUserView;
    onMutated: () => void;
}) {
    return (
        <tr style={{ borderBottom: '1px solid #eee' }}>
            <td style={td}>
                {row.displayName ?? <em style={{ color: '#888' }}>(none)</em>}
            </td>
            <td style={td}>{row.email ?? '—'}</td>
            <td style={td}>{row.phone ?? '—'}</td>
            <td style={td}>
                <RoleBadge role={row.role} />
            </td>
            <td style={td}>
                <StatusBadge status={row.status} />
            </td>
            <td style={td}>{new Date(row.createdAt).toLocaleDateString()}</td>
            <td style={td}>
                <UserActions user={row} onMutated={onMutated} />
            </td>
        </tr>
    );
}

function UserActions({
    user,
    onMutated,
}: {
    user: AdminUserView;
    onMutated: () => void;
}) {
    const suspendMutation = useMutation({
        mutationFn: (notes: string | null) => suspendUser(user.id, notes),
        onSuccess: onMutated,
    });
    const restoreMutation = useMutation({
        mutationFn: (notes: string | null) => restoreUser(user.id, notes),
        onSuccess: onMutated,
    });

    const handleSuspend = () => {
        const raw = window.prompt(
            `Suspend ${userLabel(user)}. Reason (optional):`,
        );
        if (raw === null) return; // cancelled
        const notes = raw.trim() === '' ? null : raw.trim();
        suspendMutation.mutate(notes);
    };

    const handleRestore = () => {
        const raw = window.prompt(
            `Restore ${userLabel(user)}. Notes (optional):`,
        );
        if (raw === null) return; // cancelled
        const notes = raw.trim() === '' ? null : raw.trim();
        restoreMutation.mutate(notes);
    };

    if (user.status === 'DELETED') {
        return <span style={{ color: '#999' }}>—</span>;
    }
    if (user.status === 'ACTIVE') {
        return (
            <>
                <button
                    type="button"
                    disabled={suspendMutation.isPending}
                    onClick={handleSuspend}
                    style={smallButton}
                >
                    {suspendMutation.isPending ? 'Suspending…' : 'Suspend'}
                </button>
                <MutationError mutation={suspendMutation} />
            </>
        );
    }
    // SUSPENDED
    return (
        <>
            <button
                type="button"
                disabled={restoreMutation.isPending}
                onClick={handleRestore}
                style={smallButton}
            >
                {restoreMutation.isPending ? 'Restoring…' : 'Restore'}
            </button>
            <MutationError mutation={restoreMutation} />
        </>
    );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: UserStatus }) {
    const color: Record<UserStatus, string> = {
        ACTIVE: '#15803d',
        SUSPENDED: '#d97706',
        DELETED: '#666',
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
            {status}
        </span>
    );
}

function RoleBadge({ role }: { role: UserRole }) {
    const color: Record<UserRole, string> = {
        CUSTOMER: '#1d4ed8',
        BUSINESS_OWNER: '#0e7490',
        ADMIN: '#7c3aed',
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
                background: color[role],
            }}
        >
            {role === 'BUSINESS_OWNER' ? 'OWNER' : role}
        </span>
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userLabel(user: AdminUserView): string {
    if (user.displayName) return `"${user.displayName}"`;
    if (user.email) return user.email;
    return user.id;
}

function MutationError({
    mutation,
}: {
    mutation: UseMutationResult<AdminUserView, unknown, string | null>;
}) {
    if (!mutation.error) return null;
    return (
        <div style={{ color: 'crimson', marginTop: '0.25rem', fontSize: '0.85rem' }}>
            {formatError(mutation.error)}
        </div>
    );
}

function ErrorLine({ error }: { error: unknown }) {
    return (
        <p style={{ color: 'crimson' }}>
            Failed to load: {formatError(error)}
        </p>
    );
}

function formatError(err: unknown): string {
    if (err instanceof ApiError) {
        return `${err.code ?? 'ERROR'} — ${err.message}`;
    }
    if (err instanceof Error) return err.message;
    return String(err);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const th: React.CSSProperties = { padding: '0.5rem 0.75rem' };
const td: React.CSSProperties = { padding: '0.5rem 0.75rem', verticalAlign: 'top' };

const smallButton: React.CSSProperties = {
    padding: '0.25rem 0.625rem',
    fontSize: '0.85rem',
    cursor: 'pointer',
};
