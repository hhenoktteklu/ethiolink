// EthioLink admin — dashboard home.
//
// Two panels:
//
//   * **Pending review** — count of businesses in PENDING_REVIEW
//     from `GET /v1/admin/businesses?status=PENDING_REVIEW&limit=100`.
//     The whole card is a link to the Businesses page; clicking
//     anywhere takes the admin into the queue. A non-zero count is
//     the "act on me" signal.
//   * **Shortcuts** — links to the other admin pages so the
//     Dashboard is a real landing page even before the top-bar nav
//     becomes visually dominant.
//
// MVP cap of 100 is more than enough for queue-depth signal; if a
// busier era arrives we'll switch to a count-only endpoint or add
// cursor pagination.

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

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

            <div
                style={{
                    display: 'grid',
                    gap: '1rem',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                    maxWidth: 720,
                }}
            >
                <Link to="/businesses" style={cardLinkStyle} aria-label="Open the businesses queue">
                    <h2 style={{ marginTop: 0, fontSize: '1rem', color: '#555' }}>
                        Pending review
                    </h2>
                    {isLoading && <p style={{ margin: 0 }}>Loading…</p>}
                    {error && (
                        <p style={{ color: 'crimson', margin: 0 }}>
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
                </Link>

                <article style={cardStyle}>
                    <h2 style={{ marginTop: 0, fontSize: '1rem', color: '#555' }}>
                        Shortcuts
                    </h2>
                    <ul style={{ paddingLeft: '1.25rem', margin: 0 }}>
                        <li><Link to="/categories">Manage categories</Link></li>
                        <li><Link to="/users">Browse users</Link></li>
                        <li><Link to="/appointments">View bookings</Link></li>
                    </ul>
                </article>
            </div>
        </section>
    );
}

const cardStyle: React.CSSProperties = {
    border: '1px solid #ddd',
    borderRadius: 6,
    padding: '1rem 1.25rem',
};

const cardLinkStyle: React.CSSProperties = {
    ...cardStyle,
    display: 'block',
    color: 'inherit',
    textDecoration: 'none',
};
