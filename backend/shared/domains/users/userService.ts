// EthioLink — user service.
//
// Pure domain logic for managing user rows. The service:
//   * Owns the rules around `/v1/auth/sync` and the `/v1/me` read + patch
//     paths.
//   * Knows nothing about HTTP, Lambda events, or Cognito. The Lambda
//     handler is responsible for parsing requests, calling this service,
//     and serializing the response.
//   * Depends only on the `UserRepository` interface (so tests inject an
//     in-memory fake) and an optional `Logger`.
//
// Sync semantics (Phase 1 acceptance criteria):
//
//   1. First call for a Cognito sub INSERTs a `users` row, picking up the
//      role derived from the principal's Cognito groups.
//   2. Subsequent calls for the same sub UPDATE only the principal-derived
//      fields (email, phone, role, display_name). They never touch
//      `status` — that is admin-controlled — and never create duplicates.
//   3. The user is therefore *idempotent in input*: same Cognito principal
//      in → same `users` row state out.

import type { AuthPrincipal } from '../../adapters/auth/AuthProvider.js';
import type { Logger } from '../../logging/logger.js';

import type { UpdateUserFields, User, UserRepository } from './userRepository.js';

/** Raised by the service when a domain invariant is violated. */
export class UserNotFoundError extends Error {
    public readonly userId: string;
    constructor(userId: string) {
        super(`User ${userId} not found.`);
        this.name = 'UserNotFoundError';
        this.userId = userId;
    }
}

export class UserService {
    constructor(
        private readonly repository: UserRepository,
        private readonly logger?: Logger,
    ) {}

    /**
     * Upsert the calling user from a verified Cognito principal. Returns the
     * resulting `users` row (created or refreshed). Idempotent for the same
     * principal input — see file header for the exact semantics.
     */
    async syncFromPrincipal(principal: AuthPrincipal): Promise<User> {
        const user = await this.repository.upsertFromAuth({
            cognitoSub: principal.sub,
            email: principal.email,
            phone: principal.phone,
            role: principal.role,
            displayName: principal.displayName,
        });
        this.logger?.info('user.sync', {
            userId: user.id,
            sub: user.cognitoSub,
            role: user.role,
        });
        return user;
    }

    /** Fetch a user by primary key. Returns `null` when not found. */
    async getById(id: string): Promise<User | null> {
        return this.repository.findById(id);
    }

    /** Fetch a user by Cognito `sub`. Returns `null` when not found. */
    async getByCognitoSub(cognitoSub: string): Promise<User | null> {
        return this.repository.findByCognitoSub(cognitoSub);
    }

    /**
     * Apply a partial patch to the user identified by `id`.
     *
     * Throws {@link UserNotFoundError} if the user does not exist. Returns
     * the post-update row (including the trigger-updated `updated_at`).
     */
    async update(id: string, patch: UpdateUserFields): Promise<User> {
        if (!(await this.repository.findById(id))) {
            throw new UserNotFoundError(id);
        }
        const updated = await this.repository.update(id, patch);
        this.logger?.info('user.update', {
            userId: updated.id,
            fields: Object.keys(patch),
        });
        return updated;
    }
}
