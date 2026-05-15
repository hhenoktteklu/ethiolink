// EthioLink admin — login page.
//
// Two modes, decided by the URL:
//
//   1. `/login` (no `code` query param) — render a "Sign in with
//      Cognito" button. Clicking it generates a PKCE pair and
//      redirects to the Cognito hosted UI's `/oauth2/authorize`
//      endpoint.
//   2. `/login?code=…` — the OAuth callback. Exchange the code for
//      tokens, verify the caller is in the `ADMIN` Cognito group,
//      then navigate to `/`. Show an error if either step fails.
//
// React Strict Mode mounts effects twice in dev, but Cognito only
// accepts an authorization code once. The `exchangedRef` guard
// prevents the second invocation from firing a doomed token-
// exchange request.

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import {
    handleCallbackCode,
    isAdmin,
    redirectToHostedUI,
} from '../lib/auth';

export function LoginPage() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const [error, setError] = useState<string | null>(null);
    const [exchanging, setExchanging] = useState(false);
    const exchangedRef = useRef(false);

    useEffect(() => {
        const code = searchParams.get('code');
        if (!code || exchangedRef.current) return;
        exchangedRef.current = true;
        setExchanging(true);

        handleCallbackCode(code)
            .then((session) => {
                if (!isAdmin(session)) {
                    setError(
                        'Your account is not in the ADMIN group. Sign out and use an admin account, or ask the operations team to add you.',
                    );
                    setExchanging(false);
                    return;
                }
                navigate('/', { replace: true });
            })
            .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
                setExchanging(false);
            });
    }, [searchParams, navigate]);

    return (
        <main
            style={{
                maxWidth: 480,
                margin: '5rem auto',
                padding: '0 1rem',
                fontFamily: 'system-ui, sans-serif',
                color: '#222',
            }}
        >
            <h1 style={{ marginTop: 0 }}>EthioLink Admin</h1>
            <p>Sign in with your admin account.</p>
            {error && (
                <p
                    role="alert"
                    style={{
                        color: 'crimson',
                        border: '1px solid currentColor',
                        padding: '0.5rem 1rem',
                        borderRadius: 4,
                    }}
                >
                    {error}
                </p>
            )}
            <button
                type="button"
                disabled={exchanging}
                onClick={() => {
                    setError(null);
                    redirectToHostedUI().catch((err: unknown) => {
                        setError(err instanceof Error ? err.message : String(err));
                    });
                }}
                style={{
                    padding: '0.75rem 1.5rem',
                    fontSize: '1rem',
                    cursor: exchanging ? 'progress' : 'pointer',
                }}
            >
                {exchanging ? 'Signing in…' : 'Sign in with Cognito'}
            </button>
        </main>
    );
}
