// EthioLink admin — Business detail page.
//
// Hosts the four write actions for one business:
//
//   * **Approve**         — visible when status is PENDING_REVIEW.
//   * **Reject**          — visible when status is PENDING_REVIEW.
//                           Optional `notes` textarea is the canonical
//                           rejection-reason store (no schema column).
//   * **Suspend**         — visible when status is APPROVED or
//                           PENDING_REVIEW. Optional notes.
//   * **Feature / Unfeature** — visible when status is APPROVED.
//                           Feature takes a `datetime-local` input
//                           and converts to ISO-8601 UTC before
//                           sending. Unfeature is a single button.
//
// MVP read shape: no dedicated `GET /v1/admin/businesses/:id`
// endpoint yet. The page reads the list endpoint (capped at 100)
// and finds the matching row by id. Acceptable for MVP volume; a
// future commit can add a single-row endpoint if dashboards grow.
//
// Mutations use TanStack Query with `onSuccess` invalidating the
// `['adminBusinesses']` query family so the list page refetches on
// next visit, and the detail page re-pulls fresh data.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import {
    type AdminCancelFeaturingInput,
    type AdminCompFeaturingInput,
    ApiError,
    approveBusiness,
    type BusinessOwnerView,
    cancelAdminFeaturing,
    compAdminFeaturing,
    featureBusiness,
    type FeaturingSubscriptionView,
    getAdminFeaturingHistory,
    listAdminBusinesses,
    listAdminPaymentIntentsForBusiness,
    type PaymentIntentView,
    rejectBusiness,
    suspendBusiness,
    unfeatureBusiness,
} from '../lib/api';

export function BusinessDetailPage() {
    const { id = '' } = useParams<{ id: string }>();

    // Read the unfiltered list and find the target row. The list cap
    // is 100; for MVP marketplace size this comfortably covers the
    // admin queue + recent rows. Switching to a per-id endpoint is a
    // future enhancement; see file header.
    const queryClient = useQueryClient();
    const { data, isLoading, error } = useQuery({
        queryKey: ['adminBusinesses', 'ALL'],
        queryFn: () => listAdminBusinesses({ limit: 100 }),
    });

    const business = data?.items.find((b) => b.id === id) ?? null;

    if (isLoading) {
        return (
            <section>
                <BackLink />
                <p>Loading…</p>
            </section>
        );
    }
    if (error) {
        return (
            <section>
                <BackLink />
                <p style={{ color: 'crimson' }}>
                    Failed to load:{' '}
                    {error instanceof ApiError
                        ? `${error.code ?? 'ERROR'} — ${error.message}`
                        : error instanceof Error
                          ? error.message
                          : String(error)}
                </p>
            </section>
        );
    }
    if (!business) {
        return (
            <section>
                <BackLink />
                <p>
                    Business not found (id <code>{id}</code>). It may be outside
                    the first 100 rows of the admin listing.
                </p>
            </section>
        );
    }

    return (
        <section>
            <BackLink />
            <BusinessMetadata business={business} />
            <ActionsPanel
                business={business}
                onMutated={() => {
                    // Invalidate every business listing variant so the
                    // queue depths on /businesses and the dashboard
                    // refresh.
                    queryClient.invalidateQueries({ queryKey: ['adminBusinesses'] });
                }}
            />
        </section>
    );
}

function BackLink() {
    return (
        <p style={{ marginTop: 0 }}>
            <Link to="/businesses">← Back to businesses</Link>
        </p>
    );
}

