// EthioLink — NotificationService unit tests.
//
// Exercises the Phase 6 dispatcher against in-memory fakes for
// the user / notification-log repositories + controllable
// `NotificationGateway` stand-ins (success, provider-failure,
// thrown-error). Coverage:
//
//   * Happy path on MOCK channel — inserts QUEUED row, SENT
//     update lands with the gateway's providerRef.
//   * Provider returns `status: 'FAILED'` — row is FAILED with
//     the result's errorMessage; dispatch returns normally.
//   * Provider throws `NotificationGatewayError` (e.g. SMS stub
//     "not configured") — row is FAILED with the error message;
//     dispatch returns normally; booking flow unaffected.
//   * Unknown templateKey → `UnknownTemplateKeyError`, no log
//     row written.
//   * Recipient not found → `NotificationRecipientNotFoundError`,
//     no log row written.
//   * No gateway for channel → `NoGatewayForChannelError`, no
//     log row written.
//   * Default channel is MOCK when caller doesn't specify one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
    NotificationChannel,
    NotificationGateway,
    NotificationSendInput,
    NotificationSendResult,
} from '../../shared/adapters/notifications/NotificationGateway.js';
import {
    NotificationGatewayError,
    NotificationProviderNotConfiguredError,
} from '../../shared/adapters/notifications/NotificationGateway.js';
import { MockNotificationGateway } from '../../shared/adapters/notifications/MockNotificationGateway.js';
import {
    NoGatewayForChannelError,
    NotificationRecipientNotFoundError,
    NotificationService,
} from '../../shared/domains/notifications/notificationService.js';
import { UnknownTemplateKeyError } from '../../shared/domains/notifications/templateRegistry.js';
import { createLogger } from '../../shared/logging/logger.js';

import { InMemoryNotificationLogRepository } from '../_fakes/InMemoryNotificationLogRepository.js';
import { InMemoryUserRepository } from '../_fakes/InMemoryUserRepository.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEMPLATE_KEY = 'booking.accepted.customer';

const PAYLOAD = Object.freeze({
    businessName: 'Habesha Beauty Lounge',
    serviceName: 'Hair braiding',
    customerDisplayName: 'Henok',
    startsAtUtc: '2026-05-15T11:00:00.000Z',
});

/**
 * Test-only gateway that produces whatever outcome the test asks
 * for: SENT result, FAILED result, or a thrown error.
 */
class ConfigurableGateway implements NotificationGateway {
    public readonly channel: NotificationChannel;
    public readonly provider: string;
    public lastInput: NotificationSendInput | null = null;
    public callCount = 0;

    constructor(
        channel: NotificationChannel,
        provider: string,
        private readonly behavior:
            | { kind: 'sent'; providerRef: string }
            | { kind: 'failed'; errorCode: string; errorMessage: string }
            | { kind: 'throws'; error: Error },
    ) {
        this.channel = channel;
        this.provider = provider;
    }

    async send(input: NotificationSendInput): Promise<NotificationSendResult> {
        this.lastInput = input;
        this.callCount += 1;
        if (this.behavior.kind === 'sent') {
            return Object.freeze<NotificationSendResult>({
                status: 'SENT',
                provider: this.provider,
                providerRef: this.behavior.providerRef,
                rawResponse: { ok: true },
                errorCode: null,
                errorMessage: null,
                sentAt: new Date().toISOString(),
            });
        }
        if (this.behavior.kind === 'failed') {
            return Object.freeze<NotificationSendResult>({
                status: 'FAILED',
                provider: this.provider,
                providerRef: null,
                rawResponse: null,
                errorCode: this.behavior.errorCode,
                errorMessage: this.behavior.errorMessage,
                sentAt: new Date().toISOString(),
            });
        }
        throw this.behavior.error;
    }
}

function silentLogger() {
    return createLogger({
        level: 'error',
        // Discard every line; tests don't care about log output.
        sink: { write: () => {} },
    });
}

