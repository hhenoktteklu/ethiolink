// EthioLink — slot service.
//
// Orchestrates the inputs `computeSlots` needs:
//
//   1. Validate the staff member exists and is active.
//   2. Validate the service exists, is active, and belongs to the SAME
//      business as the staff member. A customer cannot book staff X
//      for service Y if they're owned by different businesses.
//   3. Fetch the staff member's WEEKLY + OVERRIDE rows for any date in
//      the requested range.
//   4. Fetch ACCEPTED-appointment conflicts in the UTC range. Phase 3
//      uses a stub repository that always returns []; Phase 4 swaps in
//      a real implementation.
//   5. Hand it all to `computeSlots`.
//
// Errors are typed so the handler maps them cleanly to HTTP codes.

import { DateTime } from 'luxon';

import type { AppointmentsRepository } from '../appointments/appointmentsRepository.js';
import type { ServiceRepository } from '../services/serviceRepository.js';
import type { StaffRepository } from '../staff/staffRepository.js';

import type { AvailabilityRepository } from './availabilityRepository.js';
import { computeSlots, SlotInvalidRangeError, SlotInvalidTimezoneError, type Slot } from './slotComputer.js';

export { SlotInvalidRangeError, SlotInvalidTimezoneError } from './slotComputer.js';
export type { Slot } from './slotComputer.js';

// ---------------------------------------------------------------------------
// Errors — each maps to one HTTP code in handlers
// ---------------------------------------------------------------------------

export class SlotStaffNotFoundError extends Error {
    public readonly staffId: string;
    constructor(staffId: string) {
        super(`Staff member ${staffId} not found.`);
        this.name = 'SlotStaffNotFoundError';
        this.staffId = staffId;
    }
}

export class SlotServiceNotFoundError extends Error {
    public readonly serviceId: string;
    constructor(serviceId: string) {
        super(`Service ${serviceId} not found.`);
        this.name = 'SlotServiceNotFoundError';
        this.serviceId = serviceId;
    }
}

/** Raised when service.businessId does not match staff.businessId. */
export class SlotServiceStaffMismatchError extends Error {
    constructor() {
        super('Service and staff member belong to different businesses.');
        this.name = 'SlotServiceStaffMismatchError';
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ComputeSlotsServiceInput {
    readonly staffId: string;
    readonly serviceId: string;
    readonly fromDate: string;
    readonly toDate: string;
    /** Test seam: defaults to `new Date()`. */
    readonly now?: Date;
}

export interface SlotServiceOptions {
    readonly slotStepMinutes: number;
    readonly bufferMinutes: number;
    readonly timezone: string;
}

export class SlotService {
    constructor(
        private readonly availabilityRepo: AvailabilityRepository,
        private readonly staffRepo: StaffRepository,
        private readonly serviceRepo: ServiceRepository,
        private readonly appointmentsRepo: AppointmentsRepository,
        private readonly options: SlotServiceOptions,
    ) {}

    /**
     * Compute bookable slots for `staffId` over `[fromDate, toDate]`
     * for `serviceId`'s duration. Returns slots in UTC ISO format,
     * already filtered for the past, weekly/override availability, and
     * existing appointment conflicts (stubbed empty in Phase 3).
     */
    async computeSlots(input: ComputeSlotsServiceInput): Promise<readonly Slot[]> {
        const staff = await this.staffRepo.findById(input.staffId);
        if (!staff || !staff.isActive) {
            throw new SlotStaffNotFoundError(input.staffId);
        }

        const service = await this.serviceRepo.findById(input.serviceId);
        if (!service || !service.isActive) {
            throw new SlotServiceNotFoundError(input.serviceId);
        }

        if (service.businessId !== staff.businessId) {
            throw new SlotServiceStaffMismatchError();
        }

        const availability = await this.availabilityRepo.listForStaff(input.staffId);
        const weekly = availability
            .filter((a) => a.kind === 'WEEKLY' && a.weekday !== null)
            .map((a) => ({
                weekday: a.weekday as number,
                startTime: a.startTime,
                endTime: a.endTime,
            }));
        const overrides = availability
            .filter((a) => a.kind === 'OVERRIDE' && a.specificDate !== null)
            .map((a) => ({
                specificDate: a.specificDate as string,
                startTime: a.startTime,
                endTime: a.endTime,
                isClosed: a.isClosed,
            }));

        // Build a UTC range that fully encloses the requested date span.
        // start of fromDate (local) → UTC, end of toDate (local) → UTC.
        const fromUtc = DateTime.fromISO(input.fromDate, { zone: this.options.timezone })
            .startOf('day')
            .toUTC()
            .toISO();
        const toUtc = DateTime.fromISO(input.toDate, { zone: this.options.timezone })
            .endOf('day')
            .toUTC()
            .toISO();
        if (fromUtc === null || toUtc === null) {
            // Defensive: computeSlots will also validate the input dates and throw.
            throw new SlotInvalidRangeError(
                `Invalid date range: ${input.fromDate}..${input.toDate}`,
            );
        }

        const conflicts = await this.appointmentsRepo.listConflictsForStaff(
            input.staffId,
            fromUtc,
            toUtc,
        );

        return computeSlots({
            serviceDurationMinutes: service.durationMinutes,
            fromDate: input.fromDate,
            toDate: input.toDate,
            timezone: this.options.timezone,
            slotStepMinutes: this.options.slotStepMinutes,
            bufferMinutes: this.options.bufferMinutes,
            now: input.now ?? new Date(),
            weekly,
            overrides,
            conflicts,
        });
    }
}
