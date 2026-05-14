// EthioLink — slot computation algorithm (pure).
//
// Walks a date range one calendar day at a time (in the business
// timezone), assembles the open windows for that day from WEEKLY
// availability + OVERRIDE rows, and emits bookable slots within each
// remaining open window respecting:
//
//   * the service's `durationMinutes` (slot length),
//   * the `slotStepMinutes` cadence (slot starts at minutes 0, step, 2*step, …),
//   * the `bufferMinutes` separation between slots and existing
//     appointments,
//   * a "no slots in the past" filter against the injected `now`.
//
// The function is intentionally pure: it does not touch the database,
// does not know about S3 or Cognito, does not log. `slotService` is
// the layer that calls the repositories and feeds this function its
// data.

import { DateTime } from 'luxon';

import type { AppointmentConflict } from '../appointments/appointmentsRepository.js';

/** One open window on a specific day, in local clock time. */
interface LocalWindow {
    start: string; // HH:MM:SS
    end: string;   // HH:MM:SS
}

/** A single weekly availability row, surface area of the computer's input. */
export interface WeeklyAvailabilityEntry {
    readonly weekday: number;
    readonly startTime: string;
    readonly endTime: string;
}

/** A single override availability row. */
export interface OverrideAvailabilityEntry {
    readonly specificDate: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly isClosed: boolean;
}

export interface ComputeSlotsInput {
    /** Service duration in minutes (positive integer). */
    readonly serviceDurationMinutes: number;
    /** Inclusive start of the date range, YYYY-MM-DD in the business timezone. */
    readonly fromDate: string;
    /** Inclusive end of the date range, YYYY-MM-DD in the business timezone. */
    readonly toDate: string;
    /** IANA timezone for the business (e.g. `Africa/Addis_Ababa`). */
    readonly timezone: string;
    /** Cadence at which slot starts are emitted, in minutes. */
    readonly slotStepMinutes: number;
    /** Gap to enforce between adjacent appointments, in minutes. */
    readonly bufferMinutes: number;
    /** Current wall-clock time. Injected so tests can pin "now". */
    readonly now: Date;
    /** All WEEKLY rows for the staff member. */
    readonly weekly: readonly WeeklyAvailabilityEntry[];
    /** OVERRIDE rows for any date in the range. */
    readonly overrides: readonly OverrideAvailabilityEntry[];
    /** Existing ACCEPTED appointments overlapping the range. */
    readonly conflicts: readonly AppointmentConflict[];
}

export interface Slot {
    readonly startUtc: string;
    readonly endUtc: string;
}

const MAX_RANGE_DAYS = 31;

export class SlotInvalidRangeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SlotInvalidRangeError';
    }
}

export class SlotInvalidTimezoneError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SlotInvalidTimezoneError';
    }
}

/**
 * Compute the list of bookable slots for the given inputs. Pure,
 * deterministic for a fixed `now`.
 */
