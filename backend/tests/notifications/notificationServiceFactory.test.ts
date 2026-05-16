// EthioLink — `notificationServiceFactory` unit tests.
//
// Phase 9. Covers the gateway-selection branch the factory adds on
// top of the original hand-written `new NotificationService({...})`
// pattern. The factory's actual `new NotificationService(...)`
// call needs a `Pool` to construct repositories — we don't run a
// real DB here, so the tests focus on the pure logic exposed
// via `shouldWireSmsGateway` + `buildGatewayMap` rather than the
// full factory `createNotificationService`. Both helpers are
// exported precisely so this test suite can exercise them without
// the DB-side dependency.
//
// Cases:
//   * MOCK is always wired.
//   * SMS is NOT wired when `notificationsProvider === 'mock'`
//     even if `smsProvider` config is present.
//   * SMS is NOT wired when `smsProvider` is null even if
//     `notificationsProvider === 'sms'`.
//   * SMS IS wired when both conditions hold and
//     `notificationsProvider === 'sms'`.
//   * SMS IS wired when `notificationsProvider === 'production'`.
//   * The injected `mockGateway` override appears in the map.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GenericSmsGateway } from '../../shared/adapters/notifications/GenericSmsGateway.js';
import { GenericTelegramGateway } from '../../shared/adapters/notifications/GenericTelegramGateway.js';
import { MockNotificationGateway } from '../../shared/adapters/notifications/MockNotificationGateway.js';
import type { NotificationGateway } from '../../shared/adapters/notifications/NotificationGateway.js';
import type {
    AppConfig,
    SmsProviderConfig,
    TelegramProviderConfig,
} from '../../shared/config/loadConfig.js';
import {
    buildGatewayMap,
    shouldWireSmsGateway,
    shouldWireTelegramGateway,
} from '../../shared/domains/notifications/notificationServiceFactory.js';
import { FakeSmsHttpTransport } from '../_fakes/FakeSmsHttpTransport.js';
import { FakeTelegramHttpTransport } from '../_fakes/FakeTelegramHttpTransport.js';

// Lazy logger that satisfies the type without doing anything.
function fakeLogger() {
    const noop = () => {};
    const self: any = {
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        child: () => self,
    };
    return self;
}

const SAMPLE_SMS_CONFIG: SmsProviderConfig = Object.freeze({
    apiBaseUrl: 'https://sms.example.com',
    apiKey: 'test-key',
    apiKeySecretArn: '',
    senderId: 'EthioLink',
    providerName: 'GENERIC_SMS',
    timeoutMs: 5000,
});

const SAMPLE_TELEGRAM_CONFIG: TelegramProviderConfig = Object.freeze({
    botUsername: 'EthioLinkBot',
    botToken: '123:abc',
    botTokenSecretArn: '',
    webhookSecret: 'whsec',
    webhookSecretArn: '',
    providerName: 'TELEGRAM_BOT',
    linkCodeTtlSeconds: 600,
    timeoutMs: 5000,
});

// Construct a minimal `AppConfig` for the factory selection. The
// factory only reads `smsProvider` and `notificationsProvider` —
// every other field is irrelevant to the logic under test.
function mkConfig(overrides: {
    smsProvider?: SmsProviderConfig | null;
    telegramProvider?: TelegramProviderConfig | null;
    notificationsProvider?: AppConfig['notificationsProvider'];
}): AppConfig {
    return {
        nodeEnv: 'test',
        logLevel: 'info',
        region: 'eu-west-1',
        pg: {
            host: 'h',
            port: 5432,
            database: 'd',
            user: 'u',
            password: 'p',
            ssl: false,
        },
        cognito: {
            userPoolId: 'p',
            appClientIdMobile: 'm',
            appClientIdAdmin: 'a',
            region: 'eu-west-1',
        },
        s3: {
            publicBucket: '',
            privateBucket: '',
            uploadUrlExpiresSeconds: 900,
            readUrlExpiresSeconds: 3600,
        },
        booking: {
            slotStepMinutes: 15,
            bufferMinutes: 5,
            cancelCutoffMinutes: 240,
            defaultTimezone: 'Africa/Addis_Ababa',
        },
        smsProvider: overrides.smsProvider ?? null,
        telegramProvider: overrides.telegramProvider ?? null,
        notificationsProvider: overrides.notificationsProvider ?? 'mock',
    } as AppConfig;
}

// `buildGatewayMap` needs `pool`, but the mock-override path lets
// us skip ever using it. The factory only constructs the SMS
// gateway when conditions are met; tests use the mock-override
// branch and the SMS-config branch separately.
const FAKE_POOL = {} as unknown as import('pg').Pool;

