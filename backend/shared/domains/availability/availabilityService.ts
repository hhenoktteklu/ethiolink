// EthioLink — staff availability service.
//
// Domain rules for staff schedules:
//
//   * Public schedule read returns every WEEKLY + OVERRIDE row for the
//     staff member, grouped at the view layer.
//   * Writes require the caller to own the business the staff member
//     belongs to. Two-hop lookup: `staffRepo.findById(staffId).businessId`
//     → `businessRepo.findById(...).ownerUserId` → compare to caller.
//   * Phase 3 scope is strict owner-only. Admin write paths land in
//     Phase 5 (`CallerContext.role` carries the role today so the
//     relaxation is a one-line change).
//   * Weekly replace is **strict**: the input must list all seven
//     weekdays (0–6), exactly once each, even if a day has no windows.
//     An empty `windows` array communicates "closed all day" intent
//     unambiguously and is preserved across replaces.
//   * Each window must have `startTime < endTime` and a weekday in
//     `[0, 6]`.
//   * Override requires `specificDate` (YYYY-MM-DD); `isClosed`
//     defaults to false. A closed-blackout override does NOT require
//     an open window to coexist on the same date — the override row
//     stands alone.
//   * Slot computation is intentionally NOT in this commit. It lands
//     as its own focused commit once the inventory side ships.

import type { BusinessRepository } from '../businesses/businessRepository.js';
import type { CallerContext } from '../businesses/businessService.js';
import type { StaffRepository } from '../staff/staffRepository.js';

import type {
    AvailabilityRepository,
    AvailabilityWindow,
    InsertOverrideInput,
    WeeklyWindowInput,
} from './availabilityRepository.js';

/** Service-layer input for a single weekday's windows (handler shape). */
export interface WeeklyDaySchedule {
    readonly weekday: number;
    readonly windows: ReadonlyArray<{
        readonly startTime: string;
        readonly endTime: string;
    }>;
}

/** Full week input to `replaceWeekly`. Must have exactly seven entries. */
export interface ReplaceWeeklyInput {
    readonly days: readonly WeeklyDaySchedule[];
}

/** Service-layer input for `addOverride`. Mirrors the repository shape modulo `staffId`. */
export interface AddOverrideInput {
    readonly specificDate: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly isClosed?: boolean;
}

/** The grouped schedule returned by `getScheduleForStaff`. */
export interface StaffSchedule {
    readonly weekly: readonly AvailabilityWindow[];
    readonly overrides: readonly AvailabilityWindow[];
}

// ---------------------------------------------------------------------------
// Errors — each maps to one HTTP code in handlers
// ---------------------------------------------------------------------------

export class AvailabilityStaffNotFoundError extends Error {
    public readonly staffId: string;
    constructor(staffId: string) {
        super(`Staff member ${staffId} not found.`);
        this.name = 'AvailabilityStaffNotFoundError';
        this.staffId = staffId;
    }
}

export class AvailabilityNotOwnedError extends Error {
    constructor() {
        super('Caller does not own the business this staff member belongs to.');
        this.name = 'AvailabilityNotOwnedError';
    }
}

/** Raised when a weekly replace request fails schema-level validation. */
export class AvailabilityInvalidWeeklyError extends Error {
    public readonly details: Record<string, unknown>;
    constructor(message: string, details: Record<string, unknown>) {
        super(message);
        this.name = 'AvailabilityInvalidWeeklyError';
        this.details = details;
    }
}

