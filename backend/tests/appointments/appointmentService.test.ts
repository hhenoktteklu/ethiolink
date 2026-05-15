// EthioLink — AppointmentService unit tests.
//
// Exercises the Phase 4 booking-flow orchestrator against in-memory
// fakes for the repository layer + real `CashGateway` /
// `MockOnlineGateway` instances. The slot service is stubbed via a
// type cast — its job is well-covered by the slot-computer /
// slot-service test suites, and the appointment service only cares
// that the returned slot list contains (or doesn't contain) the
// requested instant.
//
// Coverage matches the test plan in PHASE_4_BOOKING.md:
//   * cash create → REQUESTED row + SUCCEEDED payment
//   * online create → OnlinePaymentsUnavailableError (no row written)
//   * misaligned start → AppointmentSlotUnavailableError
//   * concurrent race / 23P01 → AppointmentSlotUnavailableError
//   * accept / reject / complete state machine + ownership
//   * cancel cutoff: customer before, customer after, admin override
//   * reschedule resets ACCEPTED → REQUESTED
//   * invalid state-machine transitions surface as
//     `InvalidAppointmentTransitionError`
//   * non-owner / wrong-business callers get
//     `AppointmentNotOwnedError`

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { CashGateway } from '../../shared/adapters/payments/CashGateway.js';
import { MockOnlineGateway } from '../../shared/adapters/payments/MockOnlineGateway.js';
import { MockNotificationGateway } from '../../shared/adapters/notifications/MockNotificationGateway.js';
import type {
    Appointment,
    AppointmentStatus,
    PaymentMethod,
} from '../../shared/domains/appointments/appointmentsRepository.js';
import {
    AppointmentCancellationCutoffError,
    AppointmentNotFoundError,
    AppointmentNotOwnedError,
    AppointmentService,
    AppointmentSlotUnavailableError,
    InvalidAppointmentTransitionError,
    OnlinePaymentsUnavailableError,
    type CallerContext,
} from '../../shared/domains/appointments/appointmentService.js';
import type { Slot, SlotService } from '../../shared/domains/availability/slotService.js';
import type { Business } from '../../shared/domains/businesses/businessRepository.js';
import { NotificationService } from '../../shared/domains/notifications/notificationService.js';
import type { Service } from '../../shared/domains/services/serviceRepository.js';
import { createLogger } from '../../shared/logging/logger.js';

import { InMemoryAppointmentsRepository } from '../_fakes/InMemoryAppointmentsRepository.js';
import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';
import { InMemoryNotificationLogRepository } from '../_fakes/InMemoryNotificationLogRepository.js';
import { InMemoryServiceRepository } from '../_fakes/InMemoryServiceRepository.js';
import { InMemoryUserRepository } from '../_fakes/InMemoryUserRepository.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = '22222222-2222-2222-2222-222222222222';
const ADMIN_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_ID = '44444444-4444-4444-4444-444444444444';

const BUSINESS_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SERVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const STAFF_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const ADDIS_TZ = 'Africa/Addis_Ababa';

// 09:00 Addis on 2026-05-15 → 06:00 UTC. Whole-hour slot the tests
// reference as the "valid" booking time.
const STARTS_AT_ISO = '2026-05-15T06:00:00.000Z';
const ENDS_AT_ISO = '2026-05-15T07:00:00.000Z';

const DEFAULT_CUTOFF_MINUTES = 240;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function caller(userId: string, role: CallerContext['role']): CallerContext {
    return { userId, role };
}

function makeBusiness(overrides: Partial<Business> = {}): Business {
    const now = new Date('2026-05-14T00:00:00.000Z');
    return Object.freeze({
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
        status: 'APPROVED' as const,
        featuredUntil: null,
        ratingAvg: 0,
        ratingCount: 0,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    });
}

function makeService(overrides: Partial<Service> = {}): Service {
    const now = new Date('2026-05-14T00:00:00.000Z');
    return Object.freeze({
        id: SERVICE_ID,
        businessId: BUSINESS_ID,
        name: { en: 'Haircut' },
        description: { en: 'Standard haircut.' },
        durationMinutes: 60,
        priceEtb: 300,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    });
}

