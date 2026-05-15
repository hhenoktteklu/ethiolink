// EthioLink — scheduled-reminder batch tests.
//
// Exercises `runReminderBatch` (the pure DI-driven core of the
// scheduled lambda) against in-memory fakes. Coverage:
//
//   * Happy path — one ACCEPTED appointment in the window fires
//     both reminder templates and returns
//     `{ scanned: 1, sent: 2, skipped: 0, failed: 0 }`.
//   * Idempotency — running the same scan twice fires the
//     second batch as skipped (2 skipped, 0 sent).
//   * Window boundaries — ACCEPTED rows outside [now+23h45m,
//     now+24h00m) are scanned as 0.
//   * Status filter — REQUESTED / CANCELLED / COMPLETED rows in
//     the window are NOT scanned.
//   * Missing business — orphan FK is counted as `failed: 2`
//     for the appointment, batch continues.
//   * Skip + send mix — a partially-reminded appointment skips
//     the already-sent template and fires the other.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { MockNotificationGateway } from '../../shared/adapters/notifications/MockNotificationGateway.js';
import type {
    NotificationChannel,
    NotificationGateway,
    NotificationSendInput,
    NotificationSendResult,
} from '../../shared/adapters/notifications/NotificationGateway.js';
import type {
    Appointment,
    AppointmentStatus,
    PaymentMethod,
} from '../../shared/domains/appointments/appointmentsRepository.js';
import { NotificationService } from '../../shared/domains/notifications/notificationService.js';
import { runReminderBatch } from '../../lambdas/scheduled/sendReminders.js';
import { createLogger } from '../../shared/logging/logger.js';

import { InMemoryAppointmentsRepository } from '../_fakes/InMemoryAppointmentsRepository.js';
import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';
import { InMemoryNotificationLogRepository } from '../_fakes/InMemoryNotificationLogRepository.js';
import { InMemoryServiceRepository } from '../_fakes/InMemoryServiceRepository.js';
import { InMemoryUserRepository } from '../_fakes/InMemoryUserRepository.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '22222222-2222-2222-2222-222222222222';
const BUSINESS_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SERVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const STAFF_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// Fixed "now" the tests pin the scan window against.
// Window is [now + 23h45m, now + 24h00m).
const NOW_ISO = '2026-05-14T10:00:00.000Z';
// Inside the 15-min slice: now + 23h50m.
const IN_WINDOW_ISO = '2026-05-15T09:50:00.000Z';
// Outside (too early — now + 23h30m).
const TOO_EARLY_ISO = '2026-05-15T09:30:00.000Z';
// Outside (too late — now + 24h01m).
const TOO_LATE_ISO = '2026-05-15T10:01:00.000Z';

function makeAppointment(overrides: Partial<Appointment> = {}): Appointment {
    const startsAt = new Date(IN_WINDOW_ISO);
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
    return Object.freeze({
        id: randomUUID(),
        customerId: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        serviceId: SERVICE_ID,
        staffId: STAFF_ID,
        startsAt,
        endsAt,
        status: 'ACCEPTED' as AppointmentStatus,
        paymentMethod: 'CASH' as PaymentMethod,
        priceEtb: 300,
        notes: null,
        cancelledBy: null,
        cancelReason: null,
        createdAt: new Date('2026-05-14T00:00:00.000Z'),
        updatedAt: new Date('2026-05-14T00:00:00.000Z'),
        deletedAt: null,
        ...overrides,
    });
}

interface Env {
    readonly appointmentsRepo: InMemoryAppointmentsRepository;
    readonly businessRepo: InMemoryBusinessRepository;
    readonly serviceRepo: InMemoryServiceRepository;
    readonly userRepo: InMemoryUserRepository;
    readonly notificationLogRepo: InMemoryNotificationLogRepository;
    readonly notificationService: NotificationService;
    readonly smsRoutingEnabled: boolean;
    readonly smsGateway: StubChannelGateway;
}

interface BuildEnvOptions {
    /**
     * Phase 9 — when `true`, the dispatcher gets a stub SMS
     * gateway and `runReminderBatch` is called with
     * `smsRoutingEnabled: true`. Defaults to `false` so existing
     * tests stay on the mock-only path.
     */
    readonly smsRoutingEnabled?: boolean;
    /** Override the seeded customer's phone. `null` simulates no-phone-on-file. */
    readonly customerPhone?: string | null;
    /** Override the seeded business owner's phone. */
    readonly ownerPhone?: string | null;
}

/**
 * Phase 9 — recording stub gateway. Same shape as the appointment
 * service tests' `StubChannelGateway`. Always succeeds; captures
 * each `send` so tests can confirm SMS routing fired (or didn't).
 */