export function computeSlots(input: ComputeSlotsInput): Slot[] {
    const zone = input.timezone;
    if (!DateTime.now().setZone(zone).isValid) {
        throw new SlotInvalidTimezoneError(`Unknown IANA timezone: ${zone}`);
    }

    const fromDateTime = DateTime.fromISO(input.fromDate, { zone });
    const toDateTime = DateTime.fromISO(input.toDate, { zone });
    if (!fromDateTime.isValid || !toDateTime.isValid) {
        throw new SlotInvalidRangeError(
            `Invalid date range: ${input.fromDate}..${input.toDate}`,
        );
    }
    if (fromDateTime > toDateTime) {
        throw new SlotInvalidRangeError(
            `from (${input.fromDate}) must be <= to (${input.toDate}).`,
        );
    }
    const rangeDays = Math.floor(toDateTime.diff(fromDateTime, 'days').days) + 1;
    if (rangeDays > MAX_RANGE_DAYS) {
        throw new SlotInvalidRangeError(
            `Date range must be ${MAX_RANGE_DAYS} days or fewer; got ${rangeDays}.`,
        );
    }

    // Group weekly entries by weekday (0..6) and overrides by date.
    const weeklyByWeekday = new Map<number, LocalWindow[]>();
    for (const w of input.weekly) {
        const list = weeklyByWeekday.get(w.weekday) ?? [];
        list.push({ start: w.startTime, end: w.endTime });
        weeklyByWeekday.set(w.weekday, list);
    }
    const overridesByDate = new Map<string, OverrideAvailabilityEntry[]>();
    for (const o of input.overrides) {
        const list = overridesByDate.get(o.specificDate) ?? [];
        list.push(o);
        overridesByDate.set(o.specificDate, list);
    }

    const slots: Slot[] = [];
    const nowMs = input.now.getTime();

    let current = fromDateTime.startOf('day');
    const lastDay = toDateTime.startOf('day');
    while (current <= lastDay) {
        const dateStr = current.toISODate()!;
        // Luxon: 1=Monday..7=Sunday. We use 0=Sunday..6=Saturday.
        const weekday = current.weekday % 7;

        // Start with weekly windows for this weekday.
        let windows: LocalWindow[] = (weeklyByWeekday.get(weekday) ?? []).map(
            (w) => ({ start: w.start, end: w.end }),
        );

        // Add open overrides (isClosed=false) — these EXTEND the windows.
        const overrides = overridesByDate.get(dateStr) ?? [];
        for (const o of overrides) {
            if (!o.isClosed) {
                windows.push({ start: o.startTime, end: o.endTime });
            }
        }
        windows = mergeIntervals(windows);

        // Subtract closed overrides — these REMOVE coverage from the day.
        for (const o of overrides) {
            if (o.isClosed) {
                windows = subtractInterval(windows, {
                    start: o.startTime,
                    end: o.endTime,
                });
            }
        }

        // Walk each open window emitting candidate slots.
        for (const w of windows) {
            const winStart = localDateTime(dateStr, w.start, zone);
            const winEnd = localDateTime(dateStr, w.end, zone);
            if (!winStart.isValid || !winEnd.isValid) continue;

            let t = winStart;
            while (true) {
                const slotEnd = t.plus({ minutes: input.serviceDurationMinutes });
                if (slotEnd > winEnd) break;

                const slotStartMs = t.toMillis();
                if (slotStartMs >= nowMs &&
                    !conflictsWithAppointment(
                        slotStartMs,
                        slotEnd.toMillis(),
                        input.conflicts,
                        input.bufferMinutes,
                    )
                ) {
                    slots.push({
                        startUtc: t.toUTC().toISO()!,
                        endUtc: slotEnd.toUTC().toISO()!,
                    });
                }

                t = t.plus({ minutes: input.slotStepMinutes });
            }
        }

        current = current.plus({ days: 1 });
    }

    return slots;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a `YYYY-MM-DD` + `HH:MM:SS` pair in the given zone into a
 * Luxon DateTime. The `24:00:00` end-of-day sentinel is normalized to
 * the next day's `00:00:00` so windows that go to "end of day" work.
 */
function localDateTime(
    date: string,
    time: string,
    zone: string,
): DateTime {
    if (time === '24:00:00') {
        return DateTime.fromISO(`${date}T00:00:00`, { zone }).plus({ days: 1 });
    }
    return DateTime.fromISO(`${date}T${time}`, { zone });
}

/** Lexicographic compare for HH:MM:SS strings of equal length. */
function compareTime(a: string, b: string): number {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}

/**
 * Merge overlapping or touching intervals into a minimal set. Intervals
 * are returned sorted by start time.
 */
function mergeIntervals(windows: LocalWindow[]): LocalWindow[] {
    if (windows.length === 0) return [];
    const sorted = [...windows].sort((a, b) => compareTime(a.start, b.start));
    const merged: LocalWindow[] = [{ ...sorted[0]! }];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1]!;
        const cur = sorted[i]!;
        if (compareTime(cur.start, last.end) <= 0) {
            if (compareTime(cur.end, last.end) > 0) {
                last.end = cur.end;
            }
        } else {
            merged.push({ ...cur });
        }
    }
    return merged;
}

/**
 * Subtract a single interval from a set of intervals. Intervals that
 * fully contain the blackout split into two; intervals disjoint from
 * the blackout pass through unchanged.
 */
function subtractInterval(
    windows: LocalWindow[],
    blackout: LocalWindow,
): LocalWindow[] {
    const result: LocalWindow[] = [];
    for (const w of windows) {
        // No overlap.
        if (
            compareTime(w.end, blackout.start) <= 0 ||
            compareTime(blackout.end, w.start) <= 0
        ) {
            result.push(w);
            continue;
        }
        // Left remainder.
        if (compareTime(w.start, blackout.start) < 0) {
            result.push({ start: w.start, end: blackout.start });
        }
        // Right remainder.
        if (compareTime(blackout.end, w.end) < 0) {
            result.push({ start: blackout.end, end: w.end });
        }
    }
    return result;
}

/**
 * Returns `true` if the slot `[slotStartMs, slotEndMs)` overlaps any
 * existing appointment, after extending each appointment by
 * `bufferMinutes` on both sides.
 */
function conflictsWithAppointment(
    slotStartMs: number,
    slotEndMs: number,
    conflicts: readonly AppointmentConflict[],
    bufferMinutes: number,
): boolean {
    if (conflicts.length === 0) return false;
    const bufferMs = bufferMinutes * 60_000;
    for (const c of conflicts) {
        const cStart = DateTime.fromISO(c.startsAt, { zone: 'utc' }).toMillis();
        const cEnd = DateTime.fromISO(c.endsAt, { zone: 'utc' }).toMillis();
        if (slotStartMs < cEnd + bufferMs && slotEndMs > cStart - bufferMs) {
            return true;
        }
    }
    return false;
}
