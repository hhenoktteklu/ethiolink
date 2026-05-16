// EthioLink — in-memory `UserRepository` fake for tests.
//
// Implements the same surface as `PgUserRepository` (sans SQL) so we can
// exercise `UserService` without booting Postgres. Behavior mirrors the
// production repository:
//
//   * `upsertFromAuth` inserts a new row keyed by `cognitoSub`, or updates
//     only the four principal-derived fields on conflict. `status` is set
//     once on insert and never touched on update.
//   * `update` mutates only the fields present in the patch.
//   * Lookups by id or by `cognitoSub` return `null` when not found, matching
//     the interface contract. `update` against a missing id throws
//     `RepositoryError`, like the SQL implementation.
//
// Not exported from the main module graph — lives under `tests/` so it
// cannot accidentally be imported by production code.

import { randomUUID } from 'node:crypto';

import { RepositoryError } from '../../shared/repositories/baseRepository.js';
import type {
    AdminUserFilters,
    UpdateUserFields,
    UpsertUserFromAuthInput,
    User,
    UserLocale,
    UserRepository,
    UserStatus,
} from '../../shared/domains/users/userRepository.js';

export class InMemoryUserRepository implements UserRepository {
    private readonly rowsById = new Map<string, User>();
    private readonly rowsBySub = new Map<string, User>();

    /** Test helper: total number of rows stored. */
    size(): number {
        return this.rowsById.size;
    }

    async upsertFromAuth(input: UpsertUserFromAuthInput): Promise<User> {
        const existing = this.rowsBySub.get(input.cognitoSub);
        const now = new Date();

        const user: User = existing
            ? Object.freeze<User>({
                  ...existing,
                  email: input.email,
                  phone: input.phone,
                  role: input.role,
                  displayName: input.displayName,
                  updatedAt: now,
              })
            : Object.freeze<User>({
                  id: randomUUID(),
                  cognitoSub: input.cognitoSub,
                  email: input.email,
                  phone: input.phone,
                  role: input.role,
                  status: 'ACTIVE',
                  displayName: input.displayName,
                  telegramChatId: null,
                  locale: 'en',
                  createdAt: now,
                  updatedAt: now,
              });

        this.rowsById.set(user.id, user);
        this.rowsBySub.set(user.cognitoSub, user);
        return user;
    }

    async findById(id: string): Promise<User | null> {
        return this.rowsById.get(id) ?? null;
    }

    async findByCognitoSub(cognitoSub: string): Promise<User | null> {
        return this.rowsBySub.get(cognitoSub) ?? null;
    }

    async update(id: string, patch: UpdateUserFields): Promise<User> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`User ${id} not found.`);
        }
        // Empty patch → no-op fresh read, mirrors the Pg
        // implementation's short-circuit.
        if (patch.displayName === undefined && patch.locale === undefined) {
            return existing;
        }
        const updated = Object.freeze<User>({
            ...existing,
            displayName:
                patch.displayName === undefined
                    ? existing.displayName
                    : patch.displayName,
            locale:
                patch.locale === undefined ? existing.locale : patch.locale,
            updatedAt: new Date(),
        });
        this.rowsById.set(updated.id, updated);
        this.rowsBySub.set(updated.cognitoSub, updated);
        return updated;
    }

    async setStatus(id: string, status: UserStatus): Promise<User> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`User ${id} not found.`);
        }
        const updated = Object.freeze<User>({
            ...existing,
            status,
            updatedAt: new Date(),
        });
        this.rowsById.set(updated.id, updated);
        this.rowsBySub.set(updated.cognitoSub, updated);
        return updated;
    }

    async setLocale(id: string, locale: UserLocale): Promise<User> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`User ${id} not found.`);
        }
        const updated = Object.freeze<User>({
            ...existing,
            locale,
            updatedAt: new Date(),
        });
        this.rowsById.set(updated.id, updated);
        this.rowsBySub.set(updated.cognitoSub, updated);
        return updated;
    }

    async setTelegramChatId(
        id: string,
        chatId: string | null,
    ): Promise<User> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`User ${id} not found.`);
        }
        const updated = Object.freeze<User>({
            ...existing,
            telegramChatId: chatId,
            updatedAt: new Date(),
        });
        this.rowsById.set(updated.id, updated);
        this.rowsBySub.set(updated.cognitoSub, updated);
        return updated;
    }

    async listForAdmin(
        filters: AdminUserFilters,
        limit: number,
    ): Promise<readonly User[]> {
        return Array.from(this.rowsById.values())
            .filter((u) => filters.status === undefined || u.status === filters.status)
            .filter((u) => filters.role === undefined || u.role === filters.role)
            .sort(
                (a, b) =>
                    b.createdAt.getTime() - a.createdAt.getTime() ||
                    (a.id < b.id ? 1 : -1),
            )
            .slice(0, limit);
    }
}
