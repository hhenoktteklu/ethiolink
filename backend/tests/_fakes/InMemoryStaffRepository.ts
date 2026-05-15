// EthioLink — in-memory `StaffRepository` for tests.
//
// Mirrors `PgStaffRepository` semantics: same insert / update / setIsActive
// / findById / listActiveForBusiness surface, same no-op-on-empty-patch
// rule, same listing order (`created_at ASC, id ASC`).

import { randomUUID } from 'node:crypto';

import { RepositoryError } from '../../shared/repositories/baseRepository.js';
import type {
    InsertStaffInput,
    StaffMember,
    StaffRepository,
    UpdateStaffFields,
} from '../../shared/domains/staff/staffRepository.js';

const PATCH_KEYS: ReadonlyArray<keyof UpdateStaffFields> = ['displayName', 'role'];

export class InMemoryStaffRepository implements StaffRepository {
    private readonly rowsById = new Map<string, StaffMember>();

    /**
     * Test seed: bypass `insert` to fix the id / timestamps / isActive.
     * Useful when a test needs a deterministic `createdAt` (e.g. asserting
     * the `createdAt ASC, id ASC` listing order — two back-to-back
     * `insert` calls can collapse onto the same millisecond and then
     * fall through to the random-UUID tiebreaker).
     */
    seed(staff: StaffMember): void {
        this.rowsById.set(staff.id, Object.freeze({ ...staff }));
    }

    size(): number {
        return this.rowsById.size;
    }

    async insert(input: InsertStaffInput): Promise<StaffMember> {
        const now = new Date();
        const row: StaffMember = Object.freeze({
            id: randomUUID(),
            businessId: input.businessId,
            displayName: input.displayName,
            role: input.role ?? null,
            isActive: true,
            createdAt: now,
            updatedAt: now,
        });
        this.rowsById.set(row.id, row);
        return row;
    }

    async update(id: string, patch: UpdateStaffFields): Promise<StaffMember> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`Staff member ${id} not found.`);
        }

        const hasAny = PATCH_KEYS.some((k) => patch[k] !== undefined);
        if (!hasAny) {
            return existing;
        }

        const next: { [K in keyof StaffMember]: StaffMember[K] } = { ...existing };
        for (const key of PATCH_KEYS) {
            const v = patch[key];
            if (v !== undefined) {
                (next as unknown as Record<string, unknown>)[key] = v as unknown;
            }
        }
        next.updatedAt = new Date();
        const frozen = Object.freeze(next) as StaffMember;
        this.rowsById.set(id, frozen);
        return frozen;
    }

    async setIsActive(id: string, isActive: boolean): Promise<StaffMember> {
        const existing = this.rowsById.get(id);
        if (!existing) {
            throw new RepositoryError(`Staff member ${id} not found.`);
        }
        const next = Object.freeze<StaffMember>({
            ...existing,
            isActive,
            updatedAt: new Date(),
        });
        this.rowsById.set(id, next);
        return next;
    }

    async findById(id: string): Promise<StaffMember | null> {
        return this.rowsById.get(id) ?? null;
    }

    async listActiveForBusiness(businessId: string): Promise<readonly StaffMember[]> {
        return Array.from(this.rowsById.values())
            .filter((s) => s.businessId === businessId && s.isActive)
            .sort((a, b) => {
                const ca = a.createdAt.getTime();
                const cb = b.createdAt.getTime();
                if (ca !== cb) return ca - cb;
                return a.id.localeCompare(b.id);
            });
    }
}
