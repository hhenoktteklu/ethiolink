// EthioLink — appointments repository (Phase 3 stub).
//
// The `appointments` table doesn't ship until Phase 4 (booking flow).
// Slot computation needs to filter out time ranges that already have
// an ACCEPTED appointment for the staff member, so the port is defined
// here and a `StubAppointmentsRepository` that always returns an empty
// array is wired into the Phase 3 slot computer. Phase 4 swaps in a
// `PgAppointmentsRepository` against the real table without changing
// any slot-computation call sites.

/** A single existing appointment window in UTC. */
export interface AppointmentConflict {
    /** UTC ISO-8601 timestamp of when the appointment starts. */
    readonly startsAt: string;
    /** UTC ISO-8601 timestamp of when the appointment ends. */
    readonly endsAt: string;
}

export interface AppointmentsRepository {
    /**
     * Return ACCEPTED appointments for the staff member that overlap
     * the half-open UTC range `[fromUtc, toUtc)`.
     *
     * Phase 3 implementation is the stub below; Phase 4 will hit
     * `appointments` filtered by `status = 'ACCEPTED'` and
     * `deleted_at IS NULL`.
     */
    listConflictsForStaff(
        staffId: string,
        fromUtc: string,
        toUtc: string,
    ): Promise<readonly AppointmentConflict[]>;
}

/**
 * Empty-conflict implementation used until the appointments table is
 * created in Phase 4. The slot computer treats this as "no existing
 * appointments" and emits every otherwise-valid candidate slot.
 */
export class StubAppointmentsRepository implements AppointmentsRepository {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params required by interface.
    async listConflictsForStaff(
        _staffId: string,
        _fromUtc: string,
        _toUtc: string,
    ): Promise<readonly AppointmentConflict[]> {
        return [];
    }
}
