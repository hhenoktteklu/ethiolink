// EthioLink admin — shell layout for authenticated pages.
//
// Three regions stacked top-to-bottom:
//
//   1. **Top bar** — brand on the left, the caller's email + a
//      sign-out button on the right.
//   2. **Nav bar** — `NavLink`s for Dashboard / Businesses /
//      Categories / Users / Bookings. The active route's link is
//      visually distinct via the `NavLink` render-prop pattern.
//   3. **Main** — the routed page rendered via `<Outlet />`.
//
// Styling stays inline + minimal per the Phase 5 scaffold
// convention. Visual polish (responsive collapse, theming, etc.)
// is deferred until real operator feedback demands it.

import type { NavLinkRenderProps } from 'react-router-dom';
import { NavLink, Outlet } from 'react-router-dom';

import { signOut, useAdminSession } from '../lib/auth';

interface NavEntry {
    readonly to: string;
    readonly label: string;
    /**
     * Whether the `NavLink` should require an exact match. The
     * Dashboard sits at `/`, which is a prefix of every other
     * route — without `end: true`, every page would mark the
     * Dashboard link as active.
     */
    readonly end?: boolean;
}

const NAV_ENTRIES: readonly NavEntry[] = [
    { to: '/', label: 'Dashboard', end: true },
    { to: '/businesses', label: 'Businesses' },
    { to: '/categories', label: 'Categories' },
    { to: '/users', label: 'Users' },
    { to: '/appointments', label: 'Bookings' },
];

export function AdminLayout() {
    const session = useAdminSession();
    const email =
        typeof session?.claims.email === 'string'
            ? session.claims.email
            : 'admin';

    return (
        <div style={{ fontFamily: 'system-ui, sans-serif', color: '#222' }}>
            <header
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.75rem 1.5rem',
                    borderBottom: '1px solid #ddd',
                    background: '#fafafa',
                }}
            >
                <strong>EthioLink Admin</strong>
                <span>
                    {email}{' '}
                    <button
                        type="button"
                        onClick={() => signOut()}
                        style={{ marginLeft: '1rem', cursor: 'pointer' }}
                    >
                        Sign out
                    </button>
                </span>
            </header>

            <nav
                aria-label="Primary"
                style={{
                    display: 'flex',
                    gap: '0.25rem',
                    padding: '0.5rem 1.5rem',
                    borderBottom: '1px solid #eee',
                    background: '#fff',
                }}
            >
                {NAV_ENTRIES.map((entry) => (
                    <NavLink
                        key={entry.to}
                        to={entry.to}
                        end={entry.end}
                        style={navLinkStyle}
                    >
                        {entry.label}
                    </NavLink>
                ))}
            </nav>

            <main style={{ padding: '1.5rem', maxWidth: 960, margin: '0 auto' }}>
                <Outlet />
            </main>
        </div>
    );
}

/**
 * `NavLink` accepts a function-prop for `style` that's called with
 * `{ isActive, isPending, isTransitioning }`. We use that to render
 * the active link with a stronger background + foreground.
 */
function navLinkStyle({ isActive }: NavLinkRenderProps): React.CSSProperties {
    return {
        padding: '0.375rem 0.75rem',
        borderRadius: 4,
        textDecoration: 'none',
        fontSize: '0.95rem',
        color: isActive ? '#fff' : '#222',
        background: isActive ? '#1d4ed8' : 'transparent',
        fontWeight: isActive ? 600 : 400,
    };
}
