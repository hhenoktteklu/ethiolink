// EthioLink — featuring Lambda shared helpers.
//
// Phase 9 Track 6. The four owner-side featuring handlers + the
// three admin-side ones all share two preflight steps:
//
//   * Validate the `businessId` path parameter is a UUID.
//   * Resolve the Cognito principal and confirm the caller owns
//     the business (owner-side) or is an ADMIN (admin-side).
//
// `authorizeOwnerForBusiness` does the owner-side gating in one
// call. The admin-side handlers reuse the existing
// `lambdas/admin/_authz.ts` `authorizeAdmin` helper.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import type {
    AuthPrincipal,
    AuthProvider,
} from '../../shared/adapters/auth/AuthProvider.js';
import type { Business, BusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import type { User } from '../../shared/domains/users/userRepository.js';
import type { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import { forbidden, notFound } from '../../shared/http/responses.js';

export const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OwnerAuthorizationResult =
    | {
          readonly ok: true;
          readonly principal: AuthPrincipal;
          readonly user: User;
          readonly business: Business;
      }
    | {
          readonly ok: false;
          readonly response: APIGatewayProxyResult;
      };

/**
 * Owner-side preflight: confirms the caller's principal has
 * BUSINESS_OWNER role, the `users` row exists, and the target
 * business is owned by them. Returns `{ ok: true, ... }` on
 * success or a pre-baked response (403 / 404) on a known refusal.
 * Auth-token failures (missing / expired) propagate so the
 * handler's outer try/catch can map them to 401.
 *
 * To avoid an enumeration oracle, the 404 message is identical
 * whether the business doesn't exist or the caller doesn't own
 * it. The admin SPA never sees these branches.
 */
export async function authorizeOwnerForBusiness(
    event: APIGatewayProxyEvent,
    businessId: string,
    deps: {
        readonly authProvider: AuthProvider;
        readonly userService: UserService;
        readonly businessRepo: BusinessRepository;
    },
): Promise<OwnerAuthorizationResult> {
    const principal = await extractPrincipal(event, deps.authProvider);
    if (principal.role !== 'BUSINESS_OWNER') {
        return {
            ok: false,
            response: forbidden('Only BUSINESS_OWNER role can manage featuring.'),
        };
    }
    const user = await deps.userService.getByCognitoSub(principal.sub);
    if (!user) {
        return {
            ok: false,
            response: notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            ),
        };
    }
    const business = await deps.businessRepo.findById(businessId);
    if (!business || business.ownerUserId !== user.id) {
        return { ok: false, response: notFound('Business not found.') };
    }
    return { ok: true, principal, user, business };
}
