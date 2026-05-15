// EthioLink — in-memory `AppointmentsRepository` for tests.
//
// Implements the wide `AppointmentsRepository` interface (Phase 4)
// against an in-memory `Appointment[]`. Same semantics as
// `PgAppointmentsRepository` for the bits tests care about:
//
//   * `insert` rejects an exclusion violation with a pg-shaped error
//     `{ code: '23P01', message: 'exclusion_violation' }` so the
//     appointment-service translation path can be exercised without
//     standing up Postgres. Exclusion semantics mirror the
//     migration-0009 EXCLUDE: same `staff_id`, status in
//     ('REQUESTED', 'ACCEPTED'), `deleted_at IS NULL`, overlapping
//     `[starts_at, ends_at)` range.
//   * `findById` does NOT filter `deleted_at` (matches the service
//     contract — that filter is the service's job).
//   * `listForCustomer` / `listForBusiness` filter `deleted_at IS
//     NULL` and sort `starts_at DESC, id DESC`.
//   * `setStatus` and `reschedule` mirror the SQL counterparts.
//   * `listConflictsForStaff` filters status = 'ACCEPTED',
//     `deleted_at IS NULL`, half-open overlap on the requested UTC
//     range.
//
// Test-side knobs (not part of the interface):
//   * `seed(staffId, conflict)` — legacy narrow seeding for the slot
//     service tests; auto-creates a synthetic ACCEPTED Appointment.
//   * `seedAppointment(appointment)` — direct row injection for
//     transition tests.
//   * `failNextInsertWithExclusion()` — one-shot knob to force the
//     next `insert` to throw the pg-shaped exclusion error, useful
//     for testing the race-loss path independently of seeded data.

import { randomUUID } from 'node:crypto';

import { RepositoryError } from '../../shared/repositories/baseRepository.js';
import type {
    AdminAppointmentFilters,
    Appointment,
    AppointmentConflict,
    AppointmentsRepository,
    InsertAppointmentInput,
    ListAppointmentsFilters,
    RescheduleAppointmentInput,
    SetStatusInput,
} from '../../shared/domains/appointments/appointmentsRepository.js';

const ACTIVE_STATUSES = new Set<Appointment['status']>(['REQUESTED', 'ACCEPTED']);

const STUB_BUSINESS_ID = '00000000-0000-0000-0000-000000000bbb';
const STUB_SERVICE_ID = '00000000-0000-0000-0000-000000000555';
const STUB_CUSTOMER_ID = '00000000-0000-0000-0000-000000000ccc';

/**
 * pg-shaped error for `INSERT`s that violate the exclusion
 * constraint. Carries the same `.code` (`'23P01'`) the service's
 * `isExclusionViolation` duck-typer looks for.
 */
class PgExclusionViolationError extends Error {
    public readonly code = '23P01';
    constructor() {
        super('exclusion_violation (in-memory fake)');
        this.name = 'PgExclusionViolationError';
    }
}

export class InMemoryAppointmentsRepository implements AppointmentsRepository {
    private readonly rows: Appointment[] = [];
    private exclusionPrimed = false;

    // ----- Test helpers -----------------------------------------------------

    /**
     * Legacy narrow seeding for the slot-service test surface. Stores
     * a synthetic ACCEPTED appointment whose only used fields are
     * `staffId`, `startsAt`, `endsAt`, `status`, `deletedAt`. All other
     * columns get stub UUIDs / sensible defaults.
     */
    seed(staffId: string, conflict: AppointmentConflict): void {
        const now = new Date();
        this.rows.push(
            Object.freeze<Appointment>({
                id: randomUUID(),
                customerId: STUB_CUSTOMER_ID,
                businessId: STUB_BUSINESS_ID,
                serviceId: STUB_SERVICE_ID,
                staffId,
                startsAt: new Date(conflict.startsAt),
                endsAt: new Date(conflict.endsAt),
                status: 'ACCEPTED',
                paymentMethod: 'CASH',
                priceEtb: 0,
                notes: null,
                cancelledBy: null,
                cancelReason: null,
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
            }),
        );
    }

    /** Direct-injection helper for transition tests. */
    seedAppointment(appointment: Appointment): void {
        this.rows.push(Object.freeze({ ...appointment }));
    }

    /** Total seeded rows (including soft-deleted). */
    size(): number {
        return this.rows.length;
    }

    /**
     * Force the next `insert` to throw a pg-shaped exclusion-violation
     * error. Used to test the SQLSTATE 23P01 → `AppointmentSlotUnavailableError`
     * mapping without arranging a real overlap (the slot service would
     * otherwise hide the conflict from the listing path).
     */
    failNextInsertWithExclusion(): void {
        this.exclusionPrimed = true;
    }

    // ----- AppointmentsRepository surface -----------------------------------

    async listConflictsForStaff(
        staffId: string,
        fromUtc: string,
        toUtc: string,
    ): Promise<readonly AppointmentConflict[]> {
        const from = new Date(fromUtc).getTime();
        const to = new Date(toUtc).getTime();
        return this.rows
            .filter(
                (r) =>
                    r.staffId === staffId &&
                    r.status === 'ACCEPTED' &&
                    r.deletedAt === null &&
                    r.startsAt.getTime() < to &&
                    r.endsAt.getTime() > from,
            )
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
            .map((r) =>
                Object.freeze<AppointmentConflict>({
                    startsAt: r.startsAt.toISOString(),
                    endsAt: r.endsAt.toISOString(),
                }),
            );
    }

