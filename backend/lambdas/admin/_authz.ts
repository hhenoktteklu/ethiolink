// EthioLink — shared admin Lambda authorization helper.
//
// Every admin handler under `backend/lambdas/admin/` runs the same
// three-step preflight:
//
//   1. Extract the Cognito principal from the API Gateway event.
//   2. Refuse non-`ADMIN` roles with 403 FORBIDDEN.
//   3. Resolve `principal.sub` → `users` row; refuse unsynced
//      callers with 404 + the standard `POST /v1/auth/sync` hint.
//
// `authorizeAdmin` does all three and returns a tagged union:
//
//   * `{ ok: true, ... }` on success — carries the principal, the
//     resolved `users` row, and a pre-built `AdminCallerContext`
//     ready to pass into any admin service.
//   * `{ ok: false, response }` on a known refusal — the handler
//     returns `authz.response` directly.
//
// `AuthError` / `TokenExpiredError` / `TokenInvalidError` /
// `ClaimsMalformedError` propagate as exceptions; the handler's
// outer try/catch maps them to 401 UNAUTHENTICATED. That mirrors
// the existing pattern in `lambdas/businesses/create.ts` etc.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import type {
    AuthPrincipal,
    AuthProvider,
} from '../../shared/adapters/auth/AuthProvider.js';
import type { AdminCallerContext } from '../../shared/domains/admin/adminBusinessService.js';
import type { User } from '../../shared/domains/users/userRepository.js';
import type { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import { forbidden, notFound } from '../../shared/http/responses.js';

export type AdminAuthorizationResult =
    | {
          readonly ok: true;
          readonly principal: AuthPrincipal;
          readonly user: User;
          readonly caller: AdminCallerContext;
      }
    | {
          readonly ok: false;
          readonly response: APIGatewayProxyResult;
      };

/**
 * Authorize an admin Lambda invocation. See module header for the
 * three-step flow.
 *
 * The function throws on auth-token failures (missing / expired /
 * malformed bearer) so the caller's outer try/catch can map them to
 * 401. All other refusals — non-admin role, unsynced user — are
 * returned as a pre-baked `APIGatewayProxyResult` for the handler
 * to surface verbatim.
 */
export async function authorizeAdmin(
    event: APIGatewayProxyEvent,
    authProvider: AuthProvider,
    userService: UserService,
): Promise<AdminAuthorizationResult> {
    const principal = await extractPrincipal(event, authProvider);

    if (principal.role !== 'ADMIN') {
        return {
            ok: false,
            response: forbidden('Admin role required.'),
        };
    }

    const user = await userService.getByCognitoSub(principal.sub);
    if (!user) {
        return {
            ok: false,
            response: notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            ),
        };
    }

    return {
        ok: true,
        principal,
        user,
        caller: { userId: user.id, role: principal.role },
    };
}
