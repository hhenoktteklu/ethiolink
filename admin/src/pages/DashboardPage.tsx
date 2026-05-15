// EthioLink admin — dashboard home.
//
// Minimum-viable landing page: a single panel showing the count of
// businesses awaiting review. The number is the "queue depth"
// admins care about most — a non-zero value is a prompt to open
// the (forthcoming) Businesses page and approve / reject.
//
// Implementation: one `useQuery` against
// `GET /v1/admin/businesses?status=PENDING_REVIEW&limit=100`. The
// MVP cap of 100 is more than enough for the queue-depth signal;
// when a busier era arrives we'll switch to a count-only endpoint
// or add cursor pagination.

import { useQuery } from '@tanstack/react-query';

import { ApiError, listAdminBusinesses } from '../lib/api';

export function DashboardPage() {
    const { data, isLoading, error } = useQuery({
        queryKey: ['adminBusinesses', 'PENDING_REVIEW'],
        queryFn: () =>
            listAdminBusinesses({ status: 'PENDING_REVIEW', limit: 100 }),
    });

    return (
        <section>
            <h1 style={{ marginTop: 0 }}>Dashboard</h1>

            <article
                style={{
                    border: '1px solid #ddd',
                    borderRadius: 6,
                    padding: '1rem 1.25rem',
                    maxWidth: 360,
                }}
            >
                <h2 style={{ marginTop: 0, fontSize: '1rem', color: '#555' }}>
                    Pending review
                </h2>
                {isLoading && <p>Loading…</p>}
                {error && (
                    <p style={{ color: 'crimson' }}>
                        Failed to load:{' '}
                        {error instanceof ApiError
                            ? `${error.code ?? 'ERROR'} — ${error.message}`
                            : error instanceof Error
                              ? error.message
                              : String(error)}
                    </p>
                )}
                {data && (
                    <p style={{ margin: 0 }}>
                        <strong style={{ fontSize: '2rem', display: 'block' }}>
                            {data.items.length}
                        </strong>
                        business{data.items.length === 1 ? '' : 'es'} awaiting
                        review.
                    </p>
                )}
            </article>
        </section>
    );
}
