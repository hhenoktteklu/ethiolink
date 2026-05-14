// EthioLink — slot computer unit tests.
//
// `computeSlots` is a pure function: no DB, no clock, no network.
// These tests exercise it directly with hand-built fixtures. `now`
// is always injected explicitly so every test is deterministic.
//
// Date conventions used throughout these fixtures:
//   * `2026-05-14` is a Thursday (weekday=4 in our 0=Sun..6=Sat convention).
//   * `2026-05-21` is the following Thursday (also weekday=4).
//   * Timezone is `Africa/Addis_Ababa` (UTC+3, no DST).
//   * 09:00 local time on 2026-05-14 → `2026-05-14T06:00:00.000Z`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    type ComputeSlotsInput,
    SlotInvalidRangeError,
    computeSlots,
} from '../../shared/domains/availability/slotComputer.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ZONE = 'Africa/Addis_Ababa';
const THURSDAY = '2026-05-14';
const NEXT_THURSDAY = '2026-05-21';

/** Default `now`: 2026-05-14T00:00:00.000Z — 03:00 Addis. Before any open window. */
const DEFAULT_NOW = new Date('2026-05-14T00:00:00.000Z');

function makeInput(overrides: Partial<ComputeSlotsInput> = {}): ComputeSlotsInput {
    return {
        serviceDurationMinutes: 60,
        fromDate: THURSDAY,
        toDate: THURSDAY,
        timezone: ZONE,
        slotStepMinutes: 15,
        bufferMinutes: 5,
        now: DEFAULT_NOW,
        weekly: [],
        overrides: [],
        conflicts: [],
        ...overrides,
    };
}

