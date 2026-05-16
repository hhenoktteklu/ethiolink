// EthioLink — in-memory `TelegramLinkCodeRepository` fake for tests.
//
// Same surface as `PgTelegramLinkCodeRepository` (sans SQL). Stored
// in two Maps so per-user and per-code lookups stay O(1).

import type {
    InsertTelegramLinkCode,
    TelegramLinkCode,
    TelegramLinkCodeRepository,
} from '../../shared/domains/users/telegramLinkCodeRepository.js';

export class InMemoryTelegramLinkCodeRepository
    implements TelegramLinkCodeRepository
{
    private readonly rowsByCode = new Map<string, TelegramLinkCode>();

    /** Test helper: total number of rows stored. */
    size(): number {
        return this.rowsByCode.size;
    }

    async insert(
        input: InsertTelegramLinkCode,
    ): Promise<TelegramLinkCode> {
        if (this.rowsByCode.has(input.code)) {
            throw new Error(
                `InMemoryTelegramLinkCodeRepository: code "${input.code}" ` +
                    'already exists. Tests should pre-clear or use unique codes.',
            );
        }
        const row = Object.freeze<TelegramLinkCode>({
            code: input.code,
            userId: input.userId,
            expiresAt: input.expiresAt,
            createdAt: new Date(),
        });
        this.rowsByCode.set(row.code, row);
        return row;
    }

    async findByCode(code: string): Promise<TelegramLinkCode | null> {
        return this.rowsByCode.get(code) ?? null;
    }

    async deleteByCode(code: string): Promise<boolean> {
        return this.rowsByCode.delete(code);
    }

    async deleteForUser(userId: string): Promise<number> {
        let n = 0;
        for (const [code, row] of this.rowsByCode) {
            if (row.userId === userId) {
                this.rowsByCode.delete(code);
                n += 1;
            }
        }
        return n;
    }

    async deleteExpired(now: Date): Promise<number> {
        let n = 0;
        for (const [code, row] of this.rowsByCode) {
            if (row.expiresAt.getTime() < now.getTime()) {
                this.rowsByCode.delete(code);
                n += 1;
            }
        }
        return n;
    }
}
