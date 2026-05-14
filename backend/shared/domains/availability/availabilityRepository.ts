// EthioLink — staff availability repository.
//
// SQL access to the `staff_availability` table. Two row kinds in the
// same table:
//   * WEEKLY  — recurring open window on `weekday` (0–6).
//   * OVERRIDE — applies to a single `specific_date`, may be a special
//                open window or (with `is_closed = true`) a blackout
//                over the weekly schedule.
//
// `replaceWeekly` runs DELETE-then-INSERT in a single transaction so
// the staff member's weekly schedule never observes a half-replaced
// state. It requires a `Pool` (not just any `SqlExecutor`) so it can
// `connect()` for the transaction.
//
// Time and date columns are surfaced as strings:
//   * `time` columns (start_time / end_time): `HH:MM:SS`.
//   * `date` columns (specific_date): cast to text to dodge pg's
//     default Date-object coercion, which would re-interpret the
//     date in a timezone we don't want it interpreted in.
//
// No `updated_at` — availability rows are immutable; replacement
// happens via DELETE + INSERT, never UPDATE. Matches the schema doc.

import type { Pool } from 'pg';

import { BaseRepository, RepositoryError } from '../../repositories/baseRepository.js';

export type AvailabilityKind = 'WEEKLY' | 'OVERRIDE';

/** Domain shape of one `staff_availability` row. */
export interface AvailabilityWindow {
    readonly id: string;
    readonly staffId: string;
    readonly kind: AvailabilityKind;
    /** 0–6 for WEEKLY rows; null for OVERRIDE. */
    readonly weekday: number | null;
    /** YYYY-MM-DD for OVERRIDE rows; null for WEEKLY. */
    readonly specificDate: string | null;
    /** HH:MM:SS — opening clock time in the staff's business timezone. */
    readonly startTime: string;
    /** HH:MM:SS — closing clock time. Always strictly > startTime. */
    readonly endTime: string;
    /**
     * `true` marks the window as a blackout. Typically used with
     * OVERRIDE rows ("closed for a public holiday"). A WEEKLY row
     * with `isClosed = true` is technically allowed by the schema
     * but is semantically a no-op — owners should just omit the
     * window from the WEEKLY entries.
     */
    readonly isClosed: boolean;
    readonly createdAt: Date;
}

/** A single window inside a weekly replace request. */
export interface WeeklyWindowInput {
    readonly weekday: number;
    readonly startTime: string;
    readonly endTime: string;
}

export interface InsertOverrideInput {
    readonly staffId: string;
    readonly specificDate: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly isClosed?: boolean;
}

export interface AvailabilityRepository {
    /**
     * Replace the staff member's entire WEEKLY schedule atomically.
     * Deletes any existing WEEKLY rows for `staffId`, then inserts
     * the supplied windows. Returns the freshly-inserted rows.
     * OVERRIDE rows are untouched.
     */
    replaceWeekly(
        staffId: string,
        windows: readonly WeeklyWindowInput[],
    ): Promise<readonly AvailabilityWindow[]>;

    /** Insert a single OVERRIDE row. */
    insertOverride(input: InsertOverrideInput): Promise<AvailabilityWindow>;

    /** Return every WEEKLY + OVERRIDE row for the staff member. */
    listForStaff(staffId: string): Promise<readonly AvailabilityWindow[]>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface AvailabilityRow {
    id: string;
    staff_id: string;
    kind: AvailabilityKind;
    weekday: number | null;
    specific_date: string | null;
    start_time: string;
    end_time: string;
    is_closed: boolean;
    created_at: Date;
}

/**
 * The repository casts the `date` column to text to receive a plain
 * `YYYY-MM-DD` string rather than pg's default `Date` object (which
 * would silently apply the connection's session timezone).
 */
const AVAILABILITY_COLUMNS = `
    id,
    staff_id,
    kind,
    weekday,
    specific_date::text AS specific_date,
    start_time::text    AS start_time,
    end_time::text      AS end_time,
    is_closed,
    created_at
`;

/**
 * Listing order: WEEKLY before OVERRIDE, then by weekday (or date),
 * then by start_time. Stable across calls so view-level grouping is
 * deterministic.
 */
const LIST_ORDER = `
    ORDER BY
        CASE kind WHEN 'WEEKLY' THEN 0 WHEN 'OVERRIDE' THEN 1 ELSE 2 END,
        weekday,
        specific_date,
        start_time
`;

export class PgAvailabilityRepository extends BaseRepository implements AvailabilityRepository {
    constructor(private readonly pool: Pool) {
        super(pool);
    }

    async replaceWeekly(
        staffId: string,
        windows: readonly WeeklyWindowInput[],
    ): Promise<readonly AvailabilityWindow[]> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `DELETE FROM staff_availability WHERE staff_id = $1 AND kind = 'WEEKLY';`,
                [staffId],
            );

            const inserted: AvailabilityRow[] = [];
            for (const w of windows) {
                const result = await client.query<AvailabilityRow>(
                    `
                    INSERT INTO staff_availability (
                        staff_id, kind, weekday, start_time, end_time, is_closed
                    )
                    VALUES ($1, 'WEEKLY', $2, $3, $4, false)
                    RETURNING ${AVAILABILITY_COLUMNS};
                    `,
                    [staffId, w.weekday, w.startTime, w.endTime],
                );
                const row = result.rows[0];
                if (!row) {
                    throw new RepositoryError('Weekly INSERT returned no row.');
                }
                inserted.push(row);
            }

            await client.query('COMMIT');
            return inserted.map(mapRow);
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // Swallow rollback errors so the original error surfaces.
            }
            throw err;
        } finally {
            client.release();
        }
    }

    async insertOverride(input: InsertOverrideInput): Promise<AvailabilityWindow> {
        const row = await this.one<AvailabilityRow>(
            `
            INSERT INTO staff_availability (
                staff_id, kind, specific_date, start_time, end_time, is_closed
            )
            VALUES ($1, 'OVERRIDE', $2, $3, $4, $5)
            RETURNING ${AVAILABILITY_COLUMNS};
            `,
            [
                input.staffId,
                input.specificDate,
                input.startTime,
                input.endTime,
                input.isClosed ?? false,
            ],
        );
        return mapRow(row);
    }

    async listForStaff(staffId: string): Promise<readonly AvailabilityWindow[]> {
        const rows = await this.many<AvailabilityRow>(
            `
            SELECT ${AVAILABILITY_COLUMNS}
              FROM staff_availability
             WHERE staff_id = $1
             ${LIST_ORDER};
            `,
            [staffId],
        );
        return rows.map(mapRow);
    }
}

function mapRow(row: AvailabilityRow): AvailabilityWindow {
    return Object.freeze<AvailabilityWindow>({
        id: row.id,
        staffId: row.staff_id,
        kind: row.kind,
        weekday: row.weekday,
        specificDate: row.specific_date,
        startTime: row.start_time,
        endTime: row.end_time,
        isClosed: row.is_closed,
        createdAt: row.created_at,
    });
}
