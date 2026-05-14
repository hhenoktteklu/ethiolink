// EthioLink — in-memory `AppointmentsRepository` for tests.
//
// Accepts seeded conflicts and returns the subset matching `staffId`
// whose UTC range overlaps `[fromUtc, toUtc)`. Used wherever a test
// needs to assert the conflict-filtering wiring without standing up
// the Phase 4 `appointments` table.

import type {
    AppointmentConflict,
    AppointmentConflictsRepository,
} from '../../shared/domains/appointments/appointmentsRepository.js';

interface SeededConflict extends AppointmentConflict {
    readonly staffId: string;
}

export class InMemoryAppointmentsRepository implements AppointmentConflictsRepository {
    private readonly conflicts: SeededConflict[] = [];

    /** Seed a conflict for a specific staff member. */
    seed(staffId: string, conflict: AppointmentConflict): void {
        this.conflicts.push({ staffId, ...conflict });
    }

    /** Test helper: total seeded conflicts (across all staff). */
    size(): number {
        return this.conflicts.length;
    }

    async listConflictsForStaff(
        staffId: string,
        fromUtc: string,
        toUtc: string,
    ): Promise<readonly AppointmentConflict[]> {
        return this.conflicts
            .filter((c) => c.staffId === staffId)
            .filter((c) => c.startsAt < toUtc && c.endsAt > fromUtc)
            .map(({ staffId: _omit, ...rest }) => rest);
    }
}