function BusinessMetadata({ business }: { business: BusinessOwnerView }) {
    return (
        <header
            style={{
                border: '1px solid #ddd',
                borderRadius: 6,
                padding: '1rem 1.25rem',
                marginBottom: '1.5rem',
            }}
        >
            <h1 style={{ marginTop: 0, marginBottom: '0.5rem' }}>
                {business.name ?? <em style={{ color: '#888' }}>(unnamed)</em>}
            </h1>
            <dl style={{ display: 'grid', gridTemplateColumns: '8rem 1fr', gap: '0.25rem 1rem', margin: 0 }}>
                <dt style={dt}>Status</dt>
                <dd style={dd}>{business.status}</dd>
                <dt style={dt}>City</dt>
                <dd style={dd}>{business.city ?? '—'}</dd>
                <dt style={dt}>Rating</dt>
                <dd style={dd}>
                    {business.ratingCount > 0
                        ? `${business.ratingAvg.toFixed(2)} (${business.ratingCount} reviews)`
                        : '—'}
                </dd>
                <dt style={dt}>Featured</dt>
                <dd style={dd}>
                    {business.featuredUntil
                        ? `Until ${new Date(business.featuredUntil).toLocaleString()}`
                        : '—'}
                </dd>
                <dt style={dt}>Owner</dt>
                <dd style={dd}><code>{business.ownerUserId}</code></dd>
                <dt style={dt}>Created</dt>
                <dd style={dd}>{new Date(business.createdAt).toLocaleString()}</dd>
            </dl>
        </header>
    );
}

function ActionsPanel({
    business,
    onMutated,
}: {
    business: BusinessOwnerView;
    onMutated: () => void;
}) {
    // `onMutated` invalidates the `['adminBusinesses']` query family;
    // TanStack Query refetches every matching active query, so this
    // page re-renders with the updated business once the refetch
    // lands. No `navigate(0)` hard-reload needed — that would lose
    // the query cache and trash the user's filter selection.
    return (
        <div style={{ display: 'grid', gap: '1.25rem' }}>
            {(business.status === 'PENDING_REVIEW' || business.status === 'APPROVED') && (
                <SuspendCard businessId={business.id} onSuccess={onMutated} />
            )}
            {business.status === 'PENDING_REVIEW' && (
                <>
                    <ApproveCard businessId={business.id} onSuccess={onMutated} />
                    <RejectCard businessId={business.id} onSuccess={onMutated} />
                </>
            )}
            {business.status === 'APPROVED' && (
                <FeatureCard
                    businessId={business.id}
                    featuredUntil={business.featuredUntil}
                    onSuccess={onMutated}
                />
            )}
            {business.status === 'APPROVED' && (
                <FeaturingHistoryPanel
                    businessId={business.id}
                    onMutated={onMutated}
                />
            )}
            {/* Phase 10 commit 6 — reconciliation surface. Visible on
                every business regardless of status so admins can
                audit historical payment intents on suspended /
                rejected businesses too. */}
            <PaymentIntentsPanel businessId={business.id} />
            {(business.status === 'DRAFT' ||
                business.status === 'REJECTED' ||
                business.status === 'SUSPENDED') && (
                <p style={{ color: '#666' }}>
                    No admin actions available from status <strong>{business.status}</strong>.
                </p>
            )}
        </div>
    );
}

function ApproveCard({
    businessId,
    onSuccess,
}: {
    businessId: string;
    onSuccess: () => void;
}) {
    const [notes, setNotes] = useState('');
    const mutation = useMutation({
        mutationFn: () => approveBusiness(businessId, notes.trim() || null),
        onSuccess,
    });

    return (
        <Card title="Approve">
            <p style={{ marginTop: 0 }}>Approves the business and makes it visible in the public catalog.</p>
            <NotesField label="Notes (optional)" value={notes} onChange={setNotes} />
            <MutationButton
                label="Approve business"
                pending={mutation.isPending}
                onClick={() => mutation.mutate()}
            />
            <MutationStatus mutation={mutation} />
        </Card>
    );
}

function RejectCard({
    businessId,
    onSuccess,
}: {
    businessId: string;
    onSuccess: () => void;
}) {
    const [notes, setNotes] = useState('');
    const mutation = useMutation({
        mutationFn: () => rejectBusiness(businessId, notes.trim() || null),
        onSuccess,
    });

    return (
        <Card title="Reject" tone="warn">
            <p style={{ marginTop: 0 }}>
                Reject this submission. The reason in `notes` is the canonical
                rejection record (the schema has no dedicated column).
            </p>
            <NotesField label="Reason (recommended)" value={notes} onChange={setNotes} />
            <MutationButton
                label="Reject business"
                pending={mutation.isPending}
                onClick={() => mutation.mutate()}
            />
            <MutationStatus mutation={mutation} />
        </Card>
    );
}