class StubChannelGateway implements NotificationGateway {
    public readonly calls: NotificationSendInput[] = [];

    constructor(
        public readonly channel: NotificationChannel,
        public readonly provider: string,
    ) {}

    async send(input: NotificationSendInput): Promise<NotificationSendResult> {
        this.calls.push(input);
        return Object.freeze({
            status: 'SENT' as const,
            provider: this.provider,
            providerRef: `${this.provider}-stub-${this.calls.length}`,
            rawResponse: null,
            errorCode: null,
            errorMessage: null,
            sentAt: new Date().toISOString(),
        });
    }
}

function buildEnv(options: BuildEnvOptions = {}): Env {
    const appointmentsRepo = new InMemoryAppointmentsRepository();
    const businessRepo = new InMemoryBusinessRepository();
    const serviceRepo = new InMemoryServiceRepository();
    const userRepo = new InMemoryUserRepository();
    const notificationLogRepo = new InMemoryNotificationLogRepository();

    businessRepo.seed({
        id: BUSINESS_ID,
        ownerUserId: OWNER_ID,
        categoryId: '00000000-0000-0000-0000-000000000001',
        name: 'Test Salon',
        description: { en: 'A test salon.' },
        city: 'Addis Ababa',
        addressLine: null,
        latitude: null,
        longitude: null,
        phone: null,
        telegramHandle: null,
        whatsappPhone: null,
        status: 'APPROVED',
        featuredUntil: null,
        ratingAvg: 0,
        ratingCount: 0,
        createdAt: new Date('2026-05-13T00:00:00.000Z'),
        updatedAt: new Date('2026-05-13T00:00:00.000Z'),
    });

    serviceRepo.seed({
        id: SERVICE_ID,
        businessId: BUSINESS_ID,
        name: { en: 'Haircut' },
        description: { en: 'Standard haircut.' },
        durationMinutes: 60,
        priceEtb: 300,
        isActive: true,
        createdAt: new Date('2026-05-13T00:00:00.000Z'),
        updatedAt: new Date('2026-05-13T00:00:00.000Z'),
    });

    seedUserById(userRepo, CUSTOMER_ID, 'CUSTOMER', 'Henok', options.customerPhone);
    seedUserById(userRepo, OWNER_ID, 'BUSINESS_OWNER', 'Owner', options.ownerPhone);

    const logger = createLogger({
        level: 'error',
        sink: { write: () => {} },
    });

    const smsGateway = new StubChannelGateway('SMS', 'STUB_SMS');
    const gateways = options.smsRoutingEnabled
        ? { MOCK: new MockNotificationGateway(), SMS: smsGateway }
        : { MOCK: new MockNotificationGateway() };

    const notificationService = new NotificationService({
        userRepository: userRepo,
        notificationLogRepository: notificationLogRepo,
        gateways,
        logger,
    });

    return {
        appointmentsRepo,
        businessRepo,
        serviceRepo,
        userRepo,
        notificationLogRepo,
        notificationService,
        smsRoutingEnabled: options.smsRoutingEnabled ?? false,
        smsGateway,
    };
}

function seedUserById(
    userRepo: InMemoryUserRepository,
    id: string,
    role: 'CUSTOMER' | 'BUSINESS_OWNER' | 'ADMIN',
    displayName: string,
    phoneOverride?: string | null,
): void {
    const internal = userRepo as unknown as {
        rowsById: Map<string, unknown>;
        rowsBySub: Map<string, unknown>;
    };
    const now = new Date();
    const phone =
        phoneOverride === undefined
            ? `+25191100${id.slice(-4)}`
            : phoneOverride;
    const row = Object.freeze({
        id,
        cognitoSub: `sub-${id}`,
        email: `${displayName.toLowerCase()}@example.com`,
        phone,
        role,
        status: 'ACTIVE' as const,
        displayName,
        createdAt: now,
        updatedAt: now,
    });
    internal.rowsById.set(id, row);
    internal.rowsBySub.set(`sub-${id}`, row);
}

function silentLogger() {
    return createLogger({
        level: 'error',
        sink: { write: () => {} },
    });
}