/** Addis HH:MM on a given day → UTC ISO. UTC = Addis − 3h, no DST. */
function addisToUtcIso(date: string, addisTime: string): string {
    const [h, m] = addisTime.split(':').map((p) => Number.parseInt(p, 10));
    const utcHours = h! - 3;
    return `${date}T${String(utcHours).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
}

// ---------------------------------------------------------------------------
// Empty inputs
// ---------------------------------------------------------------------------

describe('computeSlots — empty inputs', () => {
    it('returns no slots when there is no availability at all', () => {
        const result = computeSlots(makeInput());
        assert.deepStrictEqual(result, []);
    });

    it('returns no slots when weekday has no matching weekly entry', () => {
        // Thursday is weekday 4; weekly entry only covers Monday (1).
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 1, startTime: '09:00:00', endTime: '12:00:00' }],
            }),
        );
        assert.deepStrictEqual(result, []);
    });
});

// ---------------------------------------------------------------------------
// Weekly availability
// ---------------------------------------------------------------------------

describe('computeSlots — weekly availability', () => {
    it('emits one slot per slotStep that fits inside a weekly window', () => {
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 4, startTime: '09:00:00', endTime: '12:00:00' }],
            }),
        );
        // 60-min service, 15-min step, window 09:00..12:00.
        // Slot starts: 09:00, 09:15, 09:30, 09:45, 10:00, 10:15, 10:30, 10:45, 11:00 → 9 slots.
        assert.strictEqual(result.length, 9);
        assert.strictEqual(result[0]?.startUtc, addisToUtcIso(THURSDAY, '09:00'));
        assert.strictEqual(result[0]?.endUtc, addisToUtcIso(THURSDAY, '10:00'));
        assert.strictEqual(result[8]?.startUtc, addisToUtcIso(THURSDAY, '11:00'));
        assert.strictEqual(result[8]?.endUtc, addisToUtcIso(THURSDAY, '12:00'));
    });

    it('emits slots from each weekly window when a day has multiple', () => {
        const result = computeSlots(
            makeInput({
                weekly: [
                    { weekday: 4, startTime: '09:00:00', endTime: '12:00:00' },
                    { weekday: 4, startTime: '13:00:00', endTime: '17:00:00' },
                ],
            }),
        );
        // Window 1: 09:00..11:00 → 9 slots.
        // Window 2: 13:00..16:00 → 13 slots (13:00, 13:15, ..., 16:00).
        assert.strictEqual(result.length, 22);
        // No slot in the 12:00..13:00 lunch gap.
        const lunchSlot = result.find(
            (s) => s.startUtc === addisToUtcIso(THURSDAY, '12:00'),
        );
        assert.strictEqual(lunchSlot, undefined);
    });
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

describe('computeSlots — overrides', () => {
    it('closed override removes coverage for the target date only', () => {
        const result = computeSlots(
            makeInput({
                fromDate: THURSDAY,
                toDate: NEXT_THURSDAY,
                weekly: [{ weekday: 4, startTime: '09:00:00', endTime: '12:00:00' }],
                overrides: [
                    {
                        specificDate: THURSDAY,
                        startTime: '00:00:00',
                        endTime: '24:00:00',
                        isClosed: true,
                    },
                ],
            }),
        );
        // 2026-05-14 blacked out → 0 slots.
        // 2026-05-21 (the next Thursday in range) → 9 slots.
        assert.strictEqual(result.length, 9);
        for (const slot of result) {
            assert.ok(
                slot.startUtc.startsWith(NEXT_THURSDAY),
                `expected slot on ${NEXT_THURSDAY}, got ${slot.startUtc}`,
            );
        }
    });

    it('open override extends coverage on a date with no weekly availability', () => {
        const result = computeSlots(
            makeInput({
                weekly: [],
                overrides: [
                    {
                        specificDate: THURSDAY,
                        startTime: '14:00:00',
                        endTime: '16:00:00',
                        isClosed: false,
                    },
                ],
            }),
        );
        // Window 14:00..16:00 → slots 14:00, 14:15, 14:30, 14:45, 15:00 → 5.
        assert.strictEqual(result.length, 5);
        assert.strictEqual(result[0]?.startUtc, addisToUtcIso(THURSDAY, '14:00'));
        assert.strictEqual(result[4]?.startUtc, addisToUtcIso(THURSDAY, '15:00'));
    });

    it('merges overlapping windows so a slot is not emitted twice', () => {
        // Weekly 09:00..12:00 + open override 11:00..14:00 → merged 09:00..14:00.
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 4, startTime: '09:00:00', endTime: '12:00:00' }],
                overrides: [
                    {
                        specificDate: THURSDAY,
                        startTime: '11:00:00',
                        endTime: '14:00:00',
                        isClosed: false,
                    },
                ],
            }),
        );
        // Merged window 09:00..14:00 → slot starts 09:00, 09:15, ..., 13:00 → 17 slots.
        assert.strictEqual(result.length, 17);
        // The 11:00 slot exists exactly once (no duplicate from overlap).
        const elevenStarts = result.filter(
            (s) => s.startUtc === addisToUtcIso(THURSDAY, '11:00'),
        );
        assert.strictEqual(elevenStarts.length, 1);
    });

    it('closed override can clip out a middle range from a wider weekly window', () => {
        // Weekly 09:00..17:00, minus closed override 12:00..13:00 → two sub-windows.
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 4, startTime: '09:00:00', endTime: '17:00:00' }],
                overrides: [
                    {
                        specificDate: THURSDAY,
                        startTime: '12:00:00',
                        endTime: '13:00:00',
                        isClosed: true,
                    },
                ],
            }),
        );
        // No slot starts at 12:00..12:45 (would land inside the blackout).
        const inBlackout = result.filter((s) => {
            const t = s.startUtc.slice(11, 16); // HH:MM UTC
            return t >= '09:00' && t < '10:00'; // 12:00..13:00 Addis = 09:00..10:00 UTC
        });
        assert.strictEqual(inBlackout.length, 0);
        // Boundary: 11:00 Addis slot ends 12:00 Addis — should still fit (window 09:00..12:00).
        const elevenStart = result.find(
            (s) => s.startUtc === addisToUtcIso(THURSDAY, '11:00'),
        );
        assert.ok(elevenStart, 'expected 11:00 Addis slot to survive blackout');
        // Boundary: 13:00 Addis slot starts right at blackout's end — should appear.
        const thirteenStart = result.find(
            (s) => s.startUtc === addisToUtcIso(THURSDAY, '13:00'),
        );
        assert.ok(thirteenStart, 'expected 13:00 Addis slot to survive blackout');
    });
});

// ---------------------------------------------------------------------------
// Service duration
// ---------------------------------------------------------------------------

describe('computeSlots — service duration', () => {
    it('returns empty when service duration exceeds every window', () => {
        const result = computeSlots(
            makeInput({
                serviceDurationMinutes: 90,
                weekly: [{ weekday: 4, startTime: '09:00:00', endTime: '10:00:00' }],
            }),
        );
        assert.deepStrictEqual(result, []);
    });

    it('emits exactly one slot when duration equals window length', () => {
        const result = computeSlots(
            makeInput({
                serviceDurationMinutes: 60,
                weekly: [{ weekday: 4, startTime: '09:00:00', endTime: '10:00:00' }],
            }),
        );
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0]?.startUtc, addisToUtcIso(THURSDAY, '09:00'));
    });
});

// ---------------------------------------------------------------------------
// Past filter
// ---------------------------------------------------------------------------

describe('computeSlots — past filter', () => {
    it('filters out slots in the past based on injected `now`', () => {
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 4, startTime: '09:00:00', endTime: '12:00:00' }],
                // 07:00 UTC = 10:00 Addis. Slots starting before 10:00 Addis are in the past.
                now: new Date('2026-05-14T07:00:00.000Z'),
            }),
        );
        // Remaining starts: 10:00, 10:15, 10:30, 10:45, 11:00 → 5 slots.
        assert.strictEqual(result.length, 5);
        assert.strictEqual(result[0]?.startUtc, addisToUtcIso(THURSDAY, '10:00'));
    });

    it('returns empty when `now` is after the last slot start of the day', () => {
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 4, startTime: '09:00:00', endTime: '12:00:00' }],
                // 12:00 UTC = 15:00 Addis. All slots are in the past.
                now: new Date('2026-05-14T12:00:00.000Z'),
            }),
        );
        assert.deepStrictEqual(result, []);
    });
});

// ---------------------------------------------------------------------------
// Timezone correctness
// ---------------------------------------------------------------------------

describe('computeSlots — timezone correctness', () => {
    it('09:00 Africa/Addis_Ababa serializes as 06:00:00.000Z', () => {
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 4, startTime: '09:00:00', endTime: '10:00:00' }],
            }),
        );
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0]?.startUtc, '2026-05-14T06:00:00.000Z');
        assert.strictEqual(result[0]?.endUtc, '2026-05-14T07:00:00.000Z');
    });

    it('uses the provided timezone to map weekday', () => {
        // Addis is UTC+3. At 2026-05-14T22:00 Addis, it's still Thursday locally,
        // but 19:00 UTC — same day. Different at the day boundary, but for this
        // fixture the weekday lookup must use the Addis weekday, not the UTC one.
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 4, startTime: '22:00:00', endTime: '23:00:00' }],
            }),
        );
        assert.strictEqual(result.length, 1);
        // 22:00 Addis on Thursday → 19:00 UTC on Thursday.
        assert.strictEqual(result[0]?.startUtc, '2026-05-14T19:00:00.000Z');
    });
});

// ---------------------------------------------------------------------------
// Range validation
// ---------------------------------------------------------------------------

describe('computeSlots — range validation', () => {
    it('throws SlotInvalidRangeError when range exceeds 31 days', () => {
        assert.throws(
            () =>
                computeSlots(
                    makeInput({
                        fromDate: '2026-05-14',
                        toDate: '2026-06-14', // 32 days inclusive
                    }),
                ),
            SlotInvalidRangeError,
        );
    });

    it('accepts a 31-day inclusive range', () => {
        // 2026-05-14 through 2026-06-13 = 31 days inclusive. Should not throw.
        computeSlots(
            makeInput({
                fromDate: '2026-05-14',
                toDate: '2026-06-13',
            }),
        );
    });

    it('throws SlotInvalidRangeError when from > to', () => {
        assert.throws(
            () =>
                computeSlots(
                    makeInput({
                        fromDate: '2026-05-20',
                        toDate: '2026-05-14',
                    }),
                ),
            SlotInvalidRangeError,
        );
    });
});

// ---------------------------------------------------------------------------
// Special times
// ---------------------------------------------------------------------------

describe('computeSlots — special times', () => {
    it('accepts 24:00:00 as end-of-day sentinel', () => {
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 4, startTime: '22:00:00', endTime: '24:00:00' }],
            }),
        );
        // Window 22:00..00:00 next day; 60-min service; step 15.
        // Slot starts: 22:00, 22:15, 22:30, 22:45, 23:00 → 5 slots.
        assert.strictEqual(result.length, 5);
        // First slot: 22:00 Addis = 19:00 UTC.
        assert.strictEqual(result[0]?.startUtc, '2026-05-14T19:00:00.000Z');
        // Last slot: 23:00 Addis start → ends at 00:00 next day Addis = 21:00 UTC same day.
        assert.strictEqual(result[4]?.endUtc, '2026-05-14T21:00:00.000Z');
    });
});

// ---------------------------------------------------------------------------
// Appointment conflicts
// ---------------------------------------------------------------------------

describe('computeSlots — appointment conflicts', () => {
    it('removes slots that overlap an existing appointment with the buffer applied', () => {
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 4, startTime: '08:00:00', endTime: '14:00:00' }],
                conflicts: [
                    {
                        startsAt: addisToUtcIso(THURSDAY, '10:00'),
                        endsAt: addisToUtcIso(THURSDAY, '11:00'),
                    },
                ],
            }),
        );
        // Window 08:00..14:00 with 60-min service / 15-min step = 21 candidates.
        // Appointment 10:00..11:00 Addis + 5-min buffer → blocks slot starts 09:00..11:00
        //   (slot_start < 11:05 AND slot_end > 09:55) — 9 starts blocked.
        // Remaining: 21 − 9 = 12.
        assert.strictEqual(result.length, 12);

        // Pre-appointment slot (08:45 Addis) survives — its end (09:45) ≤ buffered start (09:55).
        const survives08_45 = result.find(
            (s) => s.startUtc === addisToUtcIso(THURSDAY, '08:45'),
        );
        assert.ok(survives08_45, 'expected 08:45 Addis slot to survive');

        // First conflicting slot (09:00 Addis) is gone.
        const blocked09_00 = result.find(
            (s) => s.startUtc === addisToUtcIso(THURSDAY, '09:00'),
        );
        assert.strictEqual(blocked09_00, undefined);

        // 11:00 Addis is just inside the buffer (start < 11:05) → blocked.
        const blocked11_00 = result.find(
            (s) => s.startUtc === addisToUtcIso(THURSDAY, '11:00'),
        );
        assert.strictEqual(blocked11_00, undefined);

        // 11:15 Addis is past the buffered end (11:05) → survives.
        const survives11_15 = result.find(
            (s) => s.startUtc === addisToUtcIso(THURSDAY, '11:15'),
        );
        assert.ok(survives11_15, 'expected 11:15 Addis slot to survive');
    });

    it('buffer=0 blocks fewer slots than buffer>0 around the same appointment', () => {
        const base = makeInput({
            weekly: [{ weekday: 4, startTime: '08:00:00', endTime: '14:00:00' }],
            conflicts: [
                {
                    startsAt: addisToUtcIso(THURSDAY, '10:00'),
                    endsAt: addisToUtcIso(THURSDAY, '11:00'),
                },
            ],
        });

        const noBuffer = computeSlots({ ...base, bufferMinutes: 0 });
        const withBuffer = computeSlots({ ...base, bufferMinutes: 5 });

        // With buffer, the 11:00 Addis slot becomes blocked (slot_start 11:00 < 11:05).
        assert.ok(
            withBuffer.length < noBuffer.length,
            `expected buffered count (${withBuffer.length}) < unbuffered count (${noBuffer.length})`,
        );
    });

    it('appointment outside the queried range does not affect slots', () => {
        const result = computeSlots(
            makeInput({
                weekly: [{ weekday: 4, startTime: '09:00:00', endTime: '12:00:00' }],
                conflicts: [
                    {
                        // A whole week earlier, doesn't touch today's slots.
                        startsAt: '2026-05-07T06:00:00.000Z',
                        endsAt: '2026-05-07T07:00:00.000Z',
                    },
                ],
            }),
        );
        // Full 9 slots intact.
        assert.strictEqual(result.length, 9);
    });
});
