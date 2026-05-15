// EthioLink admin — Cognito hosted-UI auth.
//
// Authorization-code flow with PKCE against the Cognito user pool's
// hosted UI. Three operations the rest of the app cares about:
//
//   * `redirectToHostedUI()` — kick off the sign-in. Generates a
//     PKCE code_verifier / code_challenge pair, stashes the verifier
//     in `sessionStorage`, and navigates to
//     `${COGNITO_DOMAIN}/oauth2/authorize?...`.
//   * `handleCallbackCode(code)` — call from the `/login?code=...`
//     callback. Exchanges the code for tokens at
//     `${COGNITO_DOMAIN}/oauth2/token`, decodes the id_token claims,
//     and stores the session. Returns the session for the caller to
//     inspect (e.g. to verify the ADMIN group).
//   * `signOut()` — clear local state and redirect to Cognito's
//     `/logout` endpoint so the next sign-in starts fresh.
//
// Storage:
//   `sessionStorage` (not `localStorage`) — admin tokens are wiped
//   when the tab closes, which is the right default for a small
//   operator team. For an SPA built on Cognito this is the
//   well-trodden tradeoff between UX (no re-login on each tab) and
//   token-exposure surface.
//
// Why no Amplify:
//   The Amplify Auth SDK is ~150 KB of JS for a flow we can
//   implement in ~100 lines. The hosted UI's OAuth surface is small,
//   stable, and well-documented; rolling our own keeps the bundle
//   small and the failure modes inspectable.
//
// Env vars (set in `admin/.env` or in the host's deployment config):
//
//   * VITE_COGNITO_DOMAIN          — full URL, e.g.
//                                    `https://ethiolink-dev.auth.eu-west-1.amazoncognito.com`
//   * VITE_COGNITO_ADMIN_CLIENT_ID — Cognito app client id (Terraform output
//                                    `cognito_admin_app_client_id`)
//   * VITE_ADMIN_REDIRECT_URI      — e.g. `http://localhost:5173/login`
//                                    or `https://admin.ethiolink.app/login`
//
// All three must match what's configured on the Cognito app client.

import { useEffect, useState } from 'react';

const COGNITO_DOMAIN = (import.meta.env.VITE_COGNITO_DOMAIN as string).replace(
    /\/$/,
    '',
);
const COGNITO_CLIENT_ID = import.meta.env.VITE_COGNITO_ADMIN_CLIENT_ID as string;
const REDIRECT_URI = import.meta.env.VITE_ADMIN_REDIRECT_URI as string;

const STORAGE_KEY = 'ethiolink.adminSession';
const VERIFIER_KEY = 'ethiolink.pkce.verifier';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Claims we read from the Cognito id_token. Loose-typed by design. */
export interface AdminClaims {
    readonly sub: string;
    readonly email?: string;
    readonly 'cognito:groups'?: readonly string[];
    readonly [key: string]: unknown;
}

export interface AdminSession {
    readonly idToken: string;
    readonly accessToken: string;
    readonly refreshToken?: string;
    /** Epoch milliseconds. The session is invalid once `Date.now() >= expiresAt`. */
    readonly expiresAt: number;
    readonly claims: AdminClaims;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
    let s = '';
    for (const byte of bytes) {
        s += String.fromCharCode(byte);
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(input: string): Promise<Uint8Array> {
    const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(input),
    );
    return new Uint8Array(buf);
}

function randomVerifier(): string {
    // 48 random bytes → 64-char base64url string. Inside the RFC 7636
    // recommended range of 43–128 characters.
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
}

function decodeJwtClaims(token: string): AdminClaims {
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Malformed JWT id_token from Cognito.');
    }
    const payload = (parts[1] ?? '')
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    const padded =
        payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded)) as AdminClaims;
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

export function getStoredSession(): AdminSession | null {
    if (typeof window === 'undefined') return null;
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as AdminSession;
        if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
            clearStoredSession();
            return null;
        }
        return parsed;
    } catch {
        clearStoredSession();
        return null;
    }
}

export function clearStoredSession(): void {
    if (typeof window === 'undefined') return;
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(VERIFIER_KEY);
}

function storeSession(session: AdminSession): void {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

// ---------------------------------------------------------------------------
// Group check
// ---------------------------------------------------------------------------

/**
 * True iff the session's id_token carries the `ADMIN` Cognito group.
 * The API authorizer is the authoritative gate (the client check
 * gates UI only); this function exists so the UI can render an
 * informative "not an admin" message instead of repeatedly receiving
 * 403s on every protected fetch.
 */
export function isAdmin(session: AdminSession | null): boolean {
    if (!session) return false;
    const groups = session.claims['cognito:groups'];
    return Array.isArray(groups) && groups.includes('ADMIN');
}

// ---------------------------------------------------------------------------
// Hosted-UI flow
// ---------------------------------------------------------------------------

export async function redirectToHostedUI(): Promise<void> {
    const verifier = randomVerifier();
    const challengeBytes = await sha256(verifier);
    const challenge = base64UrlEncode(challengeBytes);
    window.sessionStorage.setItem(VERIFIER_KEY, verifier);

    const params = new URLSearchParams({
        client_id: COGNITO_CLIENT_ID,
        response_type: 'code',
        scope: 'openid email profile',
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    window.location.href = `${COGNITO_DOMAIN}/oauth2/authorize?${params.toString()}`;
}

export async function handleCallbackCode(code: string): Promise<AdminSession> {
    const verifier = window.sessionStorage.getItem(VERIFIER_KEY);
    if (!verifier) {
        throw new Error(
            'Missing PKCE verifier in sessionStorage. Restart the sign-in flow.',
        );
    }

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: COGNITO_CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
    });
    const response = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
            `Cognito token exchange failed (${response.status}): ${text}`,
        );
    }
    const tokens = (await response.json()) as {
        id_token: string;
        access_token: string;
        refresh_token?: string;
        expires_in: number;
    };
    const session: AdminSession = Object.freeze({
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        claims: decodeJwtClaims(tokens.id_token),
    });
    storeSession(session);
    window.sessionStorage.removeItem(VERIFIER_KEY);
    return session;
}

export function signOut(): void {
    clearStoredSession();
    const params = new URLSearchParams({
        client_id: COGNITO_CLIENT_ID,
        logout_uri: REDIRECT_URI,
    });
    window.location.href = `${COGNITO_DOMAIN}/logout?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Tracks the current admin session. Re-reads `sessionStorage` on the
 * cross-tab `storage` event so a sign-out in another tab kicks this
 * tab out too.
 */
export function useAdminSession(): AdminSession | null {
    const [session, setSession] = useState<AdminSession | null>(() =>
        getStoredSession(),
    );
    useEffect(() => {
        const onStorage = () => setSession(getStoredSession());
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);
    return session;
}
