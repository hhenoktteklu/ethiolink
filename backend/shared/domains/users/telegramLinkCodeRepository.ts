// EthioLink — telegram link-code repository.
//
// Phase 9 Track 2 foundation. SQL access to the
// `users_telegram_link_codes` table (migration 0015). The service
// layer talks to the `TelegramLinkCodeRepository` interface; tests
// inject `InMemoryTelegramLinkCodeRepository`.
//
// Design notes:
//   * Rows are write-once. The only state transitions are insert
//     (new code), delete (redeem / unlink / sweep), and the
//     `deleteForUser` convenience used by `startLink` to invalidate
//     a previous in-flight code when the user taps "Start
//     linking" a second time.
//   * `findByCode` returns `null` rather than throwing when the
//     code is absent — redemption attempts on unknown / expired
//     codes are a user-driven error, not an exceptional condition.
//   * `deleteExpired` returns the row count so the daily sweep
//     job can log a metric. Keep the implementation simple — no
//     pagination, because the table is tiny (10-minute TTL + one
//     row per pending link).

import { BaseRepository } from '../../repositories/baseRepository.js';

/** Domain shape of a link-code row. */
export interface TelegramLinkCode {
    readonly code: string;
    readonly userId: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
}

export interface InsertTelegramLinkCode {
    readonly code: string;
    readonly userId: string;
    readonly expiresAt: Date;
}

export interface TelegramLinkCodeRepository {
    /** Insert a fresh code. Caller is expected to have generated a
     *  collision-resistant `code` and computed `expiresAt`. */
    insert(input: InsertTelegramLinkCode): Promise<TelegramLinkCode>;

    /** Lookup by code. `null` when absent. */
    findByCode(code: string): Promise<TelegramLinkCode | null>;

    /** Delete by code. No-op (returns false) when absent. */
    deleteByCode(code: string): Promise<boolean>;

    /** Delete every code belonging to a single user. Used by
     *  `startLink` to invalidate prior in-flight codes. Returns
     *  the number of rows deleted. */
    deleteForUser(userId: string): Promise<number>;

    /** Sweep expired rows. Returns the number of rows deleted so
     *  the caller can log a metric. */
    deleteExpired(now: Date): Promise<number>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface LinkCodeRow {
    code: string;
    user_id: string;
    expires_at: Date;
    created_at: Date;
}

const LINK_CODE_COLUMNS = 'code, user_id, expires_at, created_at';

export class PgTelegramLinkCodeRepository
    extends BaseRepository
    implements TelegramLinkCodeRepository
{
    async insert(
        input: InsertTelegramLinkCode,
    ): Promise<TelegramLinkCode> {
        const row = await this.one<LinkCodeRow>(
            `
            INSERT INTO users_telegram_link_codes (code, user_id, expires_at)
            VALUES ($1, $2, $3)
            RETURNING ${LINK_CODE_COLUMNS};
            `,
            [input.code, input.userId, input.expiresAt],
        );
        return mapRow(row);
    }

    async findByCode(code: string): Promise<TelegramLinkCode | null> {
        const row = await this.oneOrNone<LinkCodeRow>(
            `SELECT ${LINK_CODE_COLUMNS}
               FROM users_telegram_link_codes
              WHERE code = $1;`,
            [code],
        );
        return row ? mapRow(row) : null;
    }

    async deleteByCode(code: string): Promise<boolean> {
        const { rowCount } = await this.query(
            `DELETE FROM users_telegram_link_codes WHERE code = $1;`,
            [code],
        );
        return (rowCount ?? 0) > 0;
    }

    async deleteForUser(userId: string): Promise<number> {
        const { rowCount } = await this.query(
            `DELETE FROM users_telegram_link_codes WHERE user_id = $1;`,
            [userId],
        );
        return rowCount ?? 0;
    }

    async deleteExpired(now: Date): Promise<number> {
        const { rowCount } = await this.query(
            `DELETE FROM users_telegram_link_codes WHERE expires_at < $1;`,
            [now],
        );
        return rowCount ?? 0;
    }
}

function mapRow(row: LinkCodeRow): TelegramLinkCode {
    return Object.freeze<TelegramLinkCode>({
        code: row.code,
        userId: row.user_id,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
    });
}