async function seedUser(users: InMemoryUserRepository) {
    return users.upsertFromAuth({
        cognitoSub: 'sub-1',
        email: 'henok@example.com',
        phone: '+251911000001',
        role: 'CUSTOMER',
        displayName: 'Henok',
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationService — happy path', () => {
    it('uses the MOCK gateway by default and persists SENT', async () => {
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const mock = new MockNotificationGateway();
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            gateways: { MOCK: mock },
            logger: silentLogger(),
        });

        const recipient = await seedUser(users);

        const finalRow = await svc.dispatch({
            templateKey: TEMPLATE_KEY,
            recipientUserId: recipient.id,
            payload: { ...PAYLOAD },
            // channel intentionally omitted — default is MOCK
        });

        assert.strictEqual(finalRow.status, 'SENT');
        assert.strictEqual(finalRow.channel, 'MOCK');
        assert.strictEqual(finalRow.provider, 'MOCK');
        assert.ok(
            finalRow.providerRef !== null && finalRow.providerRef.startsWith('mock-'),
            `expected mock-<uuid> providerRef, got ${finalRow.providerRef}`,
        );
        assert.strictEqual(finalRow.errorMessage, null);

        // Exactly one log row, terminal in SENT.
        assert.strictEqual(logs.size(), 1);
        assert.strictEqual(logs.all()[0]!.id, finalRow.id);
    });

    it('passes the recipient routing fields to the gateway', async () => {
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const gw = new ConfigurableGateway('MOCK', 'MOCK', {
            kind: 'sent',
            providerRef: 'mock-deadbeef',
        });
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            gateways: { MOCK: gw },
            logger: silentLogger(),
        });

        const recipient = await seedUser(users);

        await svc.dispatch({
            templateKey: TEMPLATE_KEY,
            recipientUserId: recipient.id,
            payload: { ...PAYLOAD },
        });

        assert.ok(gw.lastInput);
        assert.strictEqual(gw.lastInput!.channel, 'MOCK');
        assert.strictEqual(gw.lastInput!.recipient.userId, recipient.id);
        assert.strictEqual(gw.lastInput!.recipient.phoneE164, '+251911000001');
        assert.strictEqual(gw.lastInput!.recipient.emailAddress, 'henok@example.com');
        assert.ok(gw.lastInput!.rendered.body.length > 0);
    });
});

describe('NotificationService — provider failures', () => {
    it('persists FAILED when the gateway returns status FAILED', async () => {
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const gw = new ConfigurableGateway('MOCK', 'MOCK', {
            kind: 'failed',
            errorCode: 'CARRIER_REJECTED',
            errorMessage: 'Number unreachable',
        });
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            gateways: { MOCK: gw },
            logger: silentLogger(),
        });
        const recipient = await seedUser(users);

        const row = await svc.dispatch({
            templateKey: TEMPLATE_KEY,
            recipientUserId: recipient.id,
            payload: { ...PAYLOAD },
        });

        assert.strictEqual(row.status, 'FAILED');
        assert.strictEqual(row.providerRef, null);
        assert.strictEqual(row.errorMessage, 'Number unreachable');
    });

    it('persists FAILED when the gateway throws NotificationGatewayError', async () => {
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const gw = new ConfigurableGateway('SMS', 'SMS_STUB', {
            kind: 'throws',
            error: new NotificationProviderNotConfiguredError(
                'SMS not configured',
            ),
        });
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            gateways: { SMS: gw },
            logger: silentLogger(),
        });
        const recipient = await seedUser(users);

        const row = await svc.dispatch({
            templateKey: TEMPLATE_KEY,
            recipientUserId: recipient.id,
            payload: { ...PAYLOAD },
            channel: 'SMS',
        });

        assert.strictEqual(row.status, 'FAILED');
        assert.strictEqual(row.channel, 'SMS');
        assert.strictEqual(row.errorMessage, 'SMS not configured');
        // Subclass is still a NotificationGatewayError — was caught,
        // not re-thrown.
        assert.ok(gw.callCount === 1);
    });

    it('re-throws unexpected (non-NotificationGatewayError) errors after marking FAILED', async () => {
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const gw = new ConfigurableGateway('MOCK', 'MOCK', {
            kind: 'throws',
            error: new TypeError('Boom — programmer error inside gateway'),
        });
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            gateways: { MOCK: gw },
            logger: silentLogger(),
        });
        const recipient = await seedUser(users);

        await assert.rejects(
            () =>
                svc.dispatch({
                    templateKey: TEMPLATE_KEY,
                    recipientUserId: recipient.id,
                    payload: { ...PAYLOAD },
                }),
            (err: unknown) => {
                assert.ok(err instanceof TypeError);
                return true;
            },
        );

        // Best-effort FAILED-mark still happens.
        assert.strictEqual(logs.size(), 1);
        const row = logs.all()[0]!;
        assert.strictEqual(row.status, 'FAILED');
        assert.match(row.errorMessage ?? '', /Boom/);
    });
});

