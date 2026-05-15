// EthioLink — appointments repository.
//
// SQL access to the `appointments` table created in migration 0009.
// Two interfaces are exported:
//
//   * `AppointmentConflictsRepository` — the narrow read-only port the
//     Phase 3 slot computer depends on. Listing for slot computation is
//     the only thing this seam exposes, so `slotService` and its test
//     fakes can implement just this small shape.
//
//   * `AppointmentsRepository` — the wide booking-flow port: extends the
//     conflicts port with the read / write methods the Phase 4
//     appointment service will need (insert, findById, listForCustomer,
//     listForBusiness, setStatus, reschedule).
//
// `StubAppointmentsRepository` (kept from Phase 3) implements just the
// narrow conflicts port — useful for tests and local seams that don't
// touch the booking flow. The wide port has one production
// implementation: `PgAppointmentsRepository`.
//
// Design notes:
//   * **Time columns**: `starts_at` / `ends_at` are `timestamptz`. The
//     repository accepts and returns native `Date` objects on the wide
//     domain shape, but `listConflictsForStaff` keeps the original
//     ISO-string contract because that is what the slot computer
//     already threads through. Two shapes (`AppointmentConflict` vs
//     `Appointment`) keep the seams clean.
//   * **Double-booking** is enforced by the exclusion constraint
//     `appointments_no_overlap_excl` defined in migration 0009. A
//     concurrent insert on an overlapping `[starts_at, ends_at)` raises
//     Postgres SQLSTATE `23P01` (`exclusion_violation`). The
//     repository does NOT translate that code — the booking service is
//     responsible for catching the pg error and mapping it to a
//     `SLOT_UNAVAILABLE` domain error. Keeping the repo dumb means
//     transaction-scoped retries / wrapping policy live in one place
//     (the service) instead of leaking into every caller.
//   * **Soft-delete filtering**: list paths (`listConflictsForStaff`,
//     `listForCustomer`, `listForBusiness`) all filter
//     `deleted_at IS NULL`. `findById` deliberately does not — it
//     mirrors `PgMediaRepository.findById` and lets the service layer
//     decide whether a soft-deleted row is in scope (e.g., admin
//     audit views).
//   * **Sorting**: `listForCustomer` / `listForBusiness` order by
//     `starts_at DESC, id DESC`. Most recent first matches the
//     documented mobile UX; `id` is the deterministic tiebreaker.
//   * `setStatus` carries the cancellation metadata (`cancelledBy`,
//     `cancelReason`) so the cancel transition can be applied in a
//     single statement. Other transitions ignore those fields. This
//     keeps the API surface narrow (one mutation method) and the SQL
//     concrete.

import { BaseRepository, RepositoryError } from '../../repositories/baseRepository.js';

// ---------------------------------------------------------------------------
// Slot-computation seam (Phase 3)
// ---------------------------------------------------------------------------

/** A single existing appointment window in UTC. */
export interface AppointmentConflict {
    /** UTC ISO-8601 timestamp of when the appointment starts. */
    readonly startsAt: string;
    /** UTC ISO-8601 timestamp of when the appointment ends. */
    readonly endsAt: string;
}

/**
 * Narrow port used by slot computation. Exposes only the conflict
 * lookup. `SlotService` depends on this rather than the wide
 * `AppointmentsRepository` so its test fakes can stay tiny.
 */
export interface AppointmentConflictsRepository {
    /**
     * Return ACCEPTED appointments for the staff member that overlap
     * the half-open UTC range `[fromUtc, toUtc)`.
     *
     * SQL filter:
     *   * `staff_id = $1`
     *   * `status = 'ACCEPTED'`
     *   * `deleted_at IS NULL`
     *   * `starts_at < $3` (toUtc)
     *   * `ends_at   > $2` (fromUtc)
     */
    listConflictsForStaff(
        staffId: string,
        fromUtc: string,
        toUtc: string,
    ): Promise<readonly AppointmentConflict[]>;
}

// ---------------------------------------------------------------------------
// Booking-flow domain shape
// ---------------------------------------------------------------------------

export type AppointmentStatus =
    | 'REQUESTED'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'CANCELLED'
    | 'COMPLETED'
    | 'NO_SHOW';

