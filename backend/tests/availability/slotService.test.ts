// EthioLink — SlotService unit tests.
//
// Verifies the orchestration on top of `computeSlots`:
//
//   * Missing staff → `SlotStaffNotFoundError`.
//   * Inactive staff → `SlotStaffNotFoundError`.
//   * Missing or inactive service → `SlotServiceNotFoundError`.
//   * Service belongs to a different business than the staff →
//     `SlotServiceStaffMismatchError`.
//   * Happy path: availability + service duration + booking config
//     flow through to `computeSlots`, returning UTC ISO slots.
//   * Appointment conflicts from the repository remove overlapping
//     slots from the response.
//
// Slot-math correctness is covered comprehensively in
// `tests/availability/slotComputer.test.ts`; these tests focus on the
// glue between the service and its dependencies.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Business } from '../../shared/domains/businesses/businessRepository.js';
import type { Service } from '../../shared/domains/services/serviceRepository.js';
import type { StaffMember } from '../../shared/domains/staff/staffRepository.js';

import {
    SlotServiceNotFoundError,
    SlotService,
    SlotServiceStaffMismatchError,
    SlotStaffNotFoundError,
} from '../../shared/domains/availability/slotService.js';

import { InMemoryAppointmentsRepository } from '../_fakes/InMemoryAppointmentsRepository.js';
import { InMemoryAvailabilityRepository } from '../_fakes/InMemoryAvailabilityRepository.js';
import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';
import { InMemoryServiceRepository } from '../_fakes/InMemoryServiceRepository.js';
import { InMemoryStaffRepository } from '../_fakes/InMemoryStaffRepository.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const BIZ_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const THURSDAY = '2026-05-14'; // weekday 4 in 0=Sun..6=Sat
const ZONE = 'Africa/Addis_Ababa';

/** A `now` well before the day's first window so past-filter doesn't kick in. */
const DEFAULT_NOW = new Date('2026-05-14T00:00:00.000Z');

const OPTIONS = Object.freeze({
    slotStepMinutes: 15,
    bufferMinutes: 5,
    timezone: ZONE,
});