/** Raised when an override request fails schema-level validation. */
export class AvailabilityInvalidOverrideError extends Error {
    public readonly details: Record<string, unknown>;
    constructor(message: string, details: Record<string, unknown>) {
        super(message);
        this.name = 'AvailabilityInvalidOverrideError';
        this.details = details;
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-4]):[0-5]\d:[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALL_WEEKDAYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

export class AvailabilityService {
    constructor(
        private readonly repository: AvailabilityRepository,
        private readonly staffRepo: StaffRepository,
        private readonly businessRepo: BusinessRepository,
    ) {}

    // ----- Public reads ------------------------------------------------------

    /**
     * Returns the staff member's WEEKLY rows + OVERRIDE rows, grouped.
     * Throws `AvailabilityStaffNotFoundError` if the staff member does
     * not exist or has been deactivated.
     */
    async getScheduleForStaff(staffId: string): Promise<StaffSchedule> {
        const staff = await this.staffRepo.findById(staffId);
        if (!staff || !staff.isActive) {
            throw new AvailabilityStaffNotFoundError(staffId);
        }
        const rows = await this.repository.listForStaff(staffId);
        return {
            weekly: rows.filter((r) => r.kind === 'WEEKLY'),
            overrides: rows.filter((r) => r.kind === 'OVERRIDE'),
        };
    }

    // ----- Owner writes ------------------------------------------------------

    /**
     * Replace the staff's weekly schedule. Validates the input has all
     * seven weekdays (each appearing exactly once), each window has
     * `startTime < endTime`, and returns the freshly-stored rows.
     */
    async replaceWeekly(
        caller: CallerContext,
        staffId: string,
        input: ReplaceWeeklyInput,
    ): Promise<readonly AvailabilityWindow[]> {
        await this.assertOwnsStaff(caller, staffId);
        const flat = this.validateWeekly(input);
        return this.repository.replaceWeekly(staffId, flat);
    }

    /**
     * Add a single OVERRIDE row. Validates `specificDate`, `startTime`,
     * `endTime`. A closed blackout (`isClosed = true`) is allowed
     * without a corresponding open window on the same date.
     */
    async addOverride(
        caller: CallerContext,
        staffId: string,
        input: AddOverrideInput,
    ): Promise<AvailabilityWindow> {
        await this.assertOwnsStaff(caller, staffId);
        this.validateOverride(input);
        return this.repository.insertOverride({ staffId, ...input });
    }

    // ----- internals ---------------------------------------------------------

    private async assertOwnsStaff(
        caller: CallerContext,
        staffId: string,
    ): Promise<void> {
        const staff = await this.staffRepo.findById(staffId);
        if (!staff) {
            throw new AvailabilityStaffNotFoundError(staffId);
        }
        const business = await this.businessRepo.findById(staff.businessId);
        // Defensive: schema FK should prevent a staff row pointing at a
        // missing business, but treat as not-found if it happens.
        if (!business) {
            throw new AvailabilityStaffNotFoundError(staffId);
        }
        if (business.ownerUserId !== caller.userId) {
            throw new AvailabilityNotOwnedError();
        }
    }

    private validateWeekly(input: ReplaceWeeklyInput): WeeklyWindowInput[] {
        if (!Array.isArray(input.days)) {
            throw new AvailabilityInvalidWeeklyError(
                'days must be an array of seven entries.',
                { field: 'days' },
            );
        }
        if (input.days.length !== 7) {
            throw new AvailabilityInvalidWeeklyError(
                'days must contain exactly seven entries — one per weekday.',
                { field: 'days', expected: 7, got: input.days.length },
            );
        }

        // Build a presence map; reject duplicates and out-of-range weekdays.
        const seen = new Set<number>();
        for (const day of input.days) {
            if (
                !Number.isInteger(day.weekday) ||
                day.weekday < 0 ||
                day.weekday > 6
            ) {
                throw new AvailabilityInvalidWeeklyError(
                    'weekday must be an integer 0..6.',
                    { field: 'days[].weekday', value: day.weekday },
                );
            }
            if (seen.has(day.weekday)) {
                throw new AvailabilityInvalidWeeklyError(
                    `weekday ${day.weekday} appears more than once.`,
                    { field: 'days[].weekday', value: day.weekday },
                );
            }
            seen.add(day.weekday);
        }
        for (const expected of ALL_WEEKDAYS) {
            if (!seen.has(expected)) {
                throw new AvailabilityInvalidWeeklyError(
                    `weekday ${expected} missing — all seven weekdays must be present.`,
                    { field: 'days[].weekday', missing: expected },
                );
            }
        }

        // Flatten + validate each window.
        const flat: WeeklyWindowInput[] = [];
        for (const day of input.days) {
            if (!Array.isArray(day.windows)) {
                throw new AvailabilityInvalidWeeklyError(
                    `weekday ${day.weekday} windows must be an array.`,
                    { field: `days[weekday=${day.weekday}].windows` },
                );
            }
            for (const w of day.windows) {
                this.validateWindowTimes(w, `days[weekday=${day.weekday}].windows`);
                flat.push({
                    weekday: day.weekday,
                    startTime: w.startTime,
                    endTime: w.endTime,
                });
            }
        }
        return flat;
    }

    private validateOverride(input: AddOverrideInput): void {
        if (typeof input.specificDate !== 'string' || !DATE_RE.test(input.specificDate)) {
            throw new AvailabilityInvalidOverrideError(
                'specificDate must be a YYYY-MM-DD date.',
                { field: 'specificDate', value: input.specificDate },
            );
        }
        this.validateWindowTimes(input, 'override');
    }

    private validateWindowTimes(
        window: { readonly startTime: string; readonly endTime: string },
        fieldPath: string,
    ): void {
        if (typeof window.startTime !== 'string' || !TIME_RE.test(window.startTime)) {
            throw new AvailabilityInvalidWeeklyError(
                `${fieldPath}.startTime must be HH:MM:SS.`,
                { field: `${fieldPath}.startTime`, value: window.startTime },
            );
        }
        if (typeof window.endTime !== 'string' || !TIME_RE.test(window.endTime)) {
            throw new AvailabilityInvalidWeeklyError(
                `${fieldPath}.endTime must be HH:MM:SS.`,
                { field: `${fieldPath}.endTime`, value: window.endTime },
            );
        }
        if (compareTime(window.startTime, window.endTime) >= 0) {
            throw new AvailabilityInvalidWeeklyError(
                `${fieldPath}.endTime must be strictly greater than startTime.`,
                {
                    field: fieldPath,
                    startTime: window.startTime,
                    endTime: window.endTime,
                },
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lexicographic compare is sufficient for HH:MM:SS strings of equal length. */
function compareTime(a: string, b: string): number {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}