export type PaymentMethod = 'CASH' | 'ONLINE_PENDING';

export type CancelledBy = 'CUSTOMER' | 'BUSINESS' | 'ADMIN';

/** Domain shape of an `appointments` row. */
export interface Appointment {
    readonly id: string;
    readonly customerId: string;
    readonly businessId: string;
    readonly serviceId: string;
    readonly staffId: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly status: AppointmentStatus;
    readonly paymentMethod: PaymentMethod;
    readonly priceEtb: number;
    readonly notes: string | null;
    readonly cancelledBy: CancelledBy | null;
    readonly cancelReason: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly deletedAt: Date | null;
}

/** Fields written by `insert`. Status defaults to REQUESTED at the DB. */
export interface InsertAppointmentInput {
    readonly customerId: string;
    readonly businessId: string;
    readonly serviceId: string;
    readonly staffId: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly paymentMethod: PaymentMethod;
    /** Snapshotted at booking time from `services.price_etb`. */
    readonly priceEtb: number;
    readonly notes?: string | null;
}

/**
 * Fields written by `setStatus`. `status` is required; the other
 * fields are accepted on the cancel transition and ignored otherwise.
 * The booking service is responsible for validating that
 * `cancelledBy` / `cancelReason` are only provided alongside
 * `CANCELLED`.
 */
export interface SetStatusInput {
    readonly status: AppointmentStatus;
    readonly cancelledBy?: CancelledBy | null;
    readonly cancelReason?: string | null;
}

/**
 * Fields written by `reschedule`. A reschedule is a customer-initiated
 * move to a new time window; it preserves the row id and current
 * status (typically REQUESTED or ACCEPTED). The exclusion constraint
 * still applies to the new window.
 */
export interface RescheduleAppointmentInput {
    readonly startsAt: Date;
    readonly endsAt: Date;
}

/** Filters accepted by `listForCustomer` / `listForBusiness`. */
export interface ListAppointmentsFilters {
    readonly status?: AppointmentStatus;
    /** Inclusive lower bound on `starts_at`. */
    readonly fromUtc?: Date;
    /** Exclusive upper bound on `starts_at`. */
    readonly toUtc?: Date;
}

/**
 * Filters accepted by the admin-only `listAll`. Cross-business — adds
 * `businessId` and `customerId` to the standard filter set so the
 * admin dashboard can drill into a single business's queue or a
 * single customer's history without standing up dedicated endpoints.
 */
export interface AdminAppointmentFilters {
    readonly status?: AppointmentStatus;
    readonly businessId?: string;
    readonly customerId?: string;
    /** Inclusive lower bound on `starts_at`. */
    readonly fromUtc?: Date;
    /** Exclusive upper bound on `starts_at`. */
    readonly toUtc?: Date;
}

// ---------------------------------------------------------------------------
// Wide port — booking flow
// ---------------------------------------------------------------------------

export interface AppointmentsRepository extends AppointmentConflictsRepository {
    insert(input: InsertAppointmentInput): Promise<Appointment>;
    findById(id: string): Promise<Appointment | null>;
    listForCustomer(
        customerId: string,
        filters: ListAppointmentsFilters,
    ): Promise<readonly Appointment[]>;
    listForBusiness(
        businessId: string,
        filters: ListAppointmentsFilters,
    ): Promise<readonly Appointment[]>;
    setStatus(id: string, input: SetStatusInput): Promise<Appointment>;
    reschedule(
        id: string,
        input: RescheduleAppointmentInput,
    ): Promise<Appointment>;
    /**
     * Admin-only cross-business listing. Filters by any of `status`,
     * `businessId`, `customerId`, `fromUtc`, `toUtc`; all optional.
     * Soft-deleted rows are excluded. Sort matches the existing
     * single-tenant listings: `starts_at DESC, id DESC`. `limit` is
     * clamped at the call site.
     */
    listAll(
        filters: AdminAppointmentFilters,
        limit: number,
    ): Promise<readonly Appointment[]>;
}

// ---------------------------------------------------------------------------
// Stub — narrow port only, used by Phase 3 seams that do not need writes
// ---------------------------------------------------------------------------