describe('NotificationService — programming errors', () => {
    it('throws UnknownTemplateKeyError without writing a log row', async () => {
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const mock = new MockNotificationGateway();
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            gateways: { MOCK: mock },
            logger: silentLogger(),
        });
        const recipient = await seedUser(users);

        await assert.rejects(
            () =>
                svc.dispatch({
                    templateKey: 'booking.totally-bogus',
                    recipientUserId: recipient.id,
                    payload: { ...PAYLOAD },
                }),
            (err: unknown) => {
                assert.ok(err instanceof UnknownTemplateKeyError);
                return true;
            },
        );
        assert.strictEqual(logs.size(), 0);
    });

    it('throws NotificationRecipientNotFoundError without writing a log row', async () => {
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const mock = new MockNotificationGateway();
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            gateways: { MOCK: mock },
            logger: silentLogger(),
        });

        await assert.rejects(
            () =>
                svc.dispatch({
                    templateKey: TEMPLATE_KEY,
                    recipientUserId: '00000000-0000-0000-0000-000000000001',
                    payload: { ...PAYLOAD },
                }),
            (err: unknown) => {
                assert.ok(err instanceof NotificationRecipientNotFoundError);
                return true;
            },
        );
        assert.strictEqual(logs.size(), 0);
    });

    it('throws NoGatewayForChannelError without writing a log row', async () => {
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            // No gateways registered at all.
            gateways: {},
            logger: silentLogger(),
        });
        const recipient = await seedUser(users);

        await assert.rejects(
            () =>
                svc.dispatch({
                    templateKey: TEMPLATE_KEY,
                    recipientUserId: recipient.id,
                    payload: { ...PAYLOAD },
                }),
            (err: unknown) => {
                assert.ok(err instanceof NoGatewayForChannelError);
                assert.strictEqual(
                    (err as NoGatewayForChannelError).channel,
                    'MOCK',
                );
                return true;
            },
        );
        assert.strictEqual(logs.size(), 0);
    });

    it('does not swallow non-provider errors silently — exposes them to the caller', async () => {
        // Sanity check on the contract documented in the dispatcher
        // header: only NotificationGatewayError subclasses are
        // swallowed; everything else surfaces (we already covered
        // the TypeError case above — this is a quick redundant
        // assertion against a different error class).
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const gw = new ConfigurableGateway('MOCK', 'MOCK', {
            kind: 'throws',
            error: new RangeError('Out of range'),
        });
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            gateways: { MOCK: gw },
            logger: silentLogger(),
        });
        const recipient = await seedUser(users);

        await assert.rejects(
            () =>
                svc.dispatch({
                    templateKey: TEMPLATE_KEY,
                    recipientUserId: recipient.id,
                    payload: { ...PAYLOAD },
                }),
            (err) => err instanceof RangeError,
        );
    });
});

describe('NotificationService — sanity', () => {
    it('exposes NotificationGatewayError as the swallow superclass', () => {
        // Compile-time sanity: subclass relationship is what the
        // dispatcher relies on for its catch.
        assert.ok(
            new NotificationProviderNotConfiguredError('x') instanceof
                NotificationGatewayError,
        );
    });
});

describe('NotificationService — locale handling (Phase 9 Track 5)', () => {
    it('renders the English body for a default-locale (en) recipient', async () => {
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const gw = new ConfigurableGateway('MOCK', 'MOCK', {
            kind: 'sent',
            providerRef: 'mock-en',
        });
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            gateways: { MOCK: gw },
            logger: silentLogger(),
        });

        const recipient = await seedUser(users);
        // Sanity: fresh row defaults to 'en'.
        assert.strictEqual(recipient.locale, 'en');

        await svc.dispatch({
            templateKey: TEMPLATE_KEY,
            recipientUserId: recipient.id,
            payload: { ...PAYLOAD },
        });

        assert.ok(gw.lastInput);
        assert.match(gw.lastInput!.rendered.body, /accepted your/);
    });

    it('falls back to the English body for an am-locale recipient (MVP has no Amharic renderers yet)', async () => {
        const users = new InMemoryUserRepository();
        const logs = new InMemoryNotificationLogRepository();
        const gw = new ConfigurableGateway('MOCK', 'MOCK', {
            kind: 'sent',
            providerRef: 'mock-am',
        });
        const svc = new NotificationService({
            userRepository: users,
            notificationLogRepository: logs,
            gateways: { MOCK: gw },
            logger: silentLogger(),
        });

        const recipient = await seedUser(users);
        const switched = await users.setLocale(recipient.id, 'am');
        assert.strictEqual(switched.locale, 'am');

        await svc.dispatch({
            templateKey: TEMPLATE_KEY,
            recipientUserId: recipient.id,
            payload: { ...PAYLOAD },
        });

        // Same English text — registry fallback to 'en' is the
        // contract under test. When Amharic renderers ship, this
        // assertion will need updating to the Amharic copy.
        assert.ok(gw.lastInput);
        assert.match(gw.lastInput!.rendered.body, /accepted your/);
    });
});