function SuspendCard({
    businessId,
    onSuccess,
}: {
    businessId: string;
    onSuccess: () => void;
}) {
    const [notes, setNotes] = useState('');
    const mutation = useMutation({
        mutationFn: () => suspendBusiness(businessId, notes.trim() || null),
        onSuccess,
    });

    return (
        <Card title="Suspend" tone="warn">
            <p style={{ marginTop: 0 }}>
                Hides the business from public listings. The owner can still
                see it; reversal is a future admin tool.
            </p>
            <NotesField label="Reason (optional)" value={notes} onChange={setNotes} />
            <MutationButton
                label="Suspend business"
                pending={mutation.isPending}
                onClick={() => mutation.mutate()}
            />
            <MutationStatus mutation={mutation} />
        </Card>
    );
}

function FeatureCard({
    businessId,
    featuredUntil,
    onSuccess,
}: {
    businessId: string;
    featuredUntil: string | null;
    onSuccess: () => void;
}) {
    const [until, setUntil] = useState(() => defaultFeatureUntil());
    const [notes, setNotes] = useState('');

    const featureMutation = useMutation({
        mutationFn: () => {
            const parsed = new Date(until);
            if (Number.isNaN(parsed.getTime())) {
                throw new Error('Pick a valid date / time.');
            }
            return featureBusiness(businessId, parsed, notes.trim() || null);
        },
        onSuccess,
    });
    const unfeatureMutation = useMutation({
        mutationFn: () => unfeatureBusiness(businessId, notes.trim() || null),
        onSuccess,
    });

    const isCurrentlyFeatured = featuredUntil !== null;

    return (
        <Card title={isCurrentlyFeatured ? 'Update feature window' : 'Feature'}>
            <p style={{ marginTop: 0 }}>
                {isCurrentlyFeatured
                    ? `Currently featured until ${new Date(featuredUntil).toLocaleString()}. Pick a new instant or unfeature.`
                    : 'Feature this business in the public listing. Pick the instant it should stop being featured.'}
            </p>
            <label style={{ display: 'block', marginBottom: '0.5rem' }}>
                <span style={{ display: 'block', fontSize: '0.875rem', color: '#555' }}>
                    Featured until
                </span>
                <input
                    type="datetime-local"
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                    style={{ padding: '0.25rem 0.5rem' }}
                />
            </label>
            <NotesField label="Notes (optional)" value={notes} onChange={setNotes} />
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <MutationButton
                    label={isCurrentlyFeatured ? 'Update' : 'Feature'}
                    pending={featureMutation.isPending}
                    onClick={() => featureMutation.mutate()}
                />
                {isCurrentlyFeatured && (
                    <MutationButton
                        label="Unfeature"
                        pending={unfeatureMutation.isPending}
                        onClick={() => unfeatureMutation.mutate()}
                    />
                )}
            </div>
            <MutationStatus mutation={featureMutation} />
            <MutationStatus mutation={unfeatureMutation} />
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Card({
    title,
    tone,
    children,
}: {
    title: string;
    tone?: 'warn';
    children: React.ReactNode;
}) {
    const borderColor = tone === 'warn' ? '#fcd34d' : '#ddd';
    return (
        <article
            style={{
                border: `1px solid ${borderColor}`,
                borderRadius: 6,
                padding: '1rem 1.25rem',
            }}
        >
            <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>{title}</h2>
            {children}
        </article>
    );
}

function NotesField({
    label,
    value,
    onChange,
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
}) {
    return (
        <label style={{ display: 'block', marginBottom: '0.75rem' }}>
            <span style={{ display: 'block', fontSize: '0.875rem', color: '#555' }}>
                {label}
            </span>
            <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                rows={3}
                maxLength={2000}
                style={{
                    width: '100%',
                    padding: '0.5rem',
                    fontFamily: 'inherit',
                    fontSize: '0.95rem',
                    boxSizing: 'border-box',
                }}
            />
        </label>
    );
}

function MutationButton({
    label,
    pending,
    onClick,
}: {
    label: string;
    pending: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            disabled={pending}
            onClick={onClick}
            style={{
                padding: '0.5rem 1rem',
                fontSize: '0.95rem',
                cursor: pending ? 'progress' : 'pointer',
            }}
        >
            {pending ? `${label}…` : label}
        </button>
    );
}

function MutationStatus({ mutation }: { mutation: { error: unknown; isSuccess: boolean } }) {
    if (mutation.isSuccess) {
        return (
            <p style={{ marginTop: '0.5rem', color: '#15803d' }}>
                ✓ Saved.
            </p>
        );
    }
    if (mutation.error) {
        return (
            <p style={{ marginTop: '0.5rem', color: 'crimson' }}>
                {mutation.error instanceof ApiError
                    ? `${mutation.error.code ?? 'ERROR'} — ${mutation.error.message}`
                    : mutation.error instanceof Error
                      ? mutation.error.message
                      : String(mutation.error)}
            </p>
        );
    }
    return null;
}

// ---------------------------------------------------------------------------
// Featuring history panel — Phase 9 Track 6 paid featuring
// ---------------------------------------------------------------------------
//
// Mounted alongside the manual `FeatureCard` for APPROVED
// businesses. Two halves:
//
//   * History table — every `FeaturingSubscription` newest-first
//     pulled from `GET /v1/admin/businesses/{id}/featuring/history`.
//     Columns: status, source, packageCode, price (ETB), startsAt,
//     endsAt, paymentIntentId (currently "—" — the wire schema
//     doesn't carry the FK), cancelledReason.
//
//   * Admin actions:
//       - Comp featuring (durationDays, reason) — creates an
//         ADMIN_COMP subscription that goes ACTIVE immediately.
//       - Cancel active (reason) — flips the currently-ACTIVE row
//         to CANCELLED and recomputes featured_until.
//
// The panel maintains its own query (`['adminFeaturingHistory',
// businessId]`) so mutations refresh only this panel; the parent
// page's `['adminBusinesses']` query is also invalidated via
// `onMutated` so the `featured_until` chip in `BusinessMetadata`
// re-renders.
//
// The existing manual `FeatureCard` is intentionally NOT removed
// — it remains the operator escape hatch for cases where a
// subscription row isn't desired (e.g. dev / staging smoke tests).

function FeaturingHistoryPanel({
    businessId,
    onMutated,
}: {
    businessId: string;
    onMutated: () => void;
}) {
    const queryClient = useQueryClient();

    const query = useQuery({
        queryKey: ['adminFeaturingHistory', businessId],
        queryFn: () => getAdminFeaturingHistory(businessId, { limit: 50 }),
    });

    const refresh = () => {
        queryClient.invalidateQueries({
            queryKey: ['adminFeaturingHistory', businessId],
        });
        // Bubble up so the parent re-pulls business metadata too —
        // a comp / cancel changes the `featured_until` chip.
        onMutated();
    };

    return (
        <Card title="Paid featuring history">
            <p style={{ marginTop: 0, color: '#555', fontSize: '0.9rem' }}>
                Subscription history backing the paid-featuring flow.
                Distinct from the manual feature card above — that
                writes <code>featured_until</code> as an audit-only
                action without creating a subscription row.
            </p>
            <FeaturingActions
                businessId={businessId}
                hasActive={
                    query.data?.items.some((s) => s.status === 'ACTIVE') ?? false
                }
                onMutated={refresh}
            />
            <div style={{ marginTop: '1rem' }}>
                <FeaturingHistoryTable
                    isLoading={query.isLoading}
                    error={query.error}
                    rows={query.data?.items ?? []}
                    onRetry={() => query.refetch()}
                />
            </div>
        </Card>
    );
}

function FeaturingActions({
    businessId,
    hasActive,
    onMutated,
}: {
    businessId: string;
    hasActive: boolean;
    onMutated: () => void;
}) {
    return (
        <div
            style={{
                display: 'grid',
                gap: '1rem',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            }}
        >
            <CompFeaturingForm businessId={businessId} onSuccess={onMutated} />
            <CancelFeaturingForm
                businessId={businessId}
                disabled={!hasActive}
                onSuccess={onMutated}
            />
        </div>
    );
}

function CompFeaturingForm({
    businessId,
    onSuccess,
}: {
    businessId: string;
    onSuccess: () => void;
}) {
    const [durationDays, setDurationDays] = useState('7');
    const [reason, setReason] = useState('');

    const mutation = useMutation({
        mutationFn: () => {
            const days = Number.parseInt(durationDays, 10);
            if (!Number.isInteger(days) || days < 1 || days > 365) {
                throw new Error('Duration must be a whole number 1–365.');
            }
            if (!reason.trim()) {
                throw new Error('Reason is required.');
            }
            const input: AdminCompFeaturingInput = {
                durationDays: days,
                reason: reason.trim(),
            };
            return compAdminFeaturing(businessId, input);
        },
        onSuccess: () => {
            setReason('');
            onSuccess();
        },
    });

    return (
        <fieldset
            style={{
                border: '1px solid #ddd',
                borderRadius: 6,
                padding: '0.75rem 1rem',
            }}
        >
            <legend style={{ padding: '0 0.5rem', fontSize: '0.9rem' }}>
                Comp featuring
            </legend>
            <p style={{ marginTop: 0, color: '#555', fontSize: '0.85rem' }}>
                Creates an ACTIVE <code>ADMIN_COMP</code> subscription
                (price 0). Refused when another ACTIVE subscription
                already exists.
            </p>
            <label style={{ display: 'block', marginBottom: '0.5rem' }}>
                <span style={{ display: 'block', fontSize: '0.85rem', color: '#555' }}>
                    Duration (days, 1–365)
                </span>
                <input
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={durationDays}
                    onChange={(e) => setDurationDays(e.target.value)}
                    style={{ padding: '0.25rem 0.5rem', width: '6rem' }}
                />
            </label>
            <NotesField label="Reason (required)" value={reason} onChange={setReason} />
            <MutationButton
                label="Create comp"
                pending={mutation.isPending}
                onClick={() => mutation.mutate()}
            />
            <MutationStatus mutation={mutation} />
        </fieldset>
    );
}

function CancelFeaturingForm({
    businessId,
    disabled,
    onSuccess,
}: {
    businessId: string;
    disabled: boolean;
    onSuccess: () => void;
}) {
    const [reason, setReason] = useState('');

    const mutation = useMutation({
        mutationFn: () => {
            if (!reason.trim()) {
                throw new Error('Reason is required.');
            }
            const input: AdminCancelFeaturingInput = { reason: reason.trim() };
            return cancelAdminFeaturing(businessId, input);
        },
        onSuccess: () => {
            setReason('');
            onSuccess();
        },
    });

    return (
        <fieldset
            style={{
                border: `1px solid ${disabled ? '#eee' : '#fcd34d'}`,
                borderRadius: 6,
                padding: '0.75rem 1rem',
                opacity: disabled ? 0.6 : 1,
            }}
        >
            <legend style={{ padding: '0 0.5rem', fontSize: '0.9rem' }}>
                Cancel active subscription
            </legend>
            <p style={{ marginTop: 0, color: '#555', fontSize: '0.85rem' }}>
                {disabled
                    ? 'No ACTIVE subscription to cancel.'
                    : 'Flips the ACTIVE subscription to CANCELLED and recomputes featured_until. Refunds (if any) are handled out-of-band.'}
            </p>
            <NotesField
                label="Reason (required)"
                value={reason}
                onChange={setReason}
            />
            <button
                type="button"
                disabled={disabled || mutation.isPending}
                onClick={() => mutation.mutate()}
                style={{
                    padding: '0.5rem 1rem',
                    fontSize: '0.95rem',
                    cursor:
                        disabled || mutation.isPending ? 'not-allowed' : 'pointer',
                }}
            >
                {mutation.isPending ? 'Cancelling…' : 'Cancel subscription'}
            </button>
            <MutationStatus mutation={mutation} />
        </fieldset>
    );
}

function FeaturingHistoryTable({
    isLoading,
    error,
    rows,
    onRetry,
}: {
    isLoading: boolean;
    error: unknown;
    rows: readonly FeaturingSubscriptionView[];
    onRetry: () => void;
}) {
    if (isLoading) {
        return <p style={{ color: '#555' }}>Loading history…</p>;
    }
    if (error) {
        return (
            <p style={{ color: 'crimson' }}>
                Failed to load history:{' '}
                {error instanceof ApiError
                    ? `${error.code ?? 'ERROR'} — ${error.message}`
                    : error instanceof Error
                      ? error.message
                      : String(error)}
                {' '}
                <button
                    type="button"
                    onClick={onRetry}
                    style={{ marginLeft: '0.5rem' }}
                >
                    Try again
                </button>
            </p>
        );
    }
    if (rows.length === 0) {
        return (
            <p style={{ color: '#666' }}>
                No featuring subscriptions for this business yet.
            </p>
        );
    }
    return (
        <div style={{ overflowX: 'auto' }}>
            <table
                style={{
                    borderCollapse: 'collapse',
                    width: '100%',
                    fontSize: '0.9rem',
                }}
            >
                <thead>
                    <tr style={{ textAlign: 'left', background: '#f3f4f6' }}>
                        <th style={th}>Status</th>
                        <th style={th}>Source</th>
                        <th style={th}>Package</th>
                        <th style={th}>Price (ETB)</th>
                        <th style={th}>Starts</th>
                        <th style={th}>Ends</th>
                        <th style={th}>Payment intent</th>
                        <th style={th}>Cancelled reason</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row.id} style={{ borderTop: '1px solid #eee' }}>
                            <td style={td}>
                                <StatusBadge status={row.status} />
                            </td>
                            <td style={td}>{row.source}</td>
                            <td style={td}>
                                <code>{row.packageCode}</code>
                            </td>
                            <td style={td}>{row.priceEtb.toFixed(0)}</td>
                            <td style={td}>
                                {new Date(row.startsAt).toLocaleString()}
                            </td>
                            <td style={td}>
                                {new Date(row.endsAt).toLocaleString()}
                            </td>
                            <td style={td}>—</td>
                            <td style={td}>{row.cancelledReason ?? '—'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function StatusBadge({ status }: { status: FeaturingSubscriptionView['status'] }) {
    const color = (() => {
        switch (status) {
            case 'ACTIVE':
                return { bg: '#dcfce7', fg: '#166534' };
            case 'PENDING_PAYMENT':
                return { bg: '#fef9c3', fg: '#854d0e' };
            case 'EXPIRED':
                return { bg: '#e5e7eb', fg: '#374151' };
            case 'CANCELLED':
            case 'REFUNDED':
                return { bg: '#fee2e2', fg: '#991b1b' };
        }
    })();
    return (
        <span
            style={{
                background: color.bg,
                color: color.fg,
                padding: '0.1rem 0.5rem',
                borderRadius: 4,
                fontSize: '0.8rem',
                fontWeight: 600,
                letterSpacing: 0.3,
            }}
        >
            {status}
        </span>
    );
}

const th: React.CSSProperties = {
    padding: '0.4rem 0.6rem',
    fontWeight: 600,
    color: '#374151',
    fontSize: '0.85rem',
    whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
    padding: '0.4rem 0.6rem',
    verticalAlign: 'top',
    whiteSpace: 'nowrap',
};

// ---------------------------------------------------------------------------
// Payment intents panel — Phase 10 commit 6 reconciliation surface
// ---------------------------------------------------------------------------
//
// Read-only table of every `payment_intents` row attached to the
// business — either via an appointment OR via a featuring
// subscription. Useful when matching Chapa's payout statement
// against our recorded intents. Refunds + voids are deliberately
// out of scope; the reconciliation surface is a read-only audit
// tool.
//
// The endpoint is unpaginated under the MVP cap (200 rows). When
// businesses cross that threshold the page grows date-range
// filters; for now the default newest-first listing is fine.

function PaymentIntentsPanel({ businessId }: { businessId: string }) {
    const query = useQuery({
        queryKey: ['adminPaymentIntents', businessId],
        queryFn: () =>
            listAdminPaymentIntentsForBusiness(businessId, { limit: 200 }),
    });

    return (
        <Card title="Payments">
            <p style={{ marginTop: 0, color: '#555', fontSize: '0.9rem' }}>
                Every <code>payment_intents</code> row tied to this
                business — appointments (when the booking went through
                an online provider) and featuring subscriptions. Newest
                first. Use for reconciliation against the provider's
                payout statements.
            </p>
            <PaymentIntentsTable
                isLoading={query.isLoading}
                error={query.error}
                rows={query.data?.items ?? []}
                onRetry={() => query.refetch()}
            />
        </Card>
    );
}

function PaymentIntentsTable({
    isLoading,
    error,
    rows,
    onRetry,
}: {
    isLoading: boolean;
    error: unknown;
    rows: readonly PaymentIntentView[];
    onRetry: () => void;
}) {
    if (isLoading) {
        return <p style={{ color: '#555' }}>Loading payments…</p>;
    }
    if (error) {
        return (
            <p style={{ color: 'crimson' }}>
                Failed to load:{' '}
                {error instanceof ApiError
                    ? `${error.code ?? 'ERROR'} — ${error.message}`
                    : error instanceof Error
                      ? error.message
                      : String(error)}
                {' '}
                <button
                    type="button"
                    onClick={onRetry}
                    style={{ marginLeft: '0.5rem' }}
                >
                    Try again
                </button>
            </p>
        );
    }
    if (rows.length === 0) {
        return (
            <p style={{ color: '#666' }}>
                No payment intents recorded for this business yet.
                Cash bookings do not create rows; online bookings +
                featuring purchases do.
            </p>
        );
    }
    return (
        <div style={{ overflowX: 'auto' }}>
            <table
                style={{
                    borderCollapse: 'collapse',
                    width: '100%',
                    fontSize: '0.9rem',
                }}
            >
                <thead>
                    <tr style={{ textAlign: 'left', background: '#f3f4f6' }}>
                        <th style={th}>Purpose</th>
                        <th style={th}>Provider</th>
                        <th style={th}>Status</th>
                        <th style={th}>Amount</th>
                        <th style={th}>Currency</th>
                        <th style={th}>Provider ref</th>
                        <th style={th}>Created</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row.id} style={{ borderTop: '1px solid #eee' }}>
                            <td style={td}>{row.purpose}</td>
                            <td style={td}>{row.provider}</td>
                            <td style={td}>
                                <PaymentIntentStatusBadge status={row.status} />
                            </td>
                            <td style={td}>{row.amountEtb.toFixed(2)}</td>
                            <td style={td}>{row.currency}</td>
                            <td style={td}>
                                {row.providerRef ? (
                                    <code>{row.providerRef}</code>
                                ) : (
                                    '—'
                                )}
                            </td>
                            <td style={td}>
                                {new Date(row.createdAt).toLocaleString()}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function PaymentIntentStatusBadge({
    status,
}: {
    status: PaymentIntentView['status'];
}) {
    const color = (() => {
        switch (status) {
            case 'SUCCEEDED':
                return { bg: '#dcfce7', fg: '#166534' };
            case 'PENDING':
                return { bg: '#fef9c3', fg: '#854d0e' };
            case 'FAILED':
            case 'CANCELLED':
                return { bg: '#fee2e2', fg: '#991b1b' };
        }
    })();
    return (
        <span
            style={{
                background: color.bg,
                color: color.fg,
                padding: '0.1rem 0.5rem',
                borderRadius: 4,
                fontSize: '0.8rem',
                fontWeight: 600,
                letterSpacing: 0.3,
            }}
        >
            {status}
        </span>
    );
}

function defaultFeatureUntil(): string {
    // Default to "two weeks from now" rendered for `datetime-local`
    // (local-time string, no Z suffix).
    const target = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const yyyy = target.getFullYear();
    const mm = String(target.getMonth() + 1).padStart(2, '0');
    const dd = String(target.getDate()).padStart(2, '0');
    const hh = String(target.getHours()).padStart(2, '0');
    const min = String(target.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}
