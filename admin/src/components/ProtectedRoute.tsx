// EthioLink admin — protected-route gate.
//
// Wraps any element that must require an authenticated ADMIN
// caller. Two failure modes both redirect to `/login`:
//
//   * No session in `sessionStorage` (or the stored session has
//     expired).
//   * A session exists but `cognito:groups` doesn't include
//     `ADMIN`. The redirect carries the caller's original location
//     so a future enhancement can return them there after sign-in;
//     this scaffold currently navigates to `/` post-login.
//
// The API authorizer is the authoritative gate for every server-
// side action; this component gates the UI surface so non-admins
// see a clear "sign in" page rather than a stream of 403s.

import type { PropsWithChildren } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { isAdmin, useAdminSession } from '../lib/auth';

export function ProtectedRoute({ children }: PropsWithChildren) {
    const session = useAdminSession();
    const location = useLocation();

    if (!session || !isAdmin(session)) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }
    return <>{children}</>;
}
