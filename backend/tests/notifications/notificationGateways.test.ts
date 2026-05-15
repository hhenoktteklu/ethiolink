// EthioLink — notification gateway unit tests.
//
// Tiny suite covering the three MVP implementations of
// `NotificationGateway`:
//
//   * `MockNotificationGateway` always returns a SENT result with
//     a `mock-<uuid>` providerRef, a non-empty rawResponse, and an
//     ISO-8601 `sentAt`.
//   * `SmsNotificationGateway` always throws
//     `NotificationProviderNotConfiguredError` with the expected
//     stable `code` and a non-empty message.
//   * `TelegramNotificationGateway` — same posture as SMS.
//
// These gateways are dependency-free; no fakes or injected clocks
// needed. When real providers ship, each gets its own test file
// alongside this one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MockNotificationGateway } from '../../shared/adapters/notifications/MockNotificationGateway.js';
import {
    NotificationGatewayError,
    NotificationProviderNotConfiguredError,
} from '../../shared/adapters/notifications/NotificationGateway.js';
import type {
    NotificationSendInput,
} from '../../shared/adapters/notifications/NotificationGateway.js';
import { SmsNotificationGateway } from '../../shared/adapters/notifications/SmsNotificationGateway.js';
import { TelegramNotificationGateway } from '../../shared/adapters/notifications/TelegramNotificationGateway.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function mkInput(
    overrides: Partial<NotificationSendInput> = {},
): NotificationSendInput {
    return {
        channel: 'MOCK',
        recipient: {
            userId: '00000000-0000-0000-0000-000000000001',
            phoneE164: '+251911000001',
            emailAddress: 'customer@example.com',
            telegramChatId: '123456',
        },
        rendered: {
            subject: 'Your booking is confirmed',
            body: 'Hello — your appointment is on Friday at 14:00.',
            metadata: {},
        },
        idempotencyKey: 'idem-1',
        ...overrides,
    };
}

describe('MockNotificationGateway', () => {
    it('reports channel = MOCK and provider = MOCK', () => {
        const gw = new MockNotificationGateway();
        assert.strictEqual(gw.channel, 'MOCK');
        assert.strictEqual(gw.provider, 'MOCK');
    });

    it('returns a SENT result with a mock-<uuid> providerRef', async () => {
        const gw = new MockNotificationGateway();
        const result = await gw.send(mkInput());

        assert.strictEqual(result.status, 'SENT');
        assert.strictEqual(result.provider, 'MOCK');
        assert.ok(
            result.providerRef !== null && result.providerRef.startsWith('mock-'),
            `expected providerRef to start with 'mock-', got ${result.providerRef}`,
        );
        // mock-<uuid> — uuid is 36 chars; total length is 5 + 36 = 41.
        assert.strictEqual((result.providerRef ?? '').length, 41);
        assert.strictEqual(result.errorCode, null);
        assert.strictEqual(result.errorMessage, null);
        assert.match(result.sentAt, ISO_RE);
    });

    it('echoes the channel + recipient + body preview in rawResponse', async () => {
        const gw = new MockNotificationGateway();
        const result = await gw.send(mkInput({ channel: 'SMS' }));

        assert.ok(result.rawResponse && typeof result.rawResponse === 'object');
        const raw = result.rawResponse as Record<string, unknown>;
        assert.strictEqual(raw.mocked, true);
        assert.strictEqual(raw.channel, 'SMS');
        assert.ok(
            typeof raw.bodyPreview === 'string' && raw.bodyPreview.length > 0,
        );
    });

    it('issues a fresh providerRef on every call', async () => {
        const gw = new MockNotificationGateway();
        const a = await gw.send(mkInput());
        const b = await gw.send(mkInput());
        assert.notStrictEqual(a.providerRef, b.providerRef);
    });
});

describe('SmsNotificationGateway', () => {
    it('reports channel = SMS', () => {
        const gw = new SmsNotificationGateway();
        assert.strictEqual(gw.channel, 'SMS');
    });

    it('throws NotificationProviderNotConfiguredError on every send', async () => {
        const gw = new SmsNotificationGateway();
        await assert.rejects(
            () => gw.send(mkInput({ channel: 'SMS' })),
            (err: unknown) => {
                assert.ok(
                    err instanceof NotificationProviderNotConfiguredError,
                    `expected NotificationProviderNotConfiguredError, got ${err}`,
                );
                assert.ok(err instanceof NotificationGatewayError);
                assert.strictEqual(
                    err.code,
                    'NOTIFICATION_PROVIDER_NOT_CONFIGURED',
                );
                assert.ok(err.message.length > 0);
                return true;
            },
        );
    });
});

describe('TelegramNotificationGateway', () => {
    it('reports channel = TELEGRAM', () => {
        const gw = new TelegramNotificationGateway();
        assert.strictEqual(gw.channel, 'TELEGRAM');
    });

    it('throws NotificationProviderNotConfiguredError on every send', async () => {
        const gw = new TelegramNotificationGateway();
        await assert.rejects(
            () => gw.send(mkInput({ channel: 'TELEGRAM' })),
            (err: unknown) => {
                assert.ok(
                    err instanceof NotificationProviderNotConfiguredError,
                    `expected NotificationProviderNotConfiguredError, got ${err}`,
                );
                assert.ok(err instanceof NotificationGatewayError);
                assert.strictEqual(
                    err.code,
                    'NOTIFICATION_PROVIDER_NOT_CONFIGURED',
                );
                return true;
            },
        );
    });
});
