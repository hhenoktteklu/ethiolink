// EthioLink — generic SMS gateway tests.
//
// Five-case suite covering the gateway's outcome mapping against
// a scripted `FakeSmsHttpTransport`:
//
//   * 2xx success → `status: 'SENT'`, providerRef extracted from
//     `messageId`, captured request shape matches the documented
//     wire shape (path = `<base>/v1/send`, auth = `Bearer <key>`,
//     body fields = `{ to, from, message, clientReference? }`).
//   * 4xx response → `status: 'FAILED'`, `errorCode =
//     'SMS_PROVIDER_REJECTED'`, no throw — booking flow continues.
//   * 5xx response → throw `SmsProviderUnavailableError`.
//   * Transport throws (timeout / network) → throw
//     `SmsProviderUnavailableError`.
//   * Factory called with null config → throw
//     `NotificationGatewayError` with `SMS_PROVIDER_NOT_CONFIGURED`.
//
// The gateway is dependency-free beyond the transport seam, so the
// tests are tiny and synchronous-feeling. No fake clock needed —
// the tests assert `sentAt` matches the ISO-8601 shape, not a
// specific value.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    createGenericSmsGateway,
    GenericSmsGateway,
    SmsProviderUnavailableError,
    type SmsProviderConfig,
} from '../../shared/adapters/notifications/GenericSmsGateway.js';
import {
    NotificationGatewayError,
    type NotificationSendInput,
} from '../../shared/adapters/notifications/NotificationGateway.js';
import { FakeSmsHttpTransport } from '../_fakes/FakeSmsHttpTransport.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SAMPLE_CONFIG: SmsProviderConfig = Object.freeze({
    apiBaseUrl: 'https://sms.example.com',
    apiKey: 'test-key-abc',
    apiKeySecretArn: '',
    senderId: 'EthioLink',
    providerName: 'GENERIC_SMS',
    timeoutMs: 5000,
});

function mkInput(
    overrides: Partial<NotificationSendInput> = {},
): NotificationSendInput {
    return {
        channel: 'SMS',
        recipient: {
            userId: '00000000-0000-0000-0000-000000000001',
            phoneE164: '+251911000001',
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

describe('GenericSmsGateway — success path', () => {
    it('returns SENT with extracted providerRef and the documented request shape', async () => {
        const transport = new FakeSmsHttpTransport();
        transport.enqueue({
            status: 200,
            body: { messageId: 'msg-789', status: 'queued' },
        });
        const gw = new GenericSmsGateway(SAMPLE_CONFIG, transport);

        const result = await gw.send(mkInput());

        assert.strictEqual(result.status, 'SENT');
        assert.strictEqual(result.provider, 'GENERIC_SMS');
        assert.strictEqual(result.providerRef, 'msg-789');
        assert.strictEqual(result.errorCode, null);
        assert.strictEqual(result.errorMessage, null);
        assert.match(result.sentAt, ISO_RE);
        assert.deepStrictEqual(result.rawResponse, {
            messageId: 'msg-789',
            status: 'queued',
        });

        // Request shape assertions — the gateway's contract with
        // the operator-chosen vendor.
        assert.strictEqual(transport.calls.length, 1);
        const call = transport.calls[0]!;
        assert.strictEqual(call.url, 'https://sms.example.com/v1/send');
        assert.strictEqual(
            call.options.headers.Authorization,
            'Bearer test-key-abc',
        );
        assert.strictEqual(
            call.options.headers['Content-Type'],
            'application/json',
        );
        assert.strictEqual(call.options.timeoutMs, 5000);
        assert.deepStrictEqual(call.options.body, {
            to: '+251911000001',
            from: 'EthioLink',
            message: 'Your appointment is confirmed for Friday at 14:00.',
            clientReference: 'idem-test-1',
        });
    });
});

describe('GenericSmsGateway — 4xx provider rejection', () => {
    it('returns FAILED with errorCode SMS_PROVIDER_REJECTED and no throw', async () => {
        const transport = new FakeSmsHttpTransport();
        transport.enqueue({
            status: 400,
            body: { error: 'invalid_number' },
        });
        const gw = new GenericSmsGateway(SAMPLE_CONFIG, transport);

        const result = await gw.send(mkInput());

        assert.strictEqual(result.status, 'FAILED');
        assert.strictEqual(result.provider, 'GENERIC_SMS');
        assert.strictEqual(result.providerRef, null);
        assert.strictEqual(result.errorCode, 'SMS_PROVIDER_REJECTED');
        assert.ok(
            result.errorMessage !== null &&
                result.errorMessage.includes('400'),
            `expected errorMessage to mention 400, got ${result.errorMessage}`,
        );
        assert.deepStrictEqual(result.rawResponse, {
            error: 'invalid_number',
        });
        assert.match(result.sentAt, ISO_RE);
    });
});

describe('GenericSmsGateway — 5xx provider outage', () => {
    it('throws SmsProviderUnavailableError', async () => {
        const transport = new FakeSmsHttpTransport();
        transport.enqueue({
            status: 503,
            body: 'service unavailable',
        });
        const gw = new GenericSmsGateway(SAMPLE_CONFIG, transport);

        await assert.rejects(
            () => gw.send(mkInput()),
            (err: unknown) => {
                assert.ok(err instanceof SmsProviderUnavailableError);
                assert.ok(err instanceof NotificationGatewayError);
                assert.strictEqual(err.code, 'SMS_PROVIDER_UNAVAILABLE');
                assert.ok(
                    err.message.includes('503'),
                    `expected message to mention 503, got ${err.message}`,
                );
                return true;
            },
        );
    });
});

describe('GenericSmsGateway — transport throw (timeout / network)', () => {
    it('wraps the underlying error in SmsProviderUnavailableError', async () => {
        const transport = new FakeSmsHttpTransport();
        // Simulate `fetch` aborting on timeout — `AbortError` is the
        // typical class name; the gateway treats every throw the
        // same.
        const abort = new Error('The operation was aborted.');
        abort.name = 'AbortError';
        transport.enqueue({ throws: abort });
        const gw = new GenericSmsGateway(SAMPLE_CONFIG, transport);

        await assert.rejects(
            () => gw.send(mkInput()),
            (err: unknown) => {
                assert.ok(err instanceof SmsProviderUnavailableError);
                assert.strictEqual(err.code, 'SMS_PROVIDER_UNAVAILABLE');
                assert.ok(
                    err.message.includes('aborted'),
                    `expected message to surface the underlying error, got ${err.message}`,
                );
                return true;
            },
        );
    });
});

describe('createGenericSmsGateway — missing config', () => {
    it('throws NotificationGatewayError when config is null', () => {
        assert.throws(
            () => createGenericSmsGateway(null),
            (err: unknown) => {
                assert.ok(err instanceof NotificationGatewayError);
                assert.strictEqual(
                    err.code,
                    'SMS_PROVIDER_NOT_CONFIGURED',
                );
                assert.ok(
                    err.message.includes('SMS_PROVIDER_API_BASE_URL'),
                    'error message should reference the env var name',
                );
                return true;
            },
        );
    });

    it('returns a usable gateway when config is supplied', () => {
        const transport = new FakeSmsHttpTransport();
        const gw = createGenericSmsGateway(SAMPLE_CONFIG, transport);
        assert.ok(gw instanceof GenericSmsGateway);
        assert.strictEqual(gw.channel, 'SMS');
        assert.strictEqual(gw.provider, 'GENERIC_SMS');
    });
});