async function runBatch(env: Env) {
    return runReminderBatch({
        appointmentsRepo: env.appointmentsRepo,
        businessRepo: env.businessRepo,
        serviceRepo: env.serviceRepo,
        userRepo: env.userRepo,
        notificationService: env.notificationService,
        notificationLogRepo: env.notificationLogRepo,
        logger: silentLogger(),
        now: () => new Date(NOW_ISO),
        smsRoutingEnabled: env.smsRoutingEnabled,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runReminderBatch — happy path', () => {
    it('fires both reminder templates for one in-window appointment', async () => {
        const env = buildEnv();
        env.appointmentsRepo.seedAppointment(makeAppointment());

        const summary = await runBatch(env);

        assert.deepStrictEqual(summary, {
            scanned: 1,
            sent: 2,
            skipped: 0,
            failed: 0,
        });

        const logs = env.notificationLogRepo.all();
        assert.strictEqual(logs.length, 2);
        const templateKeys = logs.map((l) => l.templateKey).sort();
        assert.deepStrictEqual(templateKeys, [
            'booking.reminder.business',
            'booking.reminder.customer',
        ]);

        const customerLog = logs.find(
            (l) => l.templateKey === 'booking.reminder.customer',
        )!;
        const businessLog = logs.find(
            (l) => l.templateKey === 'booking.reminder.business',
        )!;
        assert.strictEqual(customerLog.recipientUserId, CUSTOMER_ID);
        assert.strictEqual(businessLog.recipientUserId, OWNER_ID);
        assert.strictEqual(customerLog.status, 'SENT');
        assert.strictEqual(businessLog.status, 'SENT');
    });
});

describe('runReminderBatch — idempotency', () => {
    it('skips both reminders on a second scan over the same window', async () => {
        const env = buildEnv();
        env.appointmentsRepo.seedAppointment(makeAppointment());

        const first = await runBatch(env);
        assert.strictEqual(first.sent, 2);
        assert.strictEqual(first.skipped, 0);

        const second = await runBatch(env);
        assert.deepStrictEqual(second, {
            scanned: 1,
            sent: 0,
            skipped: 2,
            failed: 0,
        });

        // Ledger unchanged — no duplicate rows.
        assert.strictEqual(env.notificationLogRepo.size(), 2);
    });
});

describe('runReminderBatch — window boundaries', () => {
    it('does not scan rows starting before the window', async () => {
        const env = buildEnv();
        env.appointmentsRepo.seedAppointment(
            makeAppointment({
                startsAt: new Date(TOO_EARLY_ISO),
                endsAt: new Date(
                    new Date(TOO_EARLY_ISO).getTime() + 60 * 60_000,
                ),
            }),
        );

        const summary = await runBatch(env);
        assert.deepStrictEqual(summary, {
            scanned: 0,
            sent: 0,
            skipped: 0,
            failed: 0,
        });
    });

    it('does not scan rows starting after the window', async () => {
        const env = buildEnv();
        env.appointmentsRepo.seedAppointment(
            makeAppointment({
                startsAt: new Date(TOO_LATE_ISO),
                endsAt: new Date(
                    new Date(TOO_LATE_ISO).getTime() + 60 * 60_000,
                ),
            }),
        );

        const summary = await runBatch(env);
        assert.deepStrictEqual(summary, {
            scanned: 0,
            sent: 0,
            skipped: 0,
            failed: 0,
        });
    });
});

describe('runReminderBatch — status filter', () => {
    it('ignores REQUESTED / CANCELLED / COMPLETED appointments in the window', async () => {
        const env = buildEnv();
        env.appointmentsRepo.seedAppointment(
            makeAppointment({ status: 'REQUESTED' }),
        );
        env.appointmentsRepo.seedAppointment(
            makeAppointment({ status: 'CANCELLED' }),
        );
        env.appointmentsRepo.seedAppointment(
            makeAppointment({ status: 'COMPLETED' }),
        );

        const summary = await runBatch(env);
        assert.strictEqual(summary.scanned, 0);
        assert.strictEqual(summary.sent, 0);
    });
});

describe('runReminderBatch — orphan business', () => {
    it('counts both reminders as failed when the business is missing', async () => {
        const env = buildEnv();
        env.appointmentsRepo.seedAppointment(
            makeAppointment({
                businessId: '99999999-9999-9999-9999-999999999999',
            }),
        );

        const summary = await runBatch(env);
        assert.deepStrictEqual(summary, {
            scanned: 1,
            sent: 0,
            skipped: 0,
            failed: 2,
        });
        // No log row was written because the dispatcher was never called.
        assert.strictEqual(env.notificationLogRepo.size(), 0);
    });
});

describe('runReminderBatch — partial pre-existing ledger', () => {
    it('skips an already-reminded template and fires the other one', async () => {
        const env = buildEnv();
        const appt = makeAppointment();
        env.appointmentsRepo.seedAppointment(appt);

        // Pre-seed a customer-reminder log row to simulate a
        // previous run that successfully reminded the customer
        // but not the business owner.
        await env.notificationLogRepo.insert({
            recipientUserId: CUSTOMER_ID,
            channel: 'MOCK',
            templateKey: 'booking.reminder.customer',
            payload: {
                businessName: 'Test Salon',
                serviceName: 'Haircut',
                customerDisplayName: 'Henok',
                startsAtUtc: appt.startsAt.toISOString(),
            },
            provider: 'MOCK',
        });

        const summary = await runBatch(env);
        assert.deepStrictEqual(summary, {
            scanned: 1,
            sent: 1,
            skipped: 1,
            failed: 0,
        });
    });
});

// ---------------------------------------------------------------------------
// Phase 9 — SMS routing for scheduled reminders
// ---------------------------------------------------------------------------
//
// Mirrors the appointment-service SMS routing tests. Coverage:
//
//   * Mock provider keeps both reminders on `MOCK`.
//   * SMS provider + both recipients with a phone → both
//     reminders route through `SMS`.
//   * SMS provider + recipients with no phone → both reminders
//     fall back to `MOCK`. The SMS gateway stays untouched.
//   * Dispatch failure with SMS routing wired — the failing
//     reminder is counted, the batch keeps running, and the
//     summary surfaces the failure without throwing.

describe('runReminderBatch — SMS routing (Phase 9)', () => {
    it('mock provider keeps both reminders on MOCK', async () => {
        const env = buildEnv(); // smsRoutingEnabled defaults to false
        env.appointmentsRepo.seedAppointment(makeAppointment());

        const summary = await runBatch(env);

        assert.strictEqual(summary.sent, 2);
        const channels = env.notificationLogRepo
            .all()
            .map((r) => r.channel)
            .sort();
        assert.deepStrictEqual(channels, ['MOCK', 'MOCK']);
        assert.strictEqual(env.smsGateway.calls.length, 0);
    });

    it('sms provider + customer & business phone routes both reminders through SMS', async () => {
        const env = buildEnv({ smsRoutingEnabled: true });
        env.appointmentsRepo.seedAppointment(makeAppointment());

        const summary = await runBatch(env);

        assert.strictEqual(summary.sent, 2);
        const channels = env.notificationLogRepo
            .all()
            .map((r) => r.channel)
            .sort();
        assert.deepStrictEqual(channels, ['SMS', 'SMS']);

        // Stub gateway captured both sends with phone numbers.
        assert.strictEqual(env.smsGateway.calls.length, 2);
        const phones = env.smsGateway.calls
            .map((c) => c.recipient.phoneE164)
            .sort();
        assert.deepStrictEqual(phones, [
            `+25191100${CUSTOMER_ID.slice(-4)}`,
            `+25191100${OWNER_ID.slice(-4)}`,
        ]);
    });

    it('sms provider + missing phone falls back to MOCK', async () => {
        const env = buildEnv({
            smsRoutingEnabled: true,
            customerPhone: null,
            ownerPhone: null,
        });
        env.appointmentsRepo.seedAppointment(makeAppointment());

        const summary = await runBatch(env);

        assert.strictEqual(summary.sent, 2);
        const channels = env.notificationLogRepo
            .all()
            .map((r) => r.channel)
            .sort();
        assert.deepStrictEqual(
            channels,
            ['MOCK', 'MOCK'],
            'expected fallback to MOCK when neither recipient has a phone',
        );
        assert.strictEqual(env.smsGateway.calls.length, 0);
    });

    it('dispatch failure with SMS routing wired does not fail the whole batch', async () => {
        // SMS routing enabled, but wipe the owner row so the
        // dispatcher throws `NotificationRecipientNotFoundError`
        // on the business-side reminder. The customer-side
        // reminder still lands; the batch summary reports
        // exactly one failure.
        const env = buildEnv({ smsRoutingEnabled: true });
        env.appointmentsRepo.seedAppointment(makeAppointment());

        const internal = env.userRepo as unknown as {
            rowsById: Map<string, unknown>;
        };
        internal.rowsById.delete(OWNER_ID);

        const summary = await runBatch(env);

        assert.strictEqual(summary.scanned, 1);
        assert.strictEqual(summary.sent, 1);
        assert.strictEqual(summary.skipped, 0);
        assert.strictEqual(summary.failed, 1);

        // The customer-side reminder reached the SMS gateway.
        assert.strictEqual(env.smsGateway.calls.length, 1);
        assert.strictEqual(
            env.smsGateway.calls[0]!.recipient.phoneE164,
            `+25191100${CUSTOMER_ID.slice(-4)}`,
        );
        // Only one log row survived; the failing dispatch threw
        // before any row was inserted for the business-side
        // reminder (the dispatcher's recipient lookup raises
        // before the QUEUED insert).
        const logs = env.notificationLogRepo.all();
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]!.recipientUserId, CUSTOMER_ID);
        assert.strictEqual(logs[0]!.channel, 'SMS');
    });
});