describe('shouldWireSmsGateway', () => {
    it('returns false when smsProvider is null', () => {
        assert.strictEqual(
            shouldWireSmsGateway(
                mkConfig({ smsProvider: null, notificationsProvider: 'sms' }),
            ),
            false,
        );
    });

    it('returns false when notificationsProvider is mock', () => {
        assert.strictEqual(
            shouldWireSmsGateway(
                mkConfig({
                    smsProvider: SAMPLE_SMS_CONFIG,
                    notificationsProvider: 'mock',
                }),
            ),
            false,
        );
    });

    it('returns true when smsProvider is set and notificationsProvider is sms', () => {
        assert.strictEqual(
            shouldWireSmsGateway(
                mkConfig({
                    smsProvider: SAMPLE_SMS_CONFIG,
                    notificationsProvider: 'sms',
                }),
            ),
            true,
        );
    });

    it('returns true when notificationsProvider is production', () => {
        assert.strictEqual(
            shouldWireSmsGateway(
                mkConfig({
                    smsProvider: SAMPLE_SMS_CONFIG,
                    notificationsProvider: 'production',
                }),
            ),
            true,
        );
    });
});

describe('buildGatewayMap — MOCK only', () => {
    it('wires MOCK and omits SMS when SMS is unconfigured', () => {
        const map = buildGatewayMap({
            pool: FAKE_POOL,
            config: mkConfig({ smsProvider: null, notificationsProvider: 'mock' }),
            logger: fakeLogger(),
        });

        assert.ok(map.MOCK instanceof MockNotificationGateway);
        assert.strictEqual(map.SMS, undefined);
    });

    it('still omits SMS when smsProvider is set but provider flag is mock', () => {
        const map = buildGatewayMap({
            pool: FAKE_POOL,
            config: mkConfig({
                smsProvider: SAMPLE_SMS_CONFIG,
                notificationsProvider: 'mock',
            }),
            logger: fakeLogger(),
        });

        assert.strictEqual(map.SMS, undefined);
    });
});

describe('buildGatewayMap — SMS wired', () => {
    it('wires GenericSmsGateway when both conditions hold', () => {
        const transport = new FakeSmsHttpTransport();
        const map = buildGatewayMap({
            pool: FAKE_POOL,
            config: mkConfig({
                smsProvider: SAMPLE_SMS_CONFIG,
                notificationsProvider: 'sms',
            }),
            logger: fakeLogger(),
            smsHttpTransport: transport,
        });

        assert.ok(map.MOCK instanceof MockNotificationGateway);
        assert.ok(
            map.SMS instanceof GenericSmsGateway,
            'expected SMS channel to be a GenericSmsGateway instance',
        );
    });

    it('forwards the smsHttpTransport injection into the gateway', async () => {
        const transport = new FakeSmsHttpTransport();
        transport.enqueue({
            status: 200,
            body: { messageId: 'msg-via-factory' },
        });

        const map = buildGatewayMap({
            pool: FAKE_POOL,
            config: mkConfig({
                smsProvider: SAMPLE_SMS_CONFIG,
                notificationsProvider: 'production',
            }),
            logger: fakeLogger(),
            smsHttpTransport: transport,
        });

        const gw = map.SMS as GenericSmsGateway;
        const result = await gw.send({
            channel: 'SMS',
            recipient: { phoneE164: '+251911000001' },
            rendered: { subject: null, body: 'hello', metadata: {} },
            idempotencyKey: 'idem-1',
        });

        assert.strictEqual(result.status, 'SENT');
        assert.strictEqual(result.providerRef, 'msg-via-factory');
        assert.strictEqual(transport.calls.length, 1);
    });
});

