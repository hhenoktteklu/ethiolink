// EthioLink — generic Telegram gateway tests.
//
// Mirrors the SMS gateway-test suite. Six-case coverage against a
// scripted `FakeTelegramHttpTransport`:
//
//   * 2xx success → `status: 'SENT'`, `providerRef` from
//     `result.message_id`, request shape matches Telegram's
//     `sendMessage` contract (URL embeds the bot token, body =
//     `{ chat_id, text }`).
//   * 400 (chat not found) → `status: 'FAILED'` with
//     `errorCode = 'TELEGRAM_CHAT_NOT_FOUND'`, no throw.
//   * 403 (bot blocked) → `errorCode = 'TELEGRAM_FORBIDDEN'`, no throw.
//   * 429 rate-limited → `errorCode = 'TELEGRAM_RATE_LIMITED'`, no throw.
//   * 5xx → throw `TelegramProviderUnavailableError`.
//   * Transport throws (timeout / network) → throw
//     `TelegramProviderUnavailableError`.
//   * Missing `recipient.telegramChatId` → throw
//     `NotificationGatewayError('TELEGRAM_RECIPIENT_MISSING', …)`.
//   * Factory called with null config → throw
//     `NotificationGatewayError('TELEGRAM_PROVIDER_NOT_CONFIGURED', …)`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    createGenericTelegramGateway,
    GenericTelegramGateway,
    TelegramProviderUnavailableError,
    type TelegramProviderConfig,
} from '../../shared/adapters/notifications/GenericTelegramGateway.js';
import {
    NotificationGatewayError,
    type NotificationSendInput,
} from '../../shared/adapters/notifications/NotificationGateway.js';
import { FakeTelegramHttpTransport } from '../_fakes/FakeTelegramHttpTransport.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SAMPLE_CONFIG: TelegramProviderConfig = Object.freeze({
    botUsername: 'EthioLinkBot',
    botToken: '123456:test-token-abc',
    botTokenSecretArn: '',
    webhookSecret: 'whsec-test',
    webhookSecretArn: '',
    providerName: 'TELEGRAM_BOT',
    linkCodeTtlSeconds: 600,
    timeoutMs: 5000,
});

function mkInput(
    overrides: Partial<NotificationSendInput> = {},
): NotificationSendInput {
    return {
        channel: 'TELEGRAM',
        recipient: {
            userId: '00000000-0000-0000-0000-000000000001',
            telegramChatId: '987654321',
        },
        rendered: {
            subject: null,
            body: 'Your appointment is confirmed for Friday at 14:00.',
            metadata: {},
        },
        idempotencyKey: 'idem-test-1',
        ...overrides,
    };
}

describe('GenericTelegramGateway — success path', () => {
    it('returns SENT with extracted providerRef and the documented request shape', async () => {
        const transport = new FakeTelegramHttpTransport();
        transport.enqueue({
            status: 200,
            body: {
                ok: true,
                result: { message_id: 4242, chat: { id: 987654321 } },
            },
        });
        const gw = new GenericTelegramGateway(SAMPLE_CONFIG, transport);

        const result = await gw.send(mkInput());

        assert.strictEqual(result.status, 'SENT');
        assert.strictEqual(result.provider, 'TELEGRAM_BOT');
        assert.strictEqual(result.providerRef, '4242');
        assert.strictEqual(result.errorCode, null);
        assert.strictEqual(result.errorMessage, null);
        assert.match(result.sentAt, ISO_RE);

        // Request shape — the wire contract with the Bot API.
        assert.strictEqual(transport.calls.length, 1);
        const call = transport.calls[0]!;
        assert.strictEqual(
            call.url,
            'https://api.telegram.org/bot123456:test-token-abc/sendMessage',
        );
        assert.strictEqual(
            call.options.headers['Content-Type'],
            'application/json',
        );
        assert.strictEqual(call.options.timeoutMs, 5000);
        assert.deepStrictEqual(call.options.body, {
            chat_id: '987654321',
            text: 'Your appointment is confirmed for Friday at 14:00.',
        });
    });
});

