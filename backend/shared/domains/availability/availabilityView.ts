// EthioLink — public JSON shape for availability rows.
//
// One view shape per row. The schedule-read endpoint
// (`GET …/availability`) returns `{ weekly: [...], overrides: [...] }`
// — two flat arrays of `AvailabilityWindowView`. Clients group as they
// see fit.
//
// The fields differ slightly between kinds:
//   * WEEKLY rows carry `weekday` (0–6), `specificDate` is null.
//   * OVERRIDE rows carry `specificDate` (YYYY-MM-DD), `weekday` is null.
// Both shapes are exposed in a single view so consumers know what they're
// receiving without a discriminated union on the wire (the `kind` field
// is the discriminator).

import type {
    AvailabilityKind,
    AvailabilityWindow,
} from './availabilityRepository.js';

export interface AvailabilityWindowView {
    readonly id: string;
    readonly kind: AvailabilityKind;
    readonly weekday: number | null;
    readonly specificDate: string | null;
    readonly startTime: string;
    readonly endTime: string;
    readonly isClosed: boolean;
}

export interface AvailabilityScheduleView {
    readonly weekly: readonly AvailabilityWindowView[];
    readonly overrides: readonly AvailabilityWindowView[];
}

export function toAvailabilityWindowView(
    window: AvailabilityWindow,
): AvailabilityWindowView {
    return Object.freeze<AvailabilityWindowView>({
        id: window.id,
        kind: window.kind,
        weekday: window.weekday,
        specificDate: window.specificDate,
        startTime: window.startTime,
        endTime: window.endTime,
        isClosed: window.isClosed,
    });
}

export function toAvailabilityScheduleView(
    schedule: {
        readonly weekly: readonly AvailabilityWindow[];
        readonly overrides: readonly AvailabilityWindow[];
    },
): AvailabilityScheduleView {
    return Object.freeze<AvailabilityScheduleView>({
        weekly: schedule.weekly.map(toAvailabilityWindowView),
        overrides: schedule.overrides.map(toAvailabilityWindowView),
    });
}
