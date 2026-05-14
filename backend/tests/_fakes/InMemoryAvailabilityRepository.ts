// EthioLink — in-memory `AvailabilityRepository` for tests.
//
// Implements the same three-method surface as `PgAvailabilityRepository`:
//   * `replaceWeekly` — atomic semantics in-memory: clear all WEEKLY rows
//     for `staffId`, then insert the new set. No real transaction needed.
//   * `insertOverride` — append a single OVERRIDE row.
//   * `listForStaff` — return WEEKLY + OVERRIDE rows for the staff in the
//     same order the SQL repo would (`WEEKLY` first, then weekday or
//     specific_date, then start_time).

import { randomUUID } from 'node:crypto';

import type {
    AvailabilityRepository,
    AvailabilityWindow,
    InsertOverrideInput,
    WeeklyWindowInput,
} from '../../shared/domains/availability/availabilityRepository.js';

export class InMemoryAvailabilityRepository implements AvailabilityRepository {
    private readonly rowsById = new Map<string, AvailabilityWindow>();

    /** Test helper: total rows stored. */
    size(): number {
        return this.rowsById.size;
    }

    async replaceWeekly(
        staffId: string,
        windows: readonly WeeklyWindowInput[],
    ): Promise<readonly AvailabilityWindow[]> {
        // Drop existing WEEKLY rows for this staff.
        for (const [id, row] of this.rowsById) {
            if (row.staffId === staffId && row.kind === 'WEEKLY') {
                this.rowsById.delete(id);
            }
        }

        const inserted: AvailabilityWindow[] = [];
        for (const w of windows) {
            const row: AvailabilityWindow = Object.freeze({
                id: randomUUID(),
                staffId,
                kind: 'WEEKLY',
                weekday: w.weekday,
                specificDate: null,
                startTime: w.startTime,
                endTime: w.endTime,
                isClosed: false,
                createdAt: new Date(),
            });
            this.rowsById.set(row.id, row);
            inserted.push(row);
        }
        return inserted;
    }

    async insertOverride(input: InsertOverrideInput): Promise<AvailabilityWindow> {
        const row: AvailabilityWindow = Object.freeze({
            id: randomUUID(),
            staffId: input.staffId,
            kind: 'OVERRIDE',
            weekday: null,
            specificDate: input.specificDate,
            startTime: input.startTime,
            endTime: input.endTime,
            isClosed: input.isClosed ?? false,
            createdAt: new Date(),
        });
        this.rowsById.set(row.id, row);
        return row;
    }

    async listForStaff(staffId: string): Promise<readonly AvailabilityWindow[]> {
        return Array.from(this.rowsById.values())
            .filter((r) => r.staffId === staffId)
            .sort(compareRows);
    }
}

function compareRows(a: AvailabilityWindow, b: AvailabilityWindow): number {
    const aKind = a.kind === 'WEEKLY' ? 0 : 1;
    const bKind = b.kind === 'WEEKLY' ? 0 : 1;
    if (aKind !== bKind) return aKind - bKind;

    if (a.weekday !== b.weekday) {
        if (a.weekday === null) return 1;
        if (b.weekday === null) return -1;
        return a.weekday - b.weekday;
    }
    if (a.specificDate !== b.specificDate) {
        if (a.specificDate === null) return 1;
        if (b.specificDate === null) return -1;
        return a.specificDate.localeCompare(b.specificDate);
    }
    return a.startTime.localeCompare(b.startTime);
}
