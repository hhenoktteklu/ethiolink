// EthioLink admin — shell layout for authenticated pages.
//
// Renders a thin header with the caller's email and a sign-out
// button, then an `<Outlet />` that the routed page fills in. Kept
// intentionally minimal — styling is the dashboard team's concern;
// this scaffold proves the routing + auth wiring without spending
// time on visual design.

import { Outlet } from 'react-router-dom';

import { signOut, useAdminSession } from '../lib/auth';

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
            <main style={{ padding: '1.5rem', maxWidth: 960, margin: '0 auto' }}>
                <Outlet />
            </main>
        </div>
    );
}
