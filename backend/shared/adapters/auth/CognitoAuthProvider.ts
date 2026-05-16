// EthioLink — Cognito-backed AuthProvider.
//
// Verifies Cognito ID tokens (RS256) issued by the dev/prod user pools
// provisioned in `infra/terraform/modules/cognito/`. We verify ID tokens
// (not access tokens) because Phase 1 `/v1/auth/sync` needs the user's
// email / phone / name claims, which Cognito puts in the ID token.
//
// Why aws-jwt-verify and not a hand-roll:
//   * JWKS fetching, caching, and rotation are non-trivial to get right.
//   * RS256 verification with key rotation needs careful crypto handling.
//   * aws-jwt-verify is published by AWS, has zero non-stdlib runtime deps,
//     and is the library the Phase 1 task file calls out by name.
//
// What this class never does:
//   * Map to HTTP responses — the calling handler does that, translating
//     `AuthError` subclasses into the API spec's `UNAUTHENTICATED` code.
//   * Talk to the database. User-row sync is `userService`'s job.

import { CognitoJwtVerifier } from 'aws-jwt-verify';

import type { CognitoConfig } from '../../config/loadConfig.js';

import {
    type AuthPrincipal,
    type AuthProvider,
    ClaimsMalformedError,
    deriveRole,
    TokenExpiredError,
    TokenInvalidError,
} from './AuthProvider.js';

/**
 * Concrete type of the verifier returned by `CognitoJwtVerifier.create`.
 * The library types `clientId` as `string | string[]` (mutable); we
 * keep our internal alias mutable to match so the generic parameter
 * stays assignable to `CognitoVerifyProperties`.
 */
type Verifier = ReturnType<typeof CognitoJwtVerifier.create<{
    userPoolId: string;
    tokenUse: 'id';
    clientId: string[];
}>>;

export class CognitoAuthProvider implements AuthProvider {
    private readonly verifier: Verifier;

    constructor(config: CognitoConfig) {
        this.verifier = CognitoJwtVerifier.create({
            userPoolId: config.userPoolId,
            tokenUse: 'id',
            // Either app client is acceptable: mobile (Flutter) or admin (React).
            clientId: [config.appClientIdMobile, config.appClientIdAdmin],
        });
    }

    async verifyToken(rawJwt: string): Promise<AuthPrincipal> {
        if (!rawJwt || typeof rawJwt !== 'string') {
            throw new TokenInvalidError('Token is empty.');
        }
        let payload: Record<string, unknown>;
        try {
            payload = (await this.verifier.verify(rawJwt)) as Record<string, unknown>;
        } catch (err) {
            throw translateVerifierError(err);
        }
        return this.principalFromClaims(payload);
    }

    principalFromClaims(claims: Record<string, unknown>): AuthPrincipal {
        const sub = readRequiredString(claims, 'sub');
        const emailRaw = readOptionalString(claims, 'email');
        const phone = readOptionalString(claims, 'phone_number');
        const displayName = readOptionalString(claims, 'name');
        const groups = readGroups(claims);

        return Object.freeze<AuthPrincipal>({
            sub,
            email: emailRaw ? emailRaw.toLowerCase() : null,
            phone,
            displayName,
            groups,
            role: deriveRole(groups),
        });
    }
}

// ---------------------------------------------------------------------------
// Claim parsing helpers
// ---------------------------------------------------------------------------

function readRequiredString(claims: Record<string, unknown>, field: string): string {
    const value = claims[field];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ClaimsMalformedError(field);
    }
    return value;
}

function readOptionalString(claims: Record<string, unknown>, field: string): string | null {
    const value = claims[field];
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    return value;
}

/**
 * Cognito puts groups under the claim `cognito:groups`. The shape is normally
 * an array of strings, but tokens decoded by some libraries return a
 * comma-separated string. We tolerate both.
 */
function readGroups(claims: Record<string, unknown>): readonly string[] {
    const raw = claims['cognito:groups'];
    if (raw === undefined || raw === null) {
        return [];
    }
    if (Array.isArray(raw)) {
        return raw.filter((g): g is string => typeof g === 'string' && g.length > 0);
    }
    if (typeof raw === 'string') {
        return raw
            .split(',')
            .map((g) => g.trim())
            .filter((g) => g.length > 0);
    }
    return [];
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Translate an `aws-jwt-verify` failure into our domain `AuthError` family.
 *
 * The library exposes specific error classes (e.g., `JwtExpiredError`,
 * `JwtInvalidSignatureError`, `JwksValidationError`), but matching on
 * `error.name` keeps us decoupled from the library's internal class
 * hierarchy and is robust across minor-version upgrades.
 */
function translateVerifierError(err: unknown): Error {
    const name = err instanceof Error ? err.name : '';
    const message = err instanceof Error ? err.message : String(err);

    if (name === 'JwtExpiredError' || /expired/i.test(message)) {
        return new TokenExpiredError(message);
    }
    return new TokenInvalidError(message);
}