function makeBusiness(
    id: string,
    ownerUserId: string,
    overrides: Partial<Business> = {},
): Business {
    const now = new Date('2026-05-14T12:00:00.000Z');
    return Object.freeze({
        id,
        ownerUserId,
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

/** Addis HH:MM on a given day → UTC ISO. UTC = Addis − 3h, no DST. */
function addisToUtcIso(date: string, addisTime: string): string {
    const [h, m] = addisTime.split(':').map((p) => Number.parseInt(p, 10));
    const utcHours = h! - 3;
    return `${date}T${String(utcHours).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
}

async function buildHappyEnv(): Promise<{
    service: SlotService;
    staff: StaffMember;
    serviceRow: Service;
    appts: InMemoryAppointmentsRepository;
}> {
    const availRepo = new InMemoryAvailabilityRepository();
    const staffRepo = new InMemoryStaffRepository();
    const svcRepo = new InMemoryServiceRepository();
    const businessRepo = new InMemoryBusinessRepository();
    const appts = new InMemoryAppointmentsRepository();
    const service = new SlotService(
        availRepo,
        staffRepo,
        svcRepo,
        appts,
        OPTIONS,
    );

    businessRepo.seed(makeBusiness(BIZ_A, OWNER_A));
    const staff = await staffRepo.insert({
        businessId: BIZ_A,
        displayName: 'Helen',
        role: 'Stylist',
    });
    const serviceRow = await svcRepo.insert({
        businessId: BIZ_A,
        name: { en: 'Haircut' },
        durationMinutes: 60,
    });
    await availRepo.replaceWeekly(staff.id, [
        { weekday: 4, startTime: '09:00:00', endTime: '12:00:00' },
    ]);

    return { service, staff, serviceRow, appts };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('SlotService.computeSlots — error mapping', () => {
    it('throws SlotStaffNotFoundError for an unknown staff id', async () => {
        const availRepo = new InMemoryAvailabilityRepository();
        const staffRepo = new InMemoryStaffRepository();
        const svcRepo = new InMemoryServiceRepository();
        const appts = new InMemoryAppointmentsRepository();
        const service = new SlotService(availRepo, staffRepo, svcRepo, appts, OPTIONS);

        await assert.rejects(
            () =>
                service.computeSlots({
                    staffId: '00000000-0000-0000-0000-000000000099',
                    serviceId: '00000000-0000-0000-0000-000000000098',
                    fromDate: THURSDAY,
                    toDate: THURSDAY,
                    now: DEFAULT_NOW,
                }),
            SlotStaffNotFoundError,
        );
    });

    it('throws SlotStaffNotFoundError for an inactive staff member', async () => {
        const availRepo = new InMemoryAvailabilityRepository();
        const staffRepo = new InMemoryStaffRepository();
        const svcRepo = new InMemoryServiceRepository();
        const appts = new InMemoryAppointmentsRepository();
        const service = new SlotService(availRepo, staffRepo, svcRepo, appts, OPTIONS);

        const staff = await staffRepo.insert({
            businessId: BIZ_A,
            displayName: 'Helen',
            role: null,
        });
        await staffRepo.setIsActive(staff.id, false);

        await assert.rejects(
            () =>
                service.computeSlots({
                    staffId: staff.id,
                    serviceId: '00000000-0000-0000-0000-000000000098',
                    fromDate: THURSDAY,
                    toDate: THURSDAY,
                    now: DEFAULT_NOW,
                }),
            SlotStaffNotFoundError,
        );
    });

    it('throws SlotServiceNotFoundError for an unknown service id', async () => {
        const { service, staff } = await buildHappyEnv();

        await assert.rejects(
            () =>
                service.computeSlots({
                    staffId: staff.id,
                    serviceId: '00000000-0000-0000-0000-000000000099',
                    fromDate: THURSDAY,
                    toDate: THURSDAY,
                    now: DEFAULT_NOW,
                }),
            SlotServiceNotFoundError,
        );
    });

    it('throws SlotServiceNotFoundError for an inactive service', async () => {
        const availRepo = new InMemoryAvailabilityRepository();
        const staffRepo = new InMemoryStaffRepository();
        const svcRepo = new InMemoryServiceRepository();
        const appts = new InMemoryAppointmentsRepository();
        const slotService = new SlotService(
            availRepo,
            staffRepo,
            svcRepo,
            appts,
            OPTIONS,
        );

        const staff = await staffRepo.insert({
            businessId: BIZ_A,
            displayName: 'Helen',
            role: null,
        });
        const svc = await svcRepo.insert({
            businessId: BIZ_A,
            name: { en: 'Haircut' },
            durationMinutes: 60,
        });
        await svcRepo.setIsActive(svc.id, false);

        await assert.rejects(
            () =>
                slotService.computeSlots({
                    staffId: staff.id,
                    serviceId: svc.id,
                    fromDate: THURSDAY,
                    toDate: THURSDAY,
                    now: DEFAULT_NOW,
                }),
            SlotServiceNotFoundError,
        );
    });

    it('throws SlotServiceStaffMismatchError when service and staff belong to different businesses', async () => {
        const availRepo = new InMemoryAvailabilityRepository();
        const staffRepo = new InMemoryStaffRepository();
        const svcRepo = new InMemoryServiceRepository();
        const businessRepo = new InMemoryBusinessRepository();
        const appts = new InMemoryAppointmentsRepository();
        const slotService = new SlotService(
            availRepo,
            staffRepo,
            svcRepo,
            appts,
            OPTIONS,
        );

        businessRepo.seed(makeBusiness(BIZ_A, OWNER_A));
        businessRepo.seed(makeBusiness(BIZ_B, OWNER_B));

        const staff = await staffRepo.insert({
            businessId: BIZ_A,
            displayName: 'Helen',
            role: null,
        });
        // Service belongs to a *different* business.
        const svc = await svcRepo.insert({
            businessId: BIZ_B,
            name: { en: 'Massage' },
            durationMinutes: 60,
        });

        await assert.rejects(
            () =>
                slotService.computeSlots({
                    staffId: staff.id,
                    serviceId: svc.id,
                    fromDate: THURSDAY,
                    toDate: THURSDAY,
                    now: DEFAULT_NOW,
                }),
            SlotServiceStaffMismatchError,
        );
    });
});

// ---------------------------------------------------------------------------
// Happy path + delegation
// ---------------------------------------------------------------------------

describe('SlotService.computeSlots — delegation', () => {
    it('returns slots computed from availability and service duration', async () => {
        const { service, staff, serviceRow } = await buildHappyEnv();

        const slots = await service.computeSlots({
            staffId: staff.id,
            serviceId: serviceRow.id,
            fromDate: THURSDAY,
            toDate: THURSDAY,
            now: DEFAULT_NOW,
        });

        // Window 09:00..12:00 Addis, 60-min service, 15-min step → 9 slots.
        assert.strictEqual(slots.length, 9);
        assert.strictEqual(slots[0]?.startUtc, addisToUtcIso(THURSDAY, '09:00'));
        assert.strictEqual(slots[8]?.startUtc, addisToUtcIso(THURSDAY, '11:00'));
    });

    it('returns an empty list when the staff has no availability for the requested weekday', async () => {
        const availRepo = new InMemoryAvailabilityRepository();
        const staffRepo = new InMemoryStaffRepository();
        const svcRepo = new InMemoryServiceRepository();
        const appts = new InMemoryAppointmentsRepository();
        const slotService = new SlotService(
            availRepo,
            staffRepo,
            svcRepo,
            appts,
            OPTIONS,
        );

        const staff = await staffRepo.insert({
            businessId: BIZ_A,
            displayName: 'Helen',
            role: null,
        });
        const svc = await svcRepo.insert({
            businessId: BIZ_A,
            name: { en: 'Haircut' },
            durationMinutes: 60,
        });
        // Weekly is empty.

        const slots = await slotService.computeSlots({
            staffId: staff.id,
            serviceId: svc.id,
            fromDate: THURSDAY,
            toDate: THURSDAY,
            now: DEFAULT_NOW,
        });

        assert.deepStrictEqual(slots, []);
    });
});

// ---------------------------------------------------------------------------
// Appointment conflicts wired through
// ---------------------------------------------------------------------------

describe('SlotService.computeSlots — appointment conflicts', () => {
    it('removes overlapping slots when the appointments repository surfaces a conflict', async () => {
        const { service, staff, serviceRow, appts } = await buildHappyEnv();

        // Seed: an existing appointment 10:00..11:00 Addis = 07:00..08:00 UTC.
        // With buffer=5 the conflict zone is 09:55..11:05 Addis → blocks slot
        // starts 09:00, 09:15, 09:30, 09:45, 10:00, 10:15, 10:30, 10:45, 11:00.
        // From the window 09:00..12:00 (9 candidates), the conflict blocks all
        // 9 starts (10:00, 10:15, ..., 11:00 conflict via slot_end side; 09:00..09:45
        // conflict because slot_end > 09:55).
        // Wait, recheck:
        //   slot 09:00..10:00 → slot_end (10:00) > cStart-buffer (09:55)? yes; slot_start (09:00) < cEnd+buffer (11:05)? yes → conflict.
        //   slot 09:15..10:15 → same → conflict.
        //   ...
        //   slot 11:00..12:00 → slot_start (11:00) < 11:05? yes → conflict.
        // So all 9 starts are blocked. Result is an empty array — perfect for
        // verifying the conflict pipe runs at all.
        appts.seed(staff.id, {
            startsAt: addisToUtcIso(THURSDAY, '10:00'),
            endsAt: addisToUtcIso(THURSDAY, '11:00'),
        });

        const slots = await service.computeSlots({
            staffId: staff.id,
            serviceId: serviceRow.id,
            fromDate: THURSDAY,
            toDate: THURSDAY,
            now: DEFAULT_NOW,
        });

        assert.deepStrictEqual(slots, []);
    });

    it('ignores conflicts seeded for a different staff member', async () => {
        const { service, staff, serviceRow, appts } = await buildHappyEnv();

        // Seed a conflict for some OTHER staff id.
        appts.seed('00000000-0000-0000-0000-000000000fff', {
            startsAt: addisToUtcIso(THURSDAY, '10:00'),
            endsAt: addisToUtcIso(THURSDAY, '11:00'),
        });

        const slots = await service.computeSlots({
            staffId: staff.id,
            serviceId: serviceRow.id,
            fromDate: THURSDAY,
            toDate: THURSDAY,
            now: DEFAULT_NOW,
        });

        // All 9 slots present — the conflict was for a different staff.
        assert.strictEqual(slots.length, 9);
    });
});
