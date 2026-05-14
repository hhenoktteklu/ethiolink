// EthioLink — pull an authenticated principal out of an API Gateway event.
//
// Two paths, in priority order:
//
//   1. Pre-validated claims from API Gateway's Cognito authorizer. In
//      production, API Gateway has already verified the JWT and surfaced
//      the claims at `event.requestContext.authorizer.claims`. The Lambda
//      only needs to translate those claims into our `AuthPrincipal`.
//
//   2. Raw `Authorization: Bearer <jwt>` header. Used in local-dev,
//      integration tests, and any deployment where Lambda is invoked
//      without an authorizer in front of it. The token is cryptographically
//      verified by `CognitoAuthProvider.verifyToken`.
//
// Throws {@link AuthError} (or one of its subclasses) when neither path
// produces a valid principal. The Lambda handler maps that to a 401 via
// `unauthenticated()`.

import type { APIGatewayProxyEvent } from 'aws-lambda';

import {
    AuthError,
    type AuthPrincipal,
    type AuthProvider,
} from '../adapters/auth/AuthProvider.js';

export async function extractPrincipal(
    event: APIGatewayProxyEvent,
    authProvider: AuthProvider,
): Promise<AuthPrincipal> {
    const claims = readApiGatewayClaims(event);
    if (claims) {
        return authProvider.principalFromClaims(claims);
    }

    const token = readBearerToken(event.headers);
    if (token) {
        return authProvider.verifyToken(token);
    }

    throw new AuthError('No authentication credentials in request.');
}

/**
 * Read pre-validated claims from a REST API Cognito authorizer event.
 *
 * The shape is `event.requestContext.authorizer.claims = { sub, email, ... }`
 * with string values. We type it loosely because `@types/aws-lambda` keeps
 * the authorizer dictionary as `any` for forward compatibility with custom
 * authorizers.
 */
function readApiGatewayClaims(event: APIGatewayProxyEvent): Record<string, unknown> | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- authorizer is `any` by design.
    const authorizer = (event.requestContext as { authorizer?: any }).authorizer;
    const claims = authorizer?.claims;
    if (claims && typeof claims === 'object' && Object.keys(claims).length > 0) {
        return claims as Record<string, unknown>;
    }
    return null;
}

/** Pull a bearer token out of HTTP headers. Case-insensitive on the header name. */
function readBearerToken(
    headers: APIGatewayProxyEvent['headers'] | undefined,
): string | null {
    if (!headers) return null;
    const raw =
        headers['Authorization'] ??
        headers['authorization'] ??
        headers['AUTHORIZATION'];
    if (typeof raw !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
    const token = match?.[1]?.trim();
    return token && token.length > 0 ? token : null;
}
