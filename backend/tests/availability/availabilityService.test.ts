// EthioLink — AvailabilityService unit tests.
//
// Covers the orchestration layer above `slotComputer`:
//
//   * `getScheduleForStaff` — grouped weekly + overrides; refuses
//     missing or inactive staff.
//   * `replaceWeekly` — ownership, strict-7 weekday enforcement,
//     duplicate-weekday rejection, end > start enforcement.
//   * `addOverride` — ownership, date/time format, closed-blackout
//     stands alone without an open sibling.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Business } from '../../shared/domains/businesses/businessRepository.js';
import type { CallerContext } from '../../shared/domains/businesses/businessService.js';
import {
    AvailabilityInvalidOverrideError,
    AvailabilityInvalidWeeklyError,
    AvailabilityNotOwnedError,
    AvailabilityService,
    AvailabilityStaffNotFoundError,
    type AddOverrideInput,
    type ReplaceWeeklyInput,
    type WeeklyDaySchedule,
} from '../../shared/domains/availability/availabilityService.js';
import type { StaffMember } from '../../shared/domains/staff/staffRepository.js';

import { InMemoryAvailabilityRepository } from '../_fakes/InMemoryAvailabilityRepository.js';
import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';
import { InMemoryStaffRepository } from '../_fakes/InMemoryStaffRepository.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const BIZ_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
// `STAFF_A` lived here when the suite seeded staff via the deleted
// `makeStaff(...)` factory. Today `seedStaff(...)` lets the repo
// generate the id, so we keep only `STAFF_UNKNOWN` for negative
// lookups.
const STAFF_UNKNOWN = '99999999-9999-9999-9999-999999999999';

function caller(userId: string, role: CallerContext['role'] = 'BUSINESS_OWNER'): CallerContext {
    return { userId, role };
}

function makeBusiness(overrides: Partial<Business> = {}): Business {
    const now = new Date('2026-05-14T12:00:00.000Z');
    return Object.freeze({
        id: BIZ_A,
        ownerUserId: OWNER_A,
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
        searchRank: null,
        ...overrides,
    });
}

// `makeStaff(...)` used to live here, but the build switched to
// seeding staff via the in-memory staff repo's helper. The factory
// was left behind and `noUnusedLocals` flagged it.

/** All seven weekdays present, mostly empty. Use as a baseline. */
function fullEmptyWeek(): readonly WeeklyDaySchedule[] {
    return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, windows: [] }));
}

function build(opts: { seedStaff?: boolean; seedBusiness?: boolean } = {}): {
    service: AvailabilityService;
    availRepo: InMemoryAvailabilityRepository;
    staffRepo: InMemoryStaffRepository;
    businessRepo: InMemoryBusinessRepository;
} {
    const availRepo = new InMemoryAvailabilityRepository();
    const staffRepo = new InMemoryStaffRepository();
    const businessRepo = new InMemoryBusinessRepository();
    const service = new AvailabilityService(availRepo, staffRepo, businessRepo);

    if (opts.seedBusiness !== false) {
        businessRepo.seed(makeBusiness());
    }
    if (opts.seedStaff !== false) {
        // The in-memory staff fake doesn't expose seed(); insert through the public path.
        // We use a synchronous IIFE to keep the helper callsite tidy.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        (async () => {
            await staffRepo.insert({
                businessId: BIZ_A,
                displayName: 'Helen',
                role: 'Stylist',
            });
        })();
    }

    return { service, availRepo, staffRepo, businessRepo };
}

/**
 * Helper that synchronously seeds an active staff member with the
 * fixed id STAFF_A. The repo's `insert` generates UUIDs, so we
 * additionally inject a row with a known id by reaching into the
 * private map via a setForTesting hack would be ugly — instead the
 * service tests find staff by id via `staffRepo.findById`, so we
 * use the inserted staff's actual id everywhere.
 */
async function seedStaff(staffRepo: InMemoryStaffRepository): Promise<StaffMember> {
    return staffRepo.insert({
        businessId: BIZ_A,
        displayName: 'Helen',
        role: 'Stylist',
    });
}

// ---------------------------------------------------------------------------
// getScheduleForStaff
// ---------------------------------------------------------------------------

