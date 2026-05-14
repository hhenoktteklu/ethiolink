// EthioLink — auth adapter interface.
//
// The service layer talks to authentication exclusively through this
// interface. The Cognito-specific implementation lives in
// `CognitoAuthProvider.ts`. Per ADR-0002, this is the seam that keeps the
// option open to swap identity providers without rewriting domain code.
//
// Two entry points:
//
//   * `verifyToken(rawJwt)` — cryptographically verify a JWT (signature,
//     issuer, audience, expiry) and return the authenticated principal.
//     Used in local-dev and integration paths where a Lambda may be invoked
//     without API Gateway in front of it.
//
//   * `principalFromClaims(claims)` — extract the principal from claims that
//     have already been validated upstream. In production, API Gateway's
//     Cognito authorizer is the validator; the Lambda only needs to parse.
//
// Both methods normalize the response into `AuthPrincipal`, which is the
// only type the services depend on. The shape mirrors what `userService`
// will write into the `users` table on first sync.

/**
 * Application roles. These deliberately match the Cognito group names
 * provisioned in `infra/terraform/modules/cognito/main.tf`, but the mapping
 * is one-way: the adapter translates a list of Cognito groups into one of
 * these roles. The rest of the codebase never sees a Cognito group name.
 */
export type UserRole = 'CUSTOMER' | 'BUSINESS_OWNER' | 'ADMIN';

/**
 * Highest-precedence wins. If a user is in both ADMIN and BUSINESS_OWNER
 * groups, they are an ADMIN to the rest of the application. A user with no
 * recognized group is a CUSTOMER (the public-default role).
 */
export const ROLE_PRECEDENCE: readonly UserRole[] = ['ADMIN', 'BUSINESS_OWNER', 'CUSTOMER'];

/**
 * The authenticated principal, in domain shape. Created by the auth adapter
 * and passed inward — no Cognito types leak past this point.
 */
export interface AuthPrincipal {
    /** Stable identifier from the identity provider. Mirrored into `users.cognito_sub`. */
    readonly sub: string;
    /** Verified email, lower-cased. Null if the user signed up with phone only. */
    readonly email: string | null;
    /** Verified phone in E.164. Null if the user signed up with email only. */
    readonly phone: string | null;
    /** User's preferred display name, if the IdP carries one. */
    readonly displayName: string | null;
    /** Raw group names from the IdP. Exposed for diagnostics; services should use `role`. */
    readonly groups: readonly string[];
    /** Derived role, computed via {@link ROLE_PRECEDENCE}. */
    readonly role: UserRole;
}

/**
 * Base class for auth adapter failures. Keep these distinct from generic
 * `Error` so the API layer can map them to HTTP 401 cleanly.
 */
export class AuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AuthError';
    }
}

/** JWT was syntactically valid but had expired by `exp`. */
export class TokenExpiredError extends AuthError {
    constructor(message = 'Token has expired.') {
        super(message);
        this.name = 'TokenExpiredError';
    }
}

/** JWT failed signature / issuer / audience / token-use validation. */
export class TokenInvalidError extends AuthError {
    constructor(message = 'Token is invalid.') {
        super(message);
        this.name = 'TokenInvalidError';
    }
}

/** Claims object is missing a field we need (e.g., no `sub`). */
export class ClaimsMalformedError extends AuthError {
    constructor(field: string) {
        super(`Claims are missing required field "${field}".`);
        this.name = 'ClaimsMalformedError';
    }
}

export interface AuthProvider {
    /**
     * Cryptographically verify `rawJwt` and return the authenticated principal.
     *
     * @throws {@link TokenExpiredError}    when `exp` is in the past.
     * @throws {@link TokenInvalidError}    when signature, issuer, audience,
     *                                      or token-use is wrong.
     * @throws {@link ClaimsMalformedError} when the verified token lacks `sub`.
     */
    verifyToken(rawJwt: string): Promise<AuthPrincipal>;

    /**
     * Build a principal from a pre-validated claims object (e.g., the
     * `requestContext.authorizer.claims` injected by API Gateway).
     *
     * This method does NOT verify the token; the caller is asserting that the
     * claims have already been verified upstream.
     *
     * @throws {@link ClaimsMalformedError} when `claims.sub` is absent.
     */
    principalFromClaims(claims: Record<string, unknown>): AuthPrincipal;
}

/** Compute the domain role from a list of Cognito group names. Exported for tests. */
export function deriveRole(groups: readonly string[]): UserRole {
    for (const role of ROLE_PRECEDENCE) {
        if (groups.includes(role)) {
            return role;
        }
    }
    return 'CUSTOMER';
}
