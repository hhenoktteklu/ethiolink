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
    ApiError,
    approveBusiness,
    type BusinessOwnerView,
    featureBusiness,
    listAdminBusinesses,
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