describe('shouldWireTelegramGateway', () => {
    it('returns false when telegramProvider is null', () => {
        assert.strictEqual(
            shouldWireTelegramGateway(
                mkConfig({
                    telegramProvider: null,
                    notificationsProvider: 'telegram',
                }),
            ),
            false,
        );
    });

    it('returns false when notificationsProvider is mock', () => {
        assert.strictEqual(
            shouldWireTelegramGateway(
                mkConfig({
                    telegramProvider: SAMPLE_TELEGRAM_CONFIG,
                    notificationsProvider: 'mock',
                }),
            ),
            false,
        );
    });

    it('returns false when notificationsProvider is sms (SMS-only opt-in)', () => {
        assert.strictEqual(
            shouldWireTelegramGateway(
                mkConfig({
                    telegramProvider: SAMPLE_TELEGRAM_CONFIG,
                    notificationsProvider: 'sms',
                }),
            ),
            false,
        );
    });

    it('returns true when telegramProvider is set and notificationsProvider is telegram', () => {
        assert.strictEqual(
            shouldWireTelegramGateway(
                mkConfig({
                    telegramProvider: SAMPLE_TELEGRAM_CONFIG,
                    notificationsProvider: 'telegram',
                }),
            ),
            true,
        );
    });

    it('returns true when notificationsProvider is production', () => {
        assert.strictEqual(
            shouldWireTelegramGateway(
                mkConfig({
                    telegramProvider: SAMPLE_TELEGRAM_CONFIG,
                    notificationsProvider: 'production',
                }),
            ),
            true,
        );
    });
});

describe('buildGatewayMap — TELEGRAM wired', () => {
    it('wires GenericTelegramGateway when both conditions hold', () => {
        const transport = new FakeTelegramHttpTransport();
        const map = buildGatewayMap({
            pool: FAKE_POOL,
            config: mkConfig({
                telegramProvider: SAMPLE_TELEGRAM_CONFIG,
                notificationsProvider: 'telegram',
            }),
            logger: fakeLogger(),
            telegramHttpTransport: transport,
        });

        assert.ok(map.MOCK instanceof MockNotificationGateway);
        assert.ok(
            map.TELEGRAM instanceof GenericTelegramGateway,
            'expected TELEGRAM channel to be a GenericTelegramGateway instance',
        );
        // SMS not wired (no smsProvider config).
        assert.strictEqual(map.SMS, undefined);
    });

    it('production wires BOTH SMS and TELEGRAM when both configs are set', () => {
        const map = buildGatewayMap({
            pool: FAKE_POOL,
            config: mkConfig({
                smsProvider: SAMPLE_SMS_CONFIG,
                telegramProvider: SAMPLE_TELEGRAM_CONFIG,
                notificationsProvider: 'production',
            }),
            logger: fakeLogger(),
            smsHttpTransport: new FakeSmsHttpTransport(),
            telegramHttpTransport: new FakeTelegramHttpTransport(),
        });

        assert.ok(map.MOCK instanceof MockNotificationGateway);
        assert.ok(map.SMS instanceof GenericSmsGateway);
        assert.ok(map.TELEGRAM instanceof GenericTelegramGateway);
    });

    it('telegram flag does NOT wire SMS even when smsProvider is set', () => {
        const map = buildGatewayMap({
            pool: FAKE_POOL,
            config: mkConfig({
                smsProvider: SAMPLE_SMS_CONFIG,
                telegramProvider: SAMPLE_TELEGRAM_CONFIG,
                notificationsProvider: 'telegram',
            }),
            logger: fakeLogger(),
            smsHttpTransport: new FakeSmsHttpTransport(),
            telegramHttpTransport: new FakeTelegramHttpTransport(),
        });

        assert.strictEqual(map.SMS, undefined);
        assert.ok(map.TELEGRAM instanceof GenericTelegramGateway);
    });

    it('omits TELEGRAM when telegramProvider is null even with production flag', () => {
        const map = buildGatewayMap({
            pool: FAKE_POOL,
            config: mkConfig({
                smsProvider: SAMPLE_SMS_CONFIG,
                telegramProvider: null,
                notificationsProvider: 'production',
            }),
            logger: fakeLogger(),
            smsHttpTransport: new FakeSmsHttpTransport(),
        });

        assert.strictEqual(map.TELEGRAM, undefined);
        assert.ok(map.SMS instanceof GenericSmsGateway);
    });
});

describe('buildGatewayMap — mockGateway override', () => {
    it('uses the injected mock gateway when supplied', () => {
        class StubMock implements NotificationGateway {
            public readonly channel = 'MOCK' as const;
            public readonly provider = 'STUB';
            async send() {
                return {
                    status: 'SENT' as const,
                    provider: 'STUB',
                    providerRef: 'stub-1',
                    rawResponse: null,
                    errorCode: null,
                    errorMessage: null,
                    sentAt: new Date().toISOString(),
                };
            }
        }
        const stub = new StubMock();

        const map = buildGatewayMap({
            pool: FAKE_POOL,
            config: mkConfig({ smsProvider: null, notificationsProvider: 'mock' }),
            logger: fakeLogger(),
            mockGateway: stub,
        });

        assert.strictEqual(map.MOCK, stub);
    });
});
