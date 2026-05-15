// EthioLink — admin category service.
//
// Admin CRUD for marketplace categories. Same shape as
// `AdminBusinessService` / `AdminUserService`:
//
//   * Caller must be `ADMIN` — re-uses `AdminForbiddenError`.
//   * Audit row appended on success, never on failure.
//   * Typed errors map cleanly to HTTP codes at the handler layer.
//
// Methods:
//   * `createCategory(input, caller, notes?)` →
//     `CREATE_CATEGORY` audit row.
//   * `updateCategory(id, patch, caller, notes?)` →
//     `UPDATE_CATEGORY` audit row. No-op patches still record
//     nothing — there's no mutation to audit.
//   * `deactivateCategory(id, caller, notes?)` → flips `is_active`
//     to `false`. Refuses an already-inactive category with
//     `AdminCategoryInvalidTransitionError` (keeps the audit log
//     free of no-op rows).
//
// Slug uniqueness is enforced at two layers:
//   1. **Pre-check**: `findBySlug` before insert / update so the
//      common case surfaces with a clean `AdminCategorySlugTakenError`
//      and a friendly message.
//   2. **Belt-and-braces**: `setIsActive` / `insert` / `update` may
//      still raise SQLSTATE 23505 if a concurrent caller wins the
//      race. The service catches via `isUniqueViolation` and
//      translates to the same `AdminCategorySlugTakenError`.
//
// Input validation:
//   * `slug` is trimmed, non-empty, max 64 chars. The handler may
//     enforce a stricter regex (`^[a-z][a-z0-9-]*$`); the service is
//     permissive about format and strict about presence so a
//     misbehaving handler can never persist obvious garbage.
//   * `name.en` is trimmed, non-empty. `name.am` (optional) is
//     trimmed.
//   * `sortOrder` (if provided) is a non-negative finite integer.
//
// Atomicity caveat is the same as the other admin services:
// mutation and audit-row insert are two sequential statements.
// Documented; `withTransaction` is the follow-up.

import type { UserRole } from '../../adapters/auth/AuthProvider.js';
import type {
    Category,
    CategoryRepository,
    InsertCategoryInput,
    LocalizedText,
    UpdateCategoryFields,
} from '../categories/categoryRepository.js';

import type {
    AdminAction,
    AdminActionRepository,
} from './adminActionRepository.js';
import {
    type AdminCallerContext,
    AdminForbiddenError,
} from './adminBusinessService.js';

// Re-exports so handlers can import the union of admin caller +
// forbidden error from this module.
export { AdminForbiddenError };
export type { AdminCallerContext };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SLUG_MAX_LEN = 64;
const NAME_MAX_LEN = 200;

/** Postgres SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505';

const TARGET_TYPE = 'business_category' as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** → 404 NOT_FOUND. */
export class AdminCategoryNotFoundError extends Error {
    public readonly categoryId: string;
    constructor(categoryId: string) {
        super(`Category ${categoryId} not found.`);
        this.name = 'AdminCategoryNotFoundError';
        this.categoryId = categoryId;
    }
}

/**
 * Raised for service-level input shape failures: empty slug / name,
 * negative sortOrder, etc. → 400 VALIDATION_ERROR. The handler also
 * performs input parsing; this is the inner guard.
 */
export class AdminCategoryInvalidInputError extends Error {
    public readonly field: string;
    constructor(field: string, message: string) {
        super(message);
        this.name = 'AdminCategoryInvalidInputError';
        this.field = field;
    }
}

/** Raised when a create / update would collide on the UNIQUE slug. → 409 CONFLICT. */
export class AdminCategorySlugTakenError extends Error {
    public readonly slug: string;
    constructor(slug: string) {
        super(`Slug '${slug}' is already in use by another category.`);
        this.name = 'AdminCategorySlugTakenError';
        this.slug = slug;
    }
}

/**
 * Raised when an admin action is not legal given the current state —
 * e.g. deactivating an already-inactive category. → 409 CONFLICT.
 */