describe('GenericTelegramGateway — 400 chat-not-found', () => {
    it('returns FAILED with errorCode TELEGRAM_CHAT_NOT_FOUND', async () => {
        const transport = new FakeTelegramHttpTransport();
        transport.enqueue({
            status: 400,
            body: {
                ok: false,
                error_code: 400,
                description: 'Bad Request: chat not found',
            },
        });
        const gw = new GenericTelegramGateway(SAMPLE_CONFIG, transport);

        const result = await gw.send(mkInput());

        assert.strictEqual(result.status, 'FAILED');
        assert.strictEqual(result.errorCode, 'TELEGRAM_CHAT_NOT_FOUND');
        assert.strictEqual(result.providerRef, null);
        assert.ok(result.errorMessage?.includes('HTTP 400'));
    });
});

describe('GenericTelegramGateway — 403 bot blocked', () => {
    it('returns FAILED with errorCode TELEGRAM_FORBIDDEN', async () => {
        const transport = new FakeTelegramHttpTransport();
        transport.enqueue({
            status: 403,
            body: {
                ok: false,
                error_code: 403,
                description: 'Forbidden: bot was blocked by the user',
            },
        });
        const gw = new GenericTelegramGateway(SAMPLE_CONFIG, transport);

        const result = await gw.send(mkInput());

        assert.strictEqual(result.status, 'FAILED');
        assert.strictEqual(result.errorCode, 'TELEGRAM_FORBIDDEN');
    });
});

describe('GenericTelegramGateway — 429 rate-limited', () => {
    it('returns FAILED with errorCode TELEGRAM_RATE_LIMITED', async () => {
        const transport = new FakeTelegramHttpTransport();
        transport.enqueue({
            status: 429,
            body: {
                ok: false,
                error_code: 429,
                description: 'Too Many Requests: retry after 5',
            },
        });
        const gw = new GenericTelegramGateway(SAMPLE_CONFIG, transport);

        const result = await gw.send(mkInput());

        assert.strictEqual(result.status, 'FAILED');
        assert.strictEqual(result.errorCode, 'TELEGRAM_RATE_LIMITED');
    });
});

describe('GenericTelegramGateway — 5xx unavailable', () => {
    it('throws TelegramProviderUnavailableError on 5xx', async () => {
        const transport = new FakeTelegramHttpTransport();
        transport.enqueue({
            status: 500,
            body: 'internal server error',
        });
        const gw = new GenericTelegramGateway(SAMPLE_CONFIG, transport);

        await assert.rejects(
            () => gw.send(mkInput()),
            (err: unknown) =>
                err instanceof TelegramProviderUnavailableError &&
                err.code === 'TELEGRAM_PROVIDER_UNAVAILABLE',
        );
    });
});

describe('GenericTelegramGateway — network timeout', () => {
    it('throws TelegramProviderUnavailableError when transport throws', async () => {
        const transport = new FakeTelegramHttpTransport();
        transport.enqueue({
            throws: new Error('fetch timeout'),
        });
        const gw = new GenericTelegramGateway(SAMPLE_CONFIG, transport);

        await assert.rejects(
            () => gw.send(mkInput()),
            (err: unknown) =>
                err instanceof TelegramProviderUnavailableError &&
                /fetch timeout/.test((err as Error).message),
        );
    });
});

describe('GenericTelegramGateway — missing chat id', () => {
    it('throws TELEGRAM_RECIPIENT_MISSING when telegramChatId is absent', async () => {
        const transport = new FakeTelegramHttpTransport();
        const gw = new GenericTelegramGateway(SAMPLE_CONFIG, transport);

        await assert.rejects(
            () =>
                gw.send(
                    mkInput({
                        recipient: {
                            userId: '00000000-0000-0000-0000-000000000001',
                        },
                    }),
                ),
            (err: unknown) =>
                err instanceof NotificationGatewayError &&
                err.code === 'TELEGRAM_RECIPIENT_MISSING',
        );

        // The transport was not called.
        assert.strictEqual(transport.calls.length, 0);
    });
});

describe('GenericTelegramGateway — factory', () => {
    it('throws TELEGRAM_PROVIDER_NOT_CONFIGURED when config is null', () => {
        assert.throws(
            () => createGenericTelegramGateway(null, new FakeTelegramHttpTransport()),
            (err: unknown) =>
                err instanceof NotificationGatewayError &&
                err.code === 'TELEGRAM_PROVIDER_NOT_CONFIGURED',
        );
    });

    it('constructs a gateway when config is supplied', () => {
        const gw = createGenericTelegramGateway(
            SAMPLE_CONFIG,
            new FakeTelegramHttpTransport(),
        );
        assert.strictEqual(gw.channel, 'TELEGRAM');
        assert.strictEqual(gw.provider, 'TELEGRAM_BOT');
    });
});