describe('AvailabilityService.getScheduleForStaff', () => {
    it('returns grouped weekly + overrides for an active staff member', async () => {
        const { service, availRepo, staffRepo, businessRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        await availRepo.replaceWeekly(staff.id, [
            { weekday: 1, startTime: '09:00:00', endTime: '12:00:00' },
            { weekday: 1, startTime: '13:00:00', endTime: '17:00:00' },
            { weekday: 3, startTime: '10:00:00', endTime: '14:00:00' },
        ]);
        await availRepo.insertOverride({
            staffId: staff.id,
            specificDate: '2026-12-25',
            startTime: '00:00:00',
            endTime: '24:00:00',
            isClosed: true,
        });

        const schedule = await service.getScheduleForStaff(staff.id);

        assert.strictEqual(schedule.weekly.length, 3);
        assert.strictEqual(schedule.overrides.length, 1);
        assert.strictEqual(schedule.overrides[0]?.specificDate, '2026-12-25');
        assert.strictEqual(schedule.overrides[0]?.isClosed, true);
    });

    it('throws AvailabilityStaffNotFoundError for an unknown staff id', async () => {
        const { service } = build();

        await assert.rejects(
            () => service.getScheduleForStaff(STAFF_UNKNOWN),
            (err: unknown) =>
                err instanceof AvailabilityStaffNotFoundError &&
                err.staffId === STAFF_UNKNOWN,
        );
    });

    it('throws AvailabilityStaffNotFoundError for an inactive staff member', async () => {
        const { service, staffRepo } = build({ seedStaff: false });
        const staff = await seedStaff(staffRepo);
        await staffRepo.setIsActive(staff.id, false);

        await assert.rejects(
            () => service.getScheduleForStaff(staff.id),
            AvailabilityStaffNotFoundError,
        );
    });
});

// ---------------------------------------------------------------------------
// replaceWeekly
// ---------------------------------------------------------------------------

describe('AvailabilityService.replaceWeekly', () => {
    it('happily replaces the schedule when input includes all 7 weekdays', async () => {
        const { service, availRepo, staffRepo, businessRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        const input: ReplaceWeeklyInput = {
            days: [
                { weekday: 0, windows: [] },
                {
                    weekday: 1,
                    windows: [{ startTime: '09:00:00', endTime: '12:00:00' }],
                },
                { weekday: 2, windows: [] },
                {
                    weekday: 3,
                    windows: [
                        { startTime: '09:00:00', endTime: '12:00:00' },
                        { startTime: '13:00:00', endTime: '17:00:00' },
                    ],
                },
                { weekday: 4, windows: [] },
                { weekday: 5, windows: [] },
                { weekday: 6, windows: [] },
            ],
        };

        await service.replaceWeekly(caller(OWNER_A), staff.id, input);

        const stored = await availRepo.listForStaff(staff.id);
        // 3 windows total (one Mon, two Wed).
        assert.strictEqual(stored.length, 3);
        assert.ok(stored.every((r) => r.kind === 'WEEKLY'));
    });

    it('rejects a body that omits any weekday', async () => {
        const { service, staffRepo, businessRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        const input: ReplaceWeeklyInput = {
            // Missing weekday 6.
            days: [
                { weekday: 0, windows: [] },
                { weekday: 1, windows: [] },
                { weekday: 2, windows: [] },
                { weekday: 3, windows: [] },
                { weekday: 4, windows: [] },
                { weekday: 5, windows: [] },
            ],
        };

        await assert.rejects(
            () => service.replaceWeekly(caller(OWNER_A), staff.id, input),
            (err: unknown) =>
                err instanceof AvailabilityInvalidWeeklyError &&
                String(err.details.field).includes('days'),
        );
    });

    it('rejects a body with a duplicated weekday', async () => {
        const { service, staffRepo, businessRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        const input: ReplaceWeeklyInput = {
            days: [
                { weekday: 0, windows: [] },
                { weekday: 1, windows: [] },
                { weekday: 1, windows: [] }, // duplicate
                { weekday: 3, windows: [] },
                { weekday: 4, windows: [] },
                { weekday: 5, windows: [] },
                { weekday: 6, windows: [] },
            ],
        };

        await assert.rejects(
            () => service.replaceWeekly(caller(OWNER_A), staff.id, input),
            AvailabilityInvalidWeeklyError,
        );
    });

    it('rejects a window where endTime <= startTime', async () => {
        const { service, staffRepo, businessRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        const input: ReplaceWeeklyInput = {
            days: fullEmptyWeek().map((d) =>
                d.weekday === 1
                    ? {
                          weekday: 1,
                          windows: [{ startTime: '12:00:00', endTime: '12:00:00' }],
                      }
                    : d,
            ),
        };

        await assert.rejects(
            () => service.replaceWeekly(caller(OWNER_A), staff.id, input),
            AvailabilityInvalidWeeklyError,
        );
    });

    it('refuses non-owners with AvailabilityNotOwnedError', async () => {
        const { service, staffRepo, businessRepo, availRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        await assert.rejects(
            () =>
                service.replaceWeekly(caller(OWNER_B), staff.id, {
                    days: fullEmptyWeek(),
                }),
            AvailabilityNotOwnedError,
        );
        assert.strictEqual(availRepo.size(), 0, 'no rows written on auth failure');
    });
});

// ---------------------------------------------------------------------------
// addOverride
// ---------------------------------------------------------------------------

describe('AvailabilityService.addOverride', () => {
    const openInput: AddOverrideInput = {
        specificDate: '2026-05-20',
        startTime: '09:00:00',
        endTime: '12:00:00',
        isClosed: false,
    };

    const closedInput: AddOverrideInput = {
        specificDate: '2026-12-25',
        startTime: '00:00:00',
        endTime: '24:00:00',
        isClosed: true,
    };

    it('inserts an open override', async () => {
        const { service, staffRepo, businessRepo, availRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        const row = await service.addOverride(caller(OWNER_A), staff.id, openInput);

        assert.strictEqual(row.kind, 'OVERRIDE');
        assert.strictEqual(row.isClosed, false);
        assert.strictEqual(row.specificDate, '2026-05-20');
        assert.strictEqual(availRepo.size(), 1);
    });

    it('inserts a closed override (blackout) without requiring an open sibling', async () => {
        const { service, staffRepo, businessRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        const row = await service.addOverride(caller(OWNER_A), staff.id, closedInput);

        assert.strictEqual(row.kind, 'OVERRIDE');
        assert.strictEqual(row.isClosed, true);
        assert.strictEqual(row.specificDate, '2026-12-25');
        assert.strictEqual(row.startTime, '00:00:00');
        assert.strictEqual(row.endTime, '24:00:00');
    });

    it('rejects an override with a malformed specificDate', async () => {
        const { service, staffRepo, businessRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        await assert.rejects(
            () =>
                service.addOverride(caller(OWNER_A), staff.id, {
                    ...openInput,
                    specificDate: 'not-a-date',
                }),
            AvailabilityInvalidOverrideError,
        );
    });

    it('rejects an override with endTime <= startTime', async () => {
        const { service, staffRepo, businessRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        await assert.rejects(
            () =>
                service.addOverride(caller(OWNER_A), staff.id, {
                    ...openInput,
                    startTime: '12:00:00',
                    endTime: '12:00:00',
                }),
            // Time-range invalid surfaces via the weekly error class (shared
            // helper); the override error class is reserved for specifically
            // override-shape issues (e.g. malformed date).
            AvailabilityInvalidWeeklyError,
        );
    });

    it('refuses non-owners', async () => {
        const { service, staffRepo, businessRepo } = build({
            seedStaff: false,
            seedBusiness: false,
        });
        businessRepo.seed(makeBusiness());
        const staff = await seedStaff(staffRepo);

        await assert.rejects(
            () => service.addOverride(caller(OWNER_B), staff.id, openInput),
            AvailabilityNotOwnedError,
        );
    });

    it('throws AvailabilityStaffNotFoundError for an unknown staff id', async () => {
        const { service } = build();

        await assert.rejects(
            () => service.addOverride(caller(OWNER_A), STAFF_UNKNOWN, openInput),
            AvailabilityStaffNotFoundError,
        );
    });
});