export class AdminCategoryInvalidTransitionError extends Error {
    public readonly attemptedAction: AdminAction;
    public readonly currentIsActive: boolean;
    constructor(attemptedAction: AdminAction, currentIsActive: boolean) {
        super(
            `Action ${attemptedAction} is not allowed for a category with isActive=${currentIsActive}.`,
        );
        this.name = 'AdminCategoryInvalidTransitionError';
        this.attemptedAction = attemptedAction;
        this.currentIsActive = currentIsActive;
    }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateCategoryInput {
    readonly slug: string;
    readonly name: LocalizedText;
    readonly sortOrder?: number;
}

export interface UpdateCategoryInput {
    readonly slug?: string;
    readonly name?: LocalizedText;
    readonly sortOrder?: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AdminCategoryService {
    constructor(
        private readonly categoryRepo: CategoryRepository,
        private readonly actionRepo: AdminActionRepository,
    ) {}

    async createCategory(
        input: CreateCategoryInput,
        caller: AdminCallerContext,
        notes?: string | null,
    ): Promise<Category> {
        this.assertAdmin(caller);
        const normalized = this.normalizeInput(input);
        await this.assertSlugAvailable(normalized.slug, null);

        let created: Category;
        try {
            created = await this.categoryRepo.insert(
                normalized satisfies InsertCategoryInput,
            );
        } catch (err) {
            if (isUniqueViolation(err)) {
                throw new AdminCategorySlugTakenError(normalized.slug);
            }
            throw err;
        }
        await this.recordAction(caller, 'CREATE_CATEGORY', created.id, notes);
        return created;
    }

    async updateCategory(
        id: string,
        patch: UpdateCategoryInput,
        caller: AdminCallerContext,
        notes?: string | null,
    ): Promise<Category> {
        this.assertAdmin(caller);
        const existing = await this.findOrThrow(id);
        const normalized = this.normalizePatch(patch);

        if (normalized.slug !== undefined && normalized.slug !== existing.slug) {
            await this.assertSlugAvailable(normalized.slug, id);
        }

        let updated: Category;
        try {
            updated = await this.categoryRepo.update(
                id,
                normalized satisfies UpdateCategoryFields,
            );
        } catch (err) {
            if (isUniqueViolation(err) && normalized.slug !== undefined) {
                throw new AdminCategorySlugTakenError(normalized.slug);
            }
            throw err;
        }
        await this.recordAction(caller, 'UPDATE_CATEGORY', id, notes);
        return updated;
    }

    async deactivateCategory(
        id: string,
        caller: AdminCallerContext,
        notes?: string | null,
    ): Promise<Category> {
        this.assertAdmin(caller);
        const existing = await this.findOrThrow(id);
        if (!existing.isActive) {
            throw new AdminCategoryInvalidTransitionError(
                'DEACTIVATE_CATEGORY',
                existing.isActive,
            );
        }

        const updated = await this.categoryRepo.setIsActive(id, false);
        await this.recordAction(caller, 'DEACTIVATE_CATEGORY', id, notes);
        return updated;
    }

    // ----- Internals --------------------------------------------------------

    private assertAdmin(caller: AdminCallerContext): void {
        if (caller.role !== ('ADMIN' satisfies UserRole)) {
            throw new AdminForbiddenError();
        }
    }

    private async findOrThrow(id: string): Promise<Category> {
        const existing = await this.categoryRepo.findById(id);
        if (!existing) {
            throw new AdminCategoryNotFoundError(id);
        }
        return existing;
    }

    /**
     * Pre-check that no other category already owns `slug`. The
     * second argument is the id to ignore (so an `updateCategory`
     * with the row's own slug doesn't collide with itself); pass
     * `null` for `createCategory`.
     */
    private async assertSlugAvailable(
        slug: string,
        ignoreId: string | null,
    ): Promise<void> {
        const conflict = await this.categoryRepo.findBySlug(slug);
        if (conflict && conflict.id !== ignoreId) {
            throw new AdminCategorySlugTakenError(slug);
        }
    }

    private normalizeInput(input: CreateCategoryInput): CreateCategoryInput {
        return {
            slug: this.assertSlug(input.slug),
            name: this.assertName(input.name),
            sortOrder: this.assertSortOrder(input.sortOrder),
        };
    }

    private normalizePatch(patch: UpdateCategoryInput): UpdateCategoryInput {
        return {
            slug: patch.slug !== undefined ? this.assertSlug(patch.slug) : undefined,
            name: patch.name !== undefined ? this.assertName(patch.name) : undefined,
            sortOrder:
                patch.sortOrder !== undefined
                    ? this.assertSortOrder(patch.sortOrder)
                    : undefined,
        };
    }

    private assertSlug(slug: unknown): string {
        if (typeof slug !== 'string') {
            throw new AdminCategoryInvalidInputError(
                'slug',
                'slug must be a string.',
            );
        }
        const trimmed = slug.trim();
        if (trimmed === '') {
            throw new AdminCategoryInvalidInputError(
                'slug',
                'slug must not be empty.',
            );
        }
        if (trimmed.length > SLUG_MAX_LEN) {
            throw new AdminCategoryInvalidInputError(
                'slug',
                `slug must be ${SLUG_MAX_LEN} characters or fewer.`,
            );
        }
        return trimmed;
    }

    private assertName(name: unknown): LocalizedText {
        if (typeof name !== 'object' || name === null || Array.isArray(name)) {
            throw new AdminCategoryInvalidInputError(
                'name',
                'name must be a LocalizedText object.',
            );
        }
        const obj = name as Record<string, unknown>;
        if (typeof obj.en !== 'string') {
            throw new AdminCategoryInvalidInputError(
                'name.en',
                'name.en must be a string.',
            );
        }
        const en = obj.en.trim();
        if (en === '') {
            throw new AdminCategoryInvalidInputError(
                'name.en',
                'name.en must not be empty.',
            );
        }
        if (en.length > NAME_MAX_LEN) {
            throw new AdminCategoryInvalidInputError(
                'name.en',
                `name.en must be ${NAME_MAX_LEN} characters or fewer.`,
            );
        }
        const out: { en: string; am?: string } = { en };
        if (obj.am !== undefined && obj.am !== null) {
            if (typeof obj.am !== 'string') {
                throw new AdminCategoryInvalidInputError(
                    'name.am',
                    'name.am must be a string.',
                );
            }
            const am = obj.am.trim();
            if (am.length > NAME_MAX_LEN) {
                throw new AdminCategoryInvalidInputError(
                    'name.am',
                    `name.am must be ${NAME_MAX_LEN} characters or fewer.`,
                );
            }
            if (am !== '') out.am = am;
        }
        return out;
    }

    private assertSortOrder(value: number | undefined): number | undefined {
        if (value === undefined) return undefined;
        if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            !Number.isInteger(value) ||
            value < 0
        ) {
            throw new AdminCategoryInvalidInputError(
                'sortOrder',
                'sortOrder must be a non-negative integer.',
            );
        }
        return value;
    }

    private async recordAction(
        caller: AdminCallerContext,
        action: AdminAction,
        categoryId: string,
        notes: string | null | undefined,
    ): Promise<void> {
        await this.actionRepo.insert({
            adminUserId: caller.userId,
            action,
            targetType: TARGET_TYPE,
            targetId: categoryId,
            notes: notes ?? null,
        });
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: unknown }).code === PG_UNIQUE_VIOLATION
    );
}