/**
 * Always-empty conflict implementation. Kept after Phase 4 because a
 * few seams (local tooling, smoke scripts that never touch the booking
 * flow) want to instantiate `SlotService` without a real database.
 * Only implements the narrow conflicts port — never the wide one.
 */
export class StubAppointmentsRepository implements AppointmentConflictsRepository {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params required by interface.
    async listConflictsForStaff(
        _staffId: string,
        _fromUtc: string,
        _toUtc: string,
    ): Promise<readonly AppointmentConflict[]> {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Postgres implementation — wide port
// ---------------------------------------------------------------------------

interface AppointmentRow {
    id: string;
    customer_id: string;
    business_id: string;
    service_id: string;
    staff_id: string;
    starts_at: Date;
    ends_at: Date;
    status: AppointmentStatus;
    payment_method: PaymentMethod;
    price_etb: string | number;
    notes: string | null;
    cancelled_by: CancelledBy | null;
    cancel_reason: string | null;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
}

interface ConflictRow {
    starts_at: string;
    ends_at: string;
}

const APPOINTMENT_COLUMNS = [
    'id',
    'customer_id',
    'business_id',
    'service_id',
    'staff_id',
    'starts_at',
    'ends_at',
    'status',
    'payment_method',
    'price_etb',
    'notes',
    'cancelled_by',
    'cancel_reason',
    'created_at',
    'updated_at',
    'deleted_at',
].join(', ');

export class PgAppointmentsRepository
    extends BaseRepository
    implements AppointmentsRepository
{
    async listConflictsForStaff(
        staffId: string,
        fromUtc: string,
        toUtc: string,
    ): Promise<readonly AppointmentConflict[]> {
        // Half-open overlap test: a row overlaps `[fromUtc, toUtc)`
        // iff `starts_at < toUtc AND ends_at > fromUtc`. The status
        // filter matches the slot-computer contract — only confirmed
        // bookings block a slot. REQUESTED rows are intentionally NOT
        // counted here so a customer browsing slots sees a holdout
        // disappear only once the business has accepted. (The
        // exclusion constraint covers REQUESTED + ACCEPTED at insert
        // time, so a double-book attempt still fails atomically.)
        const rows = await this.many<ConflictRow>(
            `
            SELECT to_char(starts_at AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                   to_char(ends_at   AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at
              FROM appointments
             WHERE staff_id     = $1
               AND status       = 'ACCEPTED'
               AND deleted_at IS NULL
               AND starts_at    < $3::timestamptz
               AND ends_at      > $2::timestamptz
             ORDER BY starts_at ASC;
            `,
            [staffId, fromUtc, toUtc],
        );
        return rows.map((r) =>
            Object.freeze<AppointmentConflict>({
                startsAt: r.starts_at,
                endsAt: r.ends_at,
            }),
        );
    }

    async insert(input: InsertAppointmentInput): Promise<Appointment> {
        // Status defaults to 'REQUESTED' via the DB column default.
        // SQLSTATE 23P01 (exclusion_violation) escapes upward as a
        // generic pg error; the booking service maps it to a typed
        // `SLOT_UNAVAILABLE` domain error.
        const row = await this.one<AppointmentRow>(
            `
            INSERT INTO appointments (
                customer_id, business_id, service_id, staff_id,
                starts_at, ends_at, payment_method, price_etb, notes
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING ${APPOINTMENT_COLUMNS};
            `,
            [
                input.customerId,
                input.businessId,
                input.serviceId,
                input.staffId,
                input.startsAt,
                input.endsAt,
                input.paymentMethod,
                input.priceEtb,
                input.notes ?? null,
            ],
        );
        return mapRow(row);
    }

    async findById(id: string): Promise<Appointment | null> {
        // No `deleted_at IS NULL` filter — the service layer decides.
        // Mirrors `PgMediaRepository.findById`.
        const row = await this.oneOrNone<AppointmentRow>(
            `SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE id = $1;`,
            [id],
        );
        return row ? mapRow(row) : null;
    }

    async listForCustomer(
        customerId: string,
        filters: ListAppointmentsFilters,
    ): Promise<readonly Appointment[]> {
        return this.listBy('customer_id', customerId, filters);
    }

    async listForBusiness(
        businessId: string,
        filters: ListAppointmentsFilters,
    ): Promise<readonly Appointment[]> {
        return this.listBy('business_id', businessId, filters);
    }

    async setStatus(id: string, input: SetStatusInput): Promise<Appointment> {
        // One UPDATE for every transition. `cancelled_by` /
        // `cancel_reason` are always written (nullable on non-cancel
        // transitions, which the service supplies as null).
        const row = await this.oneOrNone<AppointmentRow>(
            `
            UPDATE appointments
               SET status        = $2,
                   cancelled_by  = $3,
                   cancel_reason = $4
             WHERE id = $1
            RETURNING ${APPOINTMENT_COLUMNS};
            `,
            [id, input.status, input.cancelledBy ?? null, input.cancelReason ?? null],
        );
        if (!row) throw new RepositoryError(`Appointment ${id} not found.`);
        return mapRow(row);
    }

    async reschedule(
        id: string,
        input: RescheduleAppointmentInput,
    ): Promise<Appointment> {
        // Move to a new time window. Exclusion constraint still
        // applies — SQLSTATE 23P01 will surface to the service layer.
        const row = await this.oneOrNone<AppointmentRow>(
            `
            UPDATE appointments
               SET starts_at = $2,
                   ends_at   = $3
             WHERE id = $1
            RETURNING ${APPOINTMENT_COLUMNS};
            `,
            [id, input.startsAt, input.endsAt],
        );
        if (!row) throw new RepositoryError(`Appointment ${id} not found.`);
        return mapRow(row);
    }

    async listAll(
        filters: AdminAppointmentFilters,
        limit: number,
    ): Promise<readonly Appointment[]> {
        const rows = await this.many<AppointmentRow>(
            `
            SELECT ${APPOINTMENT_COLUMNS}
              FROM appointments
             WHERE deleted_at IS NULL
               AND ($1::text        IS NULL OR status      = $1)
               AND ($2::uuid        IS NULL OR business_id = $2)
               AND ($3::uuid        IS NULL OR customer_id = $3)
               AND ($4::timestamptz IS NULL OR starts_at  >= $4)
               AND ($5::timestamptz IS NULL OR starts_at  <  $5)
             ORDER BY starts_at DESC, id DESC
             LIMIT $6;
            `,
            [
                filters.status ?? null,
                filters.businessId ?? null,
                filters.customerId ?? null,
                filters.fromUtc ?? null,
                filters.toUtc ?? null,
                limit,
            ],
        );
        return rows.map(mapRow);
    }

    private async listBy(
        column: 'customer_id' | 'business_id',
        value: string,
        filters: ListAppointmentsFilters,
    ): Promise<readonly Appointment[]> {
        const params: unknown[] = [
            value,
            filters.status ?? null,
            filters.fromUtc ?? null,
            filters.toUtc ?? null,
        ];

        const rows = await this.many<AppointmentRow>(
            `
            SELECT ${APPOINTMENT_COLUMNS}
              FROM appointments
             WHERE ${column}        = $1
               AND deleted_at IS NULL
               AND ($2::text        IS NULL OR status    = $2)
               AND ($3::timestamptz IS NULL OR starts_at >= $3)
               AND ($4::timestamptz IS NULL OR starts_at <  $4)
             ORDER BY starts_at DESC, id DESC;
            `,
            params,
        );
        return rows.map(mapRow);
    }
}

function mapRow(row: AppointmentRow): Appointment {
    return Object.freeze<Appointment>({
        id: row.id,
        customerId: row.customer_id,
        businessId: row.business_id,
        serviceId: row.service_id,
        staffId: row.staff_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: row.status,
        paymentMethod: row.payment_method,
        // `numeric` columns are returned by pg as strings to preserve
        // precision. The MVP UI does not need >2dp arithmetic, so we
        // coerce to Number for ergonomics — same pattern as
        // `PgBusinessRepository.ratingAvg`.
        priceEtb: typeof row.price_etb === 'string' ? Number(row.price_etb) : row.price_etb,
        notes: row.notes,
        cancelledBy: row.cancelled_by,
        cancelReason: row.cancel_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
    });
}
