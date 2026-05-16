// EthioLink — TelegramLinkService tests.
//
// Coverage:
//   * `startLink` — issues a deep-linked code, inserts a row,
//     respects TTL, and invalidates any prior code for the same
//     user.
//   * `startLink` — unknown user → TelegramLinkUserNotFoundError.
//   * `redeemCode` — happy path: writes telegram_chat_id, deletes
//     the code, returns the updated user.
//   * `redeemCode` — unknown code → TelegramLinkCodeNotFoundError.
//   * `redeemCode` — expired code → TelegramLinkCodeExpiredError +
//     code is removed best-effort.
//   * `redeemCode` — empty chatId → TELEGRAM_LINK_CHAT_ID_INVALID.
//   * `unlink` — clears chat id; returns false when already null.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger } from '../../shared/logging/logger.js';

import {
    TelegramLinkCodeExpiredError,
    TelegramLinkCodeNotFoundError,
    TelegramLinkError,
    TelegramLinkService,
    TelegramLinkUserNotFoundError,
    isLikelyDefaultLinkCode,
    type Clock,
    type TelegramLinkServiceConfig,
} from '../../shared/domains/users/telegramLinkService.js';
import { InMemoryTelegramLinkCodeRepository } from '../_fakes/InMemoryTelegramLinkCodeRepository.js';
import { InMemoryUserRepository } from '../_fakes/InMemoryUserRepository.js';

const CONFIG: TelegramLinkServiceConfig = Object.freeze({
    botUsername: 'EthioLinkBot',
    linkCodeTtlSeconds: 600,
});

function silentLogger() {
    return createLogger({
        level: 'error',
        sink: { write: () => {} },
    });
}

class FixedClock implements Clock {
    public time: Date;
    constructor(initial: Date) {
        this.time = initial;
    }
    now(): Date {
        return this.time;
    }
}

async function seedUser(users: InMemoryUserRepository) {
    return users.upsertFromAuth({
        cognitoSub: 'sub-1',
        email: 'owner@example.com',
        phone: '+251911000001',
        role: 'BUSINESS_OWNER',
        displayName: 'Selam Tadesse',
    });
}

describe('TelegramLinkService.startLink', () => {
    it('issues a deep-linked code and stores a row with the configured TTL', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);

        const clock = new FixedClock(new Date('2026-05-15T10:00:00Z'));
        const svc = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
            clock,
            codeGenerator: () => 'STATIC-CODE-A',
        });

        const out = await svc.startLink(user.id);
        assert.strictEqual(out.code, 'STATIC-CODE-A');
        assert.strictEqual(
            out.deepLink,
            'https://t.me/EthioLinkBot?start=STATIC-CODE-A',
        );
        assert.strictEqual(out.expiresAt, '2026-05-15T10:10:00.000Z');

        const stored = await codes.findByCode('STATIC-CODE-A');
        assert.ok(stored);
        assert.strictEqual(stored.userId, user.id);
    });

    it('invalidates any prior in-flight code for the same user', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);

        let n = 0;
        const svc = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
            codeGenerator: () => `CODE-${n++}`,
        });

        await svc.startLink(user.id);
        await svc.startLink(user.id);

        // Only the second code survives.
        assert.strictEqual(codes.size(), 1);
        assert.ok(await codes.findByCode('CODE-1'));
        assert.strictEqual(await codes.findByCode('CODE-0'), null);
    });

    it('throws TelegramLinkUserNotFoundError for an unknown user id', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const svc = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
        });

        await assert.rejects(
            () => svc.startLink('00000000-0000-0000-0000-000000000000'),
            TelegramLinkUserNotFoundError,
        );
    });

    it('default generator produces a 32-char base32 code', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);

        const svc = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
        });

        const out = await svc.startLink(user.id);
        assert.ok(
            isLikelyDefaultLinkCode(out.code),
            `default code "${out.code}" should be 32 base32 chars`,
        );
    });
});

describe('TelegramLinkService.redeemCode', () => {
    it('writes telegram_chat_id and deletes the code on happy path', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);

        const svc = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
            codeGenerator: () => 'CODE-Z',
        });

        await svc.startLink(user.id);
        const redeemed = await svc.redeemCode('CODE-Z', '987654321');

        assert.strictEqual(redeemed.user.telegramChatId, '987654321');
        assert.strictEqual(redeemed.chatId, '987654321');
        assert.strictEqual(await codes.findByCode('CODE-Z'), null);

        // The user repo persisted the chat id.
        const reread = await users.findById(user.id);
        assert.strictEqual(reread?.telegramChatId, '987654321');
    });

    it('throws TelegramLinkCodeNotFoundError on unknown code', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const svc = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
        });

        await assert.rejects(
            () => svc.redeemCode('NOPE', '987'),
            TelegramLinkCodeNotFoundError,
        );
    });

    it('throws TelegramLinkCodeExpiredError when the code has expired', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);

        const clock = new FixedClock(new Date('2026-05-15T10:00:00Z'));
        const svc = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
            clock,
            codeGenerator: () => 'CODE-EXP',
        });

        await svc.startLink(user.id);

        // Advance past the TTL.
        clock.time = new Date('2026-05-15T10:20:00Z');

        await assert.rejects(
            () => svc.redeemCode('CODE-EXP', '987'),
            TelegramLinkCodeExpiredError,
        );

        // Expired code was deleted best-effort.
        assert.strictEqual(await codes.findByCode('CODE-EXP'), null);
    });

    it('throws TELEGRAM_LINK_CHAT_ID_INVALID when chatId is empty', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const svc = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
        });

        await assert.rejects(
            () => svc.redeemCode('CODE-X', '   '),
            (err: unknown) =>
                err instanceof TelegramLinkError &&
                err.code === 'TELEGRAM_LINK_CHAT_ID_INVALID',
        );
    });
});

describe('TelegramLinkService.unlink', () => {
    it('clears the chat id and returns true when one was set', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);

        const svc = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
            codeGenerator: () => 'CODE-U',
        });
        await svc.startLink(user.id);
        await svc.redeemCode('CODE-U', '111');

        const out = await svc.unlink(user.id);
        assert.strictEqual(out, true);
        const reread = await users.findById(user.id);
        assert.strictEqual(reread?.telegramChatId, null);
    });

    it('returns false when the user has no chat id', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);

        const svc = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
        });
        const out = await svc.unlink(user.id);
        assert.strictEqual(out, false);
    });

    it('clears any in-flight linking codes for the user', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);

        // Two services over the same repos so we can swap the
        // code generator between issuances cleanly. Service A
        // links the user; service B issues a brand-new (un-
        // redeemed) code before we call unlink.
        const svcA = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
            codeGenerator: () => 'CODE-PENDING',
        });
        await svcA.startLink(user.id);
        await svcA.redeemCode('CODE-PENDING', '222');

        const svcB = new TelegramLinkService({
            userRepo: users,
            linkCodeRepo: codes,
            config: CONFIG,
            logger: silentLogger(),
            codeGenerator: () => 'CODE-NEW',
        });
        await svcB.startLink(user.id);
        assert.ok(await codes.findByCode('CODE-NEW'));

        // Unlink should clear the chat id AND the brand-new code.
        const result = await svcB.unlink(user.id);
        assert.strictEqual(result, true);
        assert.strictEqual(await codes.findByCode('CODE-NEW'), null);
    });
});