function makeAppointment(overrides: Partial<Appointment> = {}): Appointment {
    const startsAt = overrides.startsAt ?? new Date(STARTS_AT_ISO);
    const endsAt = overrides.endsAt ?? new Date(ENDS_AT_ISO);
    const now = new Date('2026-05-14T00:00:00.000Z');
    return Object.freeze({
        id: randomUUID(),
        customerId: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        serviceId: SERVICE_ID,
        staffId: STAFF_ID,
        startsAt,
        endsAt,
        status: 'REQUESTED' as AppointmentStatus,
        paymentMethod: 'CASH' as PaymentMethod,
        priceEtb: 300,
        notes: null,
        cancelledBy: null,
        cancelReason: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        ...overrides,
    });
}

/**
 * Build a `SlotService`-shaped stub returning the supplied slots from
 * `computeSlots`. The class has `private` fields so a plain object
 * isn't structurally assignable; the `as unknown as SlotService` cast
 * is the standard escape hatch and keeps this test focused on
 * appointment-service logic rather than slot computation.
 */
function makeSlotService(slots: readonly Slot[]): SlotService {
    return {
        computeSlots: async () => slots,
    } as unknown as SlotService;
}

interface Env {
    readonly service: AppointmentService;
    readonly apptRepo: InMemoryAppointmentsRepository;
    readonly businessRepo: InMemoryBusinessRepository;
    readonly serviceRepo: InMemoryServiceRepository;
    readonly userRepo: InMemoryUserRepository;
    readonly notificationLogRepo: InMemoryNotificationLogRepository;
}

interface EnvOptions {
    readonly slots?: readonly Slot[];
    readonly cancelCutoffMinutes?: number;
}

function buildEnv(options: EnvOptions = {}): Env {
    const apptRepo = new InMemoryAppointmentsRepository();
    const businessRepo = new InMemoryBusinessRepository();
    const serviceRepo = new InMemoryServiceRepository();
    const userRepo = new InMemoryUserRepository();
    const notificationLogRepo = new InMemoryNotificationLogRepository();

    businessRepo.seed(makeBusiness());
    serviceRepo.seed(makeService());

    // Seed the customer + owner so the notification dispatcher can
    // resolve recipients. `upsertFromAuth` is the only public write
    // path on the in-memory fake; we patch the id back on through a
    // private cast so the seeded users match the constants the rest
    // of the suite expects.
    seedUser(userRepo, CUSTOMER_ID, 'CUSTOMER', 'Henok');
    seedUser(userRepo, OWNER_ID, 'BUSINESS_OWNER', 'Owner');

    const slots = options.slots ?? [
        Object.freeze<Slot>({ startUtc: STARTS_AT_ISO, endUtc: ENDS_AT_ISO }),
    ];

    const logger = createLogger({
        level: 'error',
        sink: { write: () => {} },
    });

    const notificationService = new NotificationService({
        userRepository: userRepo,
        notificationLogRepository: notificationLogRepo,
        gateways: { MOCK: new MockNotificationGateway() },
        logger,
    });

    const service = new AppointmentService({
        appointmentsRepo: apptRepo,
        businessRepo,
        serviceRepo,
        userRepo,
        slotService: makeSlotService(slots),
        cashGateway: new CashGateway(),
        onlineGateway: new MockOnlineGateway(),
        notificationService,
        logger,
        options: {
            cancelCutoffMinutes:
                options.cancelCutoffMinutes ?? DEFAULT_CUTOFF_MINUTES,
            timezone: ADDIS_TZ,
        },
    });

    return { service, apptRepo, businessRepo, serviceRepo, userRepo, notificationLogRepo };
}

/**
 * Seed a user with a known id. The in-memory `upsertFromAuth`
 * assigns a fresh UUID; we overwrite via the internal Map so the
 * appointment-service test can keep referencing the fixed
 * CUSTOMER_ID / OWNER_ID constants.
 */