    async insert(input: InsertAppointmentInput): Promise<Appointment> {
        if (this.exclusionPrimed) {
            this.exclusionPrimed = false;
            throw new PgExclusionViolationError();
        }
        if (this.overlapsActive(input.staffId, input.startsAt, input.endsAt)) {
            throw new PgExclusionViolationError();
        }
        const now = new Date();
        const row: Appointment = Object.freeze({
            id: randomUUID(),
            customerId: input.customerId,
            businessId: input.businessId,
            serviceId: input.serviceId,
            staffId: input.staffId,
            startsAt: new Date(input.startsAt.getTime()),
            endsAt: new Date(input.endsAt.getTime()),
            status: 'REQUESTED',
            paymentMethod: input.paymentMethod,
            priceEtb: input.priceEtb,
            notes: input.notes ?? null,
            cancelledBy: null,
            cancelReason: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        });
        this.rows.push(row);
        return row;
    }

    async findById(id: string): Promise<Appointment | null> {
        const row = this.rows.find((r) => r.id === id);
        return row ?? null;
    }

    async listForCustomer(
        customerId: string,
        filters: ListAppointmentsFilters,
    ): Promise<readonly Appointment[]> {
        return this.listBy('customerId', customerId, filters);
    }

    async listForBusiness(
        businessId: string,
        filters: ListAppointmentsFilters,
    ): Promise<readonly Appointment[]> {
        return this.listBy('businessId', businessId, filters);
    }

    async setStatus(id: string, input: SetStatusInput): Promise<Appointment> {
        const idx = this.rows.findIndex((r) => r.id === id);
        if (idx === -1) throw new RepositoryError(`Appointment ${id} not found.`);
        const prev = this.rows[idx]!;
        const next: Appointment = Object.freeze({
            ...prev,
            status: input.status,
            cancelledBy: input.cancelledBy ?? null,
            cancelReason: input.cancelReason ?? null,
            updatedAt: new Date(),
        });
        this.rows[idx] = next;
        return next;
    }

    async reschedule(
        id: string,
        input: RescheduleAppointmentInput,
    ): Promise<Appointment> {
        const idx = this.rows.findIndex((r) => r.id === id);
        if (idx === -1) throw new RepositoryError(`Appointment ${id} not found.`);
        const prev = this.rows[idx]!;

        // Mirror the EXCLUDE: a reschedule into a slot already covered
        // by another active row for the same staff member fails. The
        // row being moved is excluded from the check.
        const overlaps = this.rows.some(
            (r) =>
                r.id !== id &&
                r.staffId === prev.staffId &&
                ACTIVE_STATUSES.has(r.status) &&
                r.deletedAt === null &&
                r.startsAt.getTime() < input.endsAt.getTime() &&
                r.endsAt.getTime() > input.startsAt.getTime(),
        );
        if (overlaps) throw new PgExclusionViolationError();

        const next: Appointment = Object.freeze({
            ...prev,
            startsAt: new Date(input.startsAt.getTime()),
            endsAt: new Date(input.endsAt.getTime()),
            updatedAt: new Date(),
        });
        this.rows[idx] = next;
        return next;
    }

    async listAll(
        filters: AdminAppointmentFilters,
        limit: number,
    ): Promise<readonly Appointment[]> {
        const fromTs = filters.fromUtc?.getTime();
        const toTs = filters.toUtc?.getTime();
        return this.rows
            .filter((r) => r.deletedAt === null)
            .filter((r) => filters.status === undefined || r.status === filters.status)
            .filter(
                (r) =>
                    filters.businessId === undefined ||
                    r.businessId === filters.businessId,
            )
            .filter(
                (r) =>
                    filters.customerId === undefined ||
                    r.customerId === filters.customerId,
            )
            .filter((r) => fromTs === undefined || r.startsAt.getTime() >= fromTs)
            .filter((r) => toTs === undefined || r.startsAt.getTime() < toTs)
            .sort(
                (a, b) =>
                    b.startsAt.getTime() - a.startsAt.getTime() ||
                    (a.id < b.id ? 1 : -1),
            )
            .slice(0, limit);
    }

    // ----- Internals --------------------------------------------------------

    private overlapsActive(
        staffId: string,
        startsAt: Date,
        endsAt: Date,
    ): boolean {
        return this.rows.some(
            (r) =>
                r.staffId === staffId &&
                ACTIVE_STATUSES.has(r.status) &&
                r.deletedAt === null &&
                r.startsAt.getTime() < endsAt.getTime() &&
                r.endsAt.getTime() > startsAt.getTime(),
        );
    }

    private listBy(
        column: 'customerId' | 'businessId',
        value: string,
        filters: ListAppointmentsFilters,
    ): readonly Appointment[] {
        const fromTs = filters.fromUtc?.getTime();
        const toTs = filters.toUtc?.getTime();
        return this.rows
            .filter((r) => r[column] === value)
            .filter((r) => r.deletedAt === null)
            .filter((r) => filters.status === undefined || r.status === filters.status)
            .filter((r) => fromTs === undefined || r.startsAt.getTime() >= fromTs)
            .filter((r) => toTs === undefined || r.startsAt.getTime() < toTs)
            .sort(
                (a, b) =>
                    b.startsAt.getTime() - a.startsAt.getTime() ||
                    (a.id < b.id ? 1 : -1),
            );
    }
}