function seedUser(
    userRepo: InMemoryUserRepository,
    id: string,
    role: 'CUSTOMER' | 'BUSINESS_OWNER' | 'ADMIN',
    displayName: string,
): void {
    const internal = userRepo as unknown as {
        rowsById: Map<string, unknown>;
        rowsBySub: Map<string, unknown>;
    };
    const now = new Date();
    const row = Object.freeze({
        id,
        cognitoSub: `sub-${id}`,
        email: `${displayName.toLowerCase()}@example.com`,
        phone: `+25191100${id.slice(-4)}`,
        role,
        status: 'ACTIVE' as const,
        displayName,
        createdAt: now,
        updatedAt: now,
    });
    internal.rowsById.set(id, row);
    internal.rowsBySub.set(`sub-${id}`, row);
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe('AppointmentService.create — cash flow', () => {
    it('books a slot, snapshots price, and returns SUCCEEDED cash payment', async () => {
        const env = buildEnv();
        const result = await env.service.create({
            customerId: CUSTOMER_ID,
            staffId: STAFF_ID,
            serviceId: SERVICE_ID,
            startsAtUtc: STARTS_AT_ISO,
            paymentMethod: 'CASH',
        });

        assert.strictEqual(result.appointment.status, 'REQUESTED');
        assert.strictEqual(result.appointment.customerId, CUSTOMER_ID);
        assert.strictEqual(result.appointment.businessId, BUSINESS_ID);
        assert.strictEqual(result.appointment.staffId, STAFF_ID);
        assert.strictEqual(result.appointment.priceEtb, 300);
        assert.strictEqual(
            result.appointment.startsAt.toISOString(),
            STARTS_AT_ISO,
        );
        assert.strictEqual(result.appointment.endsAt.toISOString(), ENDS_AT_ISO);

        assert.strictEqual(result.payment.status, 'SUCCEEDED');
        assert.strictEqual(result.payment.provider, 'CASH');
        assert.strictEqual(env.apptRepo.size(), 1);
    });
});

describe('AppointmentService.create — online flow', () => {
    it('throws OnlinePaymentsUnavailableError and writes no row', async () => {
        const env = buildEnv();
        await assert.rejects(
            () =>
                env.service.create({
                    customerId: CUSTOMER_ID,
                    staffId: STAFF_ID,
                    serviceId: SERVICE_ID,
                    startsAtUtc: STARTS_AT_ISO,
                    paymentMethod: 'ONLINE_PENDING',
                }),
            OnlinePaymentsUnavailableError,
        );
        assert.strictEqual(env.apptRepo.size(), 0);
    });
});

describe('AppointmentService.create — slot unavailable', () => {
    it('refuses a startsAt that does not appear in the computed slot list', async () => {
        const env = buildEnv();
        await assert.rejects(
            () =>
                env.service.create({
                    customerId: CUSTOMER_ID,
                    staffId: STAFF_ID,
                    serviceId: SERVICE_ID,
                    // 09:07 Addis = 06:07 UTC — not in the {06:00 UTC} slot list.
                    startsAtUtc: '2026-05-15T06:07:00.000Z',
                    paymentMethod: 'CASH',
                }),
            AppointmentSlotUnavailableError,
        );
        assert.strictEqual(env.apptRepo.size(), 0);
    });

    it('translates SQLSTATE 23P01 from a race-loss insert', async () => {
        const env = buildEnv();
        env.apptRepo.failNextInsertWithExclusion();

        await assert.rejects(
            () =>
                env.service.create({
                    customerId: CUSTOMER_ID,
                    staffId: STAFF_ID,
                    serviceId: SERVICE_ID,
                    startsAtUtc: STARTS_AT_ISO,
                    paymentMethod: 'CASH',
                }),
            AppointmentSlotUnavailableError,
        );
        // The pre-flight payment authorize succeeded (cash is a no-op),
        // but no row landed.
        assert.strictEqual(env.apptRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// accept / reject / complete — business-only transitions
// ---------------------------------------------------------------------------

describe('AppointmentService.accept', () => {
    it('moves REQUESTED → ACCEPTED for the business owner', async () => {
        const env = buildEnv();
        const seeded = makeAppointment({ status: 'REQUESTED' });
        env.apptRepo.seedAppointment(seeded);

        const updated = await env.service.accept(seeded.id, caller(OWNER_ID, 'BUSINESS_OWNER'));
        assert.strictEqual(updated.status, 'ACCEPTED');
        assert.strictEqual(updated.cancelledBy, null);
    });

    it('refuses ACCEPTED → ACCEPTED with InvalidAppointmentTransitionError', async () => {
        const env = buildEnv();
        const seeded = makeAppointment({ status: 'ACCEPTED' });
        env.apptRepo.seedAppointment(seeded);

        await assert.rejects(
            () => env.service.accept(seeded.id, caller(OWNER_ID, 'BUSINESS_OWNER')),
            InvalidAppointmentTransitionError,
        );
    });

    it('refuses a stranger (not owner, not admin) with AppointmentNotOwnedError', async () => {
        const env = buildEnv();
        const seeded = makeAppointment({ status: 'REQUESTED' });
        env.apptRepo.seedAppointment(seeded);

        await assert.rejects(
            () => env.service.accept(seeded.id, caller(OTHER_ID, 'BUSINESS_OWNER')),
            AppointmentNotOwnedError,
        );
    });

    it('returns 404 when the appointment is missing', async () => {
        const env = buildEnv();
        await assert.rejects(
            () =>
                env.service.accept(
                    '00000000-0000-0000-0000-00000000dead',
                    caller(OWNER_ID, 'BUSINESS_OWNER'),
                ),
            AppointmentNotFoundError,
        );
    });
});

describe('AppointmentService.reject', () => {
    it('moves REQUESTED → REJECTED for the business owner', async () => {
        const env = buildEnv();
        const seeded = makeAppointment({ status: 'REQUESTED' });
        env.apptRepo.seedAppointment(seeded);

        const updated = await env.service.reject(seeded.id, caller(OWNER_ID, 'BUSINESS_OWNER'));
        assert.strictEqual(updated.status, 'REJECTED');
    });
});

describe('AppointmentService.complete', () => {
    it('moves ACCEPTED → COMPLETED for the business owner', async () => {
        const env = buildEnv();
        const seeded = makeAppointment({ status: 'ACCEPTED' });
        env.apptRepo.seedAppointment(seeded);

        const updated = await env.service.complete(seeded.id, caller(OWNER_ID, 'BUSINESS_OWNER'));
        assert.strictEqual(updated.status, 'COMPLETED');
    });

    it('refuses REQUESTED → COMPLETED with InvalidAppointmentTransitionError', async () => {
        const env = buildEnv();
        const seeded = makeAppointment({ status: 'REQUESTED' });
        env.apptRepo.seedAppointment(seeded);

        await assert.rejects(
            () => env.service.complete(seeded.id, caller(OWNER_ID, 'BUSINESS_OWNER')),
            InvalidAppointmentTransitionError,
        );
    });
});

// ---------------------------------------------------------------------------
// cancel() — cutoff is the load-bearing rule
// ---------------------------------------------------------------------------

describe('AppointmentService.cancel — customer with cutoff', () => {
    it('allows a customer cancel comfortably before the cutoff', async () => {
        const env = buildEnv();
        const startsAt = new Date('2026-05-15T12:00:00.000Z');
        const seeded = makeAppointment({
            status: 'ACCEPTED',
            startsAt,
            endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        });
        env.apptRepo.seedAppointment(seeded);

        // now = startsAt - 6h, cutoff = 240min (4h) → 6h ≥ 4h ⇒ allowed.
        const now = new Date(startsAt.getTime() - 6 * 60 * 60_000);
        const updated = await env.service.cancel(
            seeded.id,
            caller(CUSTOMER_ID, 'CUSTOMER'),
            { reason: 'change of plans', now },
        );

        assert.strictEqual(updated.status, 'CANCELLED');
        assert.strictEqual(updated.cancelledBy, 'CUSTOMER');
        assert.strictEqual(updated.cancelReason, 'change of plans');
    });

    it('refuses a customer cancel inside the cutoff window', async () => {
        const env = buildEnv();
        const startsAt = new Date('2026-05-15T12:00:00.000Z');
        const seeded = makeAppointment({
            status: 'ACCEPTED',
            startsAt,
            endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        });
        env.apptRepo.seedAppointment(seeded);

        // now = startsAt - 2h ⇒ inside the 4h cutoff.
        const now = new Date(startsAt.getTime() - 2 * 60 * 60_000);
        await assert.rejects(
            () =>
                env.service.cancel(
                    seeded.id,
                    caller(CUSTOMER_ID, 'CUSTOMER'),
                    { now },
                ),
            (err: unknown) => {
                assert.ok(err instanceof AppointmentCancellationCutoffError);
                assert.strictEqual(err.cutoffMinutes, DEFAULT_CUTOFF_MINUTES);
                return true;
            },
        );
    });
});

describe('AppointmentService.cancel — admin override', () => {
    it('admin cancellation skips the cutoff and stamps cancelledBy=ADMIN', async () => {
        const env = buildEnv();
        const startsAt = new Date('2026-05-15T12:00:00.000Z');
        const seeded = makeAppointment({
            status: 'ACCEPTED',
            startsAt,
            endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        });
        env.apptRepo.seedAppointment(seeded);

        // 30 minutes before startsAt — well inside the 240-minute cutoff.
        const now = new Date(startsAt.getTime() - 30 * 60_000);
        const updated = await env.service.cancel(
            seeded.id,
            caller(ADMIN_ID, 'ADMIN'),
            { now },
        );

        assert.strictEqual(updated.status, 'CANCELLED');
        assert.strictEqual(updated.cancelledBy, 'ADMIN');
    });
});

// ---------------------------------------------------------------------------
// reschedule() — RESCHEDULE is CUSTOMER-only per the state machine
// ---------------------------------------------------------------------------

describe('AppointmentService.reschedule', () => {
    it('resets an ACCEPTED appointment to REQUESTED on a successful move', async () => {
        const newStarts = '2026-05-16T07:00:00.000Z';
        const newEnds = '2026-05-16T08:00:00.000Z';
        const env = buildEnv({
            slots: [Object.freeze<Slot>({ startUtc: newStarts, endUtc: newEnds })],
        });

        const seeded = makeAppointment({ status: 'ACCEPTED' });
        env.apptRepo.seedAppointment(seeded);

        const updated = await env.service.reschedule(
            seeded.id,
            caller(CUSTOMER_ID, 'CUSTOMER'),
            { newStartsAtUtc: newStarts },
        );

        assert.strictEqual(updated.status, 'REQUESTED');
        assert.strictEqual(updated.startsAt.toISOString(), newStarts);
        assert.strictEqual(updated.endsAt.toISOString(), newEnds);
    });

    it('refuses a business-owner reschedule via the state machine', async () => {
        const env = buildEnv();
        const seeded = makeAppointment({ status: 'ACCEPTED' });
        env.apptRepo.seedAppointment(seeded);

        await assert.rejects(
            () =>
                env.service.reschedule(
                    seeded.id,
                    caller(OWNER_ID, 'BUSINESS_OWNER'),
                    { newStartsAtUtc: STARTS_AT_ISO },
                ),
            InvalidAppointmentTransitionError,
        );
    });
});

// ---------------------------------------------------------------------------
// Booking lifecycle notifications
// ---------------------------------------------------------------------------
//
// Focused coverage of the Phase 6 fan-out: each mutation should
// leave exactly one `notification_logs` row, with the right
// template key, recipient, and SENT status (the mock gateway
// always succeeds). `complete` produces no notification — that's
// asserted too.

describe('AppointmentService — booking lifecycle notifications', () => {
    it('create fires booking.requested.business to the business owner', async () => {
        const env = buildEnv();
        await env.service.create({
            customerId: CUSTOMER_ID,
            staffId: STAFF_ID,
            serviceId: SERVICE_ID,
            startsAtUtc: STARTS_AT_ISO,
            paymentMethod: 'CASH',
        });

        const logs = env.notificationLogRepo.all();
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]!.templateKey, 'booking.requested.business');
        assert.strictEqual(logs[0]!.recipientUserId, OWNER_ID);
        assert.strictEqual(logs[0]!.status, 'SENT');
        assert.strictEqual(logs[0]!.channel, 'MOCK');
    });

    it('accept fires booking.accepted.customer to the customer', async () => {
        const env = buildEnv();
        const seeded = makeAppointment();
        env.apptRepo.seedAppointment(seeded);

        await env.service.accept(seeded.id, caller(OWNER_ID, 'BUSINESS_OWNER'));

        const logs = env.notificationLogRepo.all();
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]!.templateKey, 'booking.accepted.customer');
        assert.strictEqual(logs[0]!.recipientUserId, CUSTOMER_ID);
        assert.strictEqual(logs[0]!.status, 'SENT');
    });

    it('reject fires booking.rejected.customer to the customer', async () => {
        const env = buildEnv();
        const seeded = makeAppointment();
        env.apptRepo.seedAppointment(seeded);

        await env.service.reject(seeded.id, caller(OWNER_ID, 'BUSINESS_OWNER'));

        const logs = env.notificationLogRepo.all();
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]!.templateKey, 'booking.rejected.customer');
        assert.strictEqual(logs[0]!.recipientUserId, CUSTOMER_ID);
    });

    it('CUSTOMER cancel fires booking.cancelled.business to the business owner', async () => {
        const env = buildEnv();
        const seeded = makeAppointment();
        env.apptRepo.seedAppointment(seeded);

        await env.service.cancel(
            seeded.id,
            caller(CUSTOMER_ID, 'CUSTOMER'),
            { reason: 'Need to move to next week' },
        );

        const logs = env.notificationLogRepo.all();
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]!.templateKey, 'booking.cancelled.business');
        assert.strictEqual(logs[0]!.recipientUserId, OWNER_ID);
        assert.deepStrictEqual(
            (logs[0]!.payload as { cancelReason: string | null }).cancelReason,
            'Need to move to next week',
        );
    });

    it('BUSINESS cancel fires booking.cancelled.customer to the customer', async () => {
        const env = buildEnv();
        const seeded = makeAppointment();
        env.apptRepo.seedAppointment(seeded);

        await env.service.cancel(
            seeded.id,
            caller(OWNER_ID, 'BUSINESS_OWNER'),
            { reason: 'Salon closed today' },
        );

        const logs = env.notificationLogRepo.all();
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]!.templateKey, 'booking.cancelled.customer');
        assert.strictEqual(logs[0]!.recipientUserId, CUSTOMER_ID);
    });

    it('ADMIN cancel fires booking.cancelled.customer to the customer', async () => {
        const env = buildEnv();
        const seeded = makeAppointment();
        env.apptRepo.seedAppointment(seeded);

        await env.service.cancel(
            seeded.id,
            caller(ADMIN_ID, 'ADMIN'),
            { reason: 'Customer asked support to handle it' },
        );

        const logs = env.notificationLogRepo.all();
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]!.templateKey, 'booking.cancelled.customer');
        assert.strictEqual(logs[0]!.recipientUserId, CUSTOMER_ID);
    });

    it('CUSTOMER reschedule fires booking.rescheduled.business to the business owner', async () => {
        const env = buildEnv({
            slots: [
                Object.freeze<Slot>({ startUtc: STARTS_AT_ISO, endUtc: ENDS_AT_ISO }),
                Object.freeze<Slot>({
                    startUtc: '2026-05-15T07:00:00.000Z',
                    endUtc: '2026-05-15T08:00:00.000Z',
                }),
            ],
        });
        const seeded = makeAppointment();
        env.apptRepo.seedAppointment(seeded);

        await env.service.reschedule(
            seeded.id,
            caller(CUSTOMER_ID, 'CUSTOMER'),
            { newStartsAtUtc: '2026-05-15T07:00:00.000Z' },
        );

        const logs = env.notificationLogRepo.all();
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]!.templateKey, 'booking.rescheduled.business');
        assert.strictEqual(logs[0]!.recipientUserId, OWNER_ID);
    });

    it('complete does not fire any notification', async () => {
        const env = buildEnv();
        const seeded = makeAppointment({ status: 'ACCEPTED' });
        env.apptRepo.seedAppointment(seeded);

        await env.service.complete(seeded.id, caller(OWNER_ID, 'BUSINESS_OWNER'));

        assert.strictEqual(env.notificationLogRepo.size(), 0);
    });

    it('swallows notification dispatch failures and does not break the booking', async () => {
        // Use an env where the dispatcher's recipient lookup fails by
        // wiping the seeded owner row. The customer create call must
        // still succeed; the notification just doesn't land.
        const env = buildEnv();
        const internal = env.userRepo as unknown as {
            rowsById: Map<string, unknown>;
        };
        internal.rowsById.delete(OWNER_ID);

        const result = await env.service.create({
            customerId: CUSTOMER_ID,
            staffId: STAFF_ID,
            serviceId: SERVICE_ID,
            startsAtUtc: STARTS_AT_ISO,
            paymentMethod: 'CASH',
        });

        assert.strictEqual(result.appointment.status, 'REQUESTED');
        // No log row written — the dispatcher refuses to insert when
        // the recipient doesn't resolve.
        assert.strictEqual(env.notificationLogRepo.size(), 0);
    });
});
