// EthioLink — AdminCategoryService unit tests.
//
// Closes the Phase 5 admin-service test trio. Covers the same shape
// as `adminBusinessService.test.ts` / `adminUserService.test.ts`,
// plus three category-specific concerns:
//
//   * Slug uniqueness — on `createCategory` via the friendly
//     pre-check path (`AdminCategorySlugTakenError` thrown before
//     any insert), and on `updateCategory` against any other row.
//   * Service-level input validation — slug shape / name shape /
//     sortOrder bounds via `AdminCategoryInvalidInputError`.
//     Parameterized over every bad-shape case from the brief.
//   * No-op patch still records an audit row — `updateCategory(id, {})`
//     mutates nothing in the row but still records admin intent.
//     Same convention `adminBusinessService` uses for redundant
//     transitions.
//
// `deactivateCategory` is the one method that refuses an idempotent
// call (already-inactive row), surfaced as
// `AdminCategoryInvalidTransitionError` — keeps the audit log free
// of no-op DEACTIVATE_CATEGORY noise.
//
// Uses `InMemoryCategoryRepository` (already widened with `insert` /
// `update` / `setIsActive`) and `InMemoryAdminActionRepository`.
// No production code or test-fake changes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UserRole } from '../../shared/adapters/auth/AuthProvider.js';
import {
    AdminForbiddenError,
    type AdminCallerContext,
} from '../../shared/domains/admin/adminBusinessService.js';
import {
    AdminCategoryInvalidInputError,
    AdminCategoryInvalidTransitionError,
    AdminCategoryNotFoundError,
    AdminCategoryService,
    AdminCategorySlugTakenError,
    type CreateCategoryInput,
} from '../../shared/domains/admin/adminCategoryService.js';
import type { Category } from '../../shared/domains/categories/categoryRepository.js';

import { InMemoryAdminActionRepository } from '../_fakes/InMemoryAdminActionRepository.js';
import { InMemoryCategoryRepository } from '../_fakes/InMemoryCategoryRepository.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ADMIN_ID = '22222222-2222-2222-2222-222222222222';
const NON_ADMIN_USER_ID = '33333333-3333-3333-3333-333333333333';

const CAT_ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CAT_ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MISSING_CAT_ID = '99999999-9999-9999-9999-999999999999';

const TARGET_TYPE = 'business_category' as const;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function caller(
    userId: string,
    role: UserRole = 'ADMIN',
): AdminCallerContext {
    return { userId, role };
}

function makeCategory(overrides: Partial<Category> = {}): Category {
    const now = new Date('2026-05-14T12:00:00.000Z');
    return Object.freeze({
        id: CAT_ID_A,
        slug: 'salon',
        name: { en: 'Salon' },
        sortOrder: 0,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    });
}

interface Env {
    readonly service: AdminCategoryService;
    readonly categoryRepo: InMemoryCategoryRepository;
    readonly actionRepo: InMemoryAdminActionRepository;
}

function build(): Env {
    const categoryRepo = new InMemoryCategoryRepository();
    const actionRepo = new InMemoryAdminActionRepository();
    const service = new AdminCategoryService(categoryRepo, actionRepo);
    return { service, categoryRepo, actionRepo };
}

// ---------------------------------------------------------------------------
// createCategory — happy paths + audit contents
// ---------------------------------------------------------------------------

describe('AdminCategoryService.createCategory', () => {
    it('inserts the row and records one CREATE_CATEGORY audit row', async () => {
        const env = build();

        const created = await env.service.createCategory(
            { slug: 'salon', name: { en: 'Salon' }, sortOrder: 1 },
            caller(ADMIN_ID),
            'Initial category.',
        );

        assert.strictEqual(created.slug, 'salon');
        assert.strictEqual(created.name.en, 'Salon');
        assert.strictEqual(created.sortOrder, 1);
        assert.strictEqual(created.isActive, true);
        assert.strictEqual(env.categoryRepo.size(), 1);

        assert.strictEqual(env.actionRepo.size(), 1);
        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, created.id);
        assert.ok(row);
        assert.strictEqual(row.adminUserId, ADMIN_ID);
        assert.strictEqual(row.action, 'CREATE_CATEGORY');
        assert.strictEqual(row.targetType, TARGET_TYPE);
        assert.strictEqual(row.targetId, created.id);
        assert.strictEqual(row.notes, 'Initial category.');
    });

    it('accepts a missing `notes` argument and records `null`', async () => {
        const env = build();
        const created = await env.service.createCategory(
            { slug: 'salon', name: { en: 'Salon' } },
            caller(ADMIN_ID),
        );
        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, created.id);
        assert.ok(row);
        assert.strictEqual(row.notes, null);
    });

    it('defaults sortOrder to 0 when omitted', async () => {
        const env = build();
        const created = await env.service.createCategory(
            { slug: 'spa', name: { en: 'Spa' } },
            caller(ADMIN_ID),
        );
        assert.strictEqual(created.sortOrder, 0);
    });

    it('trims a slug with leading/trailing whitespace', async () => {
        const env = build();
        const created = await env.service.createCategory(
            { slug: '  barber  ', name: { en: 'Barber' } },
            caller(ADMIN_ID),
        );
        assert.strictEqual(created.slug, 'barber');
    });
});

// ---------------------------------------------------------------------------
// createCategory — duplicate slug
// ---------------------------------------------------------------------------

describe('AdminCategoryService.createCategory — duplicate slug', () => {
    it('throws AdminCategorySlugTakenError when a row already owns the slug', async () => {
        const env = build();
        env.categoryRepo.seed(makeCategory({ id: CAT_ID_A, slug: 'salon' }));

        await assert.rejects(
            () =>
                env.service.createCategory(
                    { slug: 'salon', name: { en: 'Other Salon' } },
                    caller(ADMIN_ID),
                ),
            (err: unknown) => {
                assert.ok(err instanceof AdminCategorySlugTakenError);
                assert.strictEqual(err.slug, 'salon');
                return true;
            },
        );
        // No second row, no audit row.
        assert.strictEqual(env.categoryRepo.size(), 1);
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// createCategory — invalid inputs (parameterized)
// ---------------------------------------------------------------------------

describe('AdminCategoryService.createCategory — invalid inputs', () => {
    const VALID_NAME = { en: 'Salon' };

    const BAD_INPUTS: ReadonlyArray<{
        readonly label: string;
        readonly input: {
            readonly slug: unknown;
            readonly name: unknown;
            readonly sortOrder?: unknown;
        };
        readonly expectedField: string;
    }> = [
        {
            label: 'empty slug',
            input: { slug: '', name: VALID_NAME },
            expectedField: 'slug',
        },
        {
            label: 'whitespace-only slug',
            input: { slug: '   ', name: VALID_NAME },
            expectedField: 'slug',
        },
        {
            label: 'non-string slug',
            input: { slug: 42, name: VALID_NAME },
            expectedField: 'slug',
        },
        {
            label: 'oversized slug (>64 chars)',
            input: { slug: 'x'.repeat(65), name: VALID_NAME },
            expectedField: 'slug',
        },
        {
            label: 'name not an object',
            input: { slug: 'ok', name: 'just a string' },
            expectedField: 'name',
        },
        {
            label: 'name is null',
            input: { slug: 'ok', name: null },
            expectedField: 'name',
        },
        {
            label: 'name is an array',
            input: { slug: 'ok', name: ['salon'] },
            expectedField: 'name',
        },
        {
            label: 'missing name.en',
            input: { slug: 'ok', name: {} },
            expectedField: 'name.en',
        },
        {
            label: 'non-string name.en',
            input: { slug: 'ok', name: { en: 42 } },
            expectedField: 'name.en',
        },
        {
            label: 'empty name.en',
            input: { slug: 'ok', name: { en: '' } },
            expectedField: 'name.en',
        },
        {
            label: 'whitespace-only name.en',
            input: { slug: 'ok', name: { en: '   ' } },
            expectedField: 'name.en',
        },
        {
            label: 'oversized name.en (>200 chars)',
            input: { slug: 'ok', name: { en: 'x'.repeat(201) } },
            expectedField: 'name.en',
        },
        {
            label: 'negative sortOrder',
            input: { slug: 'ok', name: VALID_NAME, sortOrder: -1 },
            expectedField: 'sortOrder',
        },
        {
            label: 'non-integer sortOrder',
            input: { slug: 'ok', name: VALID_NAME, sortOrder: 1.5 },
            expectedField: 'sortOrder',
        },
        {
            label: 'NaN sortOrder',
            input: { slug: 'ok', name: VALID_NAME, sortOrder: Number.NaN },
            expectedField: 'sortOrder',
        },
        {
            label: 'non-number sortOrder',
            input: { slug: 'ok', name: VALID_NAME, sortOrder: 'one' },
            expectedField: 'sortOrder',
        },
    ];

    for (const bad of BAD_INPUTS) {
        it(`rejects ${bad.label}`, async () => {
            const env = build();
            await assert.rejects(
                () =>
                    env.service.createCategory(
                        bad.input as unknown as CreateCategoryInput,
                        caller(ADMIN_ID),
                    ),
                (err: unknown) => {
                    assert.ok(err instanceof AdminCategoryInvalidInputError);
                    assert.strictEqual(err.field, bad.expectedField);
                    return true;
                },
            );
            // No row inserted, no audit row written.
            assert.strictEqual(env.categoryRepo.size(), 0);
            assert.strictEqual(env.actionRepo.size(), 0);
        });
    }
});

// ---------------------------------------------------------------------------
// updateCategory — happy paths
// ---------------------------------------------------------------------------

describe('AdminCategoryService.updateCategory', () => {
    it('updates the row and records one UPDATE_CATEGORY audit row', async () => {
        const env = build();
        env.categoryRepo.seed(makeCategory({ id: CAT_ID_A, slug: 'salon' }));

        const updated = await env.service.updateCategory(
            CAT_ID_A,
            { slug: 'salons', name: { en: 'Salons' }, sortOrder: 10 },
            caller(ADMIN_ID),
            'Pluralised.',
        );

        assert.strictEqual(updated.slug, 'salons');
        assert.strictEqual(updated.name.en, 'Salons');
        assert.strictEqual(updated.sortOrder, 10);

        assert.strictEqual(env.actionRepo.size(), 1);
        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, CAT_ID_A);
        assert.ok(row);
        assert.strictEqual(row.adminUserId, ADMIN_ID);
        assert.strictEqual(row.action, 'UPDATE_CATEGORY');
        assert.strictEqual(row.targetType, TARGET_TYPE);
        assert.strictEqual(row.targetId, CAT_ID_A);
        assert.strictEqual(row.notes, 'Pluralised.');
    });

    it('no-op patch (empty body) still writes one UPDATE_CATEGORY audit row', async () => {
        const env = build();
        env.categoryRepo.seed(makeCategory({ id: CAT_ID_A, slug: 'salon' }));

        const before = await env.categoryRepo.findById(CAT_ID_A);
        const updated = await env.service.updateCategory(
            CAT_ID_A,
            {},
            caller(ADMIN_ID),
            'No-op intent.',
        );
        // Repository's no-op behavior returns the existing row unchanged.
        assert.strictEqual(updated.slug, before?.slug);
        assert.strictEqual(updated.name.en, before?.name.en);

        // Audit row written even though the row content didn't move —
        // the log captures admin intent, not row diff.
        assert.strictEqual(env.actionRepo.size(), 1);
        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, CAT_ID_A);
        assert.ok(row);
        assert.strictEqual(row.action, 'UPDATE_CATEGORY');
        assert.strictEqual(row.notes, 'No-op intent.');
    });

    it('updates one field at a time', async () => {
        const env = build();
        env.categoryRepo.seed(
            makeCategory({ id: CAT_ID_A, slug: 'salon', sortOrder: 0 }),
        );

        const updated = await env.service.updateCategory(
            CAT_ID_A,
            { sortOrder: 5 },
            caller(ADMIN_ID),
        );
        assert.strictEqual(updated.slug, 'salon'); // unchanged
        assert.strictEqual(updated.sortOrder, 5);
        assert.strictEqual(env.actionRepo.size(), 1);
    });
});

// ---------------------------------------------------------------------------
// updateCategory — duplicate slug (cross-row)
// ---------------------------------------------------------------------------

describe('AdminCategoryService.updateCategory — duplicate slug', () => {
    it('throws AdminCategorySlugTakenError when another row already owns the slug', async () => {
        const env = build();
        env.categoryRepo.seed(makeCategory({ id: CAT_ID_A, slug: 'salon' }));
        env.categoryRepo.seed(
            makeCategory({
                id: CAT_ID_B,
                slug: 'barber',
                name: { en: 'Barber' },
            }),
        );

        await assert.rejects(
            () =>
                env.service.updateCategory(
                    CAT_ID_B,
                    { slug: 'salon' },
                    caller(ADMIN_ID),
                ),
            (err: unknown) => {
                assert.ok(err instanceof AdminCategorySlugTakenError);
                assert.strictEqual(err.slug, 'salon');
                return true;
            },
        );

        // B's slug unchanged; no audit row.
        const after = await env.categoryRepo.findById(CAT_ID_B);
        assert.strictEqual(after?.slug, 'barber');
        assert.strictEqual(env.actionRepo.size(), 0);
    });

    it('allows a row to keep its own slug on update', async () => {
        const env = build();
        env.categoryRepo.seed(makeCategory({ id: CAT_ID_A, slug: 'salon' }));

        // Updating CAT_ID_A's slug to its existing value must NOT
        // self-collide on the uniqueness check.
        const updated = await env.service.updateCategory(
            CAT_ID_A,
            { slug: 'salon' },
            caller(ADMIN_ID),
        );
        assert.strictEqual(updated.slug, 'salon');
        assert.strictEqual(env.actionRepo.size(), 1);
    });
});

// ---------------------------------------------------------------------------
// deactivateCategory
// ---------------------------------------------------------------------------

describe('AdminCategoryService.deactivateCategory', () => {
    it('flips isActive to false and records one DEACTIVATE_CATEGORY audit row', async () => {
        const env = build();
        env.categoryRepo.seed(makeCategory({ id: CAT_ID_A, isActive: true }));

        const updated = await env.service.deactivateCategory(
            CAT_ID_A,
            caller(ADMIN_ID),
            'Out of scope.',
        );

        assert.strictEqual(updated.isActive, false);
        assert.strictEqual(env.actionRepo.size(), 1);

        const [row] = env.actionRepo.rowsForTarget(TARGET_TYPE, CAT_ID_A);
        assert.ok(row);
        assert.strictEqual(row.adminUserId, ADMIN_ID);
        assert.strictEqual(row.action, 'DEACTIVATE_CATEGORY');
        assert.strictEqual(row.targetType, TARGET_TYPE);
        assert.strictEqual(row.targetId, CAT_ID_A);
        assert.strictEqual(row.notes, 'Out of scope.');
    });

    it('refuses an already-inactive row with InvalidTransitionError', async () => {
        const env = build();
        env.categoryRepo.seed(makeCategory({ id: CAT_ID_A, isActive: false }));

        await assert.rejects(
            () =>
                env.service.deactivateCategory(CAT_ID_A, caller(ADMIN_ID)),
            (err: unknown) => {
                assert.ok(err instanceof AdminCategoryInvalidTransitionError);
                assert.strictEqual(err.attemptedAction, 'DEACTIVATE_CATEGORY');
                assert.strictEqual(err.currentIsActive, false);
                return true;
            },
        );
        // State unchanged, no audit row.
        const after = await env.categoryRepo.findById(CAT_ID_A);
        assert.strictEqual(after?.isActive, false);
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// Missing category
// ---------------------------------------------------------------------------

describe('AdminCategoryService — missing category', () => {
    it('updateCategory throws AdminCategoryNotFoundError for an unknown id', async () => {
        const env = build();

        await assert.rejects(
            () =>
                env.service.updateCategory(
                    MISSING_CAT_ID,
                    { sortOrder: 1 },
                    caller(ADMIN_ID),
                ),
            (err: unknown) => {
                assert.ok(err instanceof AdminCategoryNotFoundError);
                assert.strictEqual(err.categoryId, MISSING_CAT_ID);
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });

    it('deactivateCategory throws AdminCategoryNotFoundError for an unknown id', async () => {
        const env = build();

        await assert.rejects(
            () =>
                env.service.deactivateCategory(
                    MISSING_CAT_ID,
                    caller(ADMIN_ID),
                ),
            (err: unknown) => {
                assert.ok(err instanceof AdminCategoryNotFoundError);
                assert.strictEqual(err.categoryId, MISSING_CAT_ID);
                return true;
            },
        );
        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

// ---------------------------------------------------------------------------
// Authorization — non-ADMIN callers
// ---------------------------------------------------------------------------

describe('AdminCategoryService — authorization', () => {
    const NON_ADMIN_ROLES: UserRole[] = ['CUSTOMER', 'BUSINESS_OWNER'];

    for (const role of NON_ADMIN_ROLES) {
        it(`refuses createCategory when caller role is ${role}`, async () => {
            const env = build();
            await assert.rejects(
                () =>
                    env.service.createCategory(
                        { slug: 'salon', name: { en: 'Salon' } },
                        caller(NON_ADMIN_USER_ID, role),
                    ),
                AdminForbiddenError,
            );
            assert.strictEqual(env.categoryRepo.size(), 0);
            assert.strictEqual(env.actionRepo.size(), 0);
        });

        it(`refuses updateCategory when caller role is ${role}`, async () => {
            const env = build();
            env.categoryRepo.seed(makeCategory({ id: CAT_ID_A }));

            await assert.rejects(
                () =>
                    env.service.updateCategory(
                        CAT_ID_A,
                        { sortOrder: 5 },
                        caller(NON_ADMIN_USER_ID, role),
                    ),
                AdminForbiddenError,
            );
            // State unchanged.
            const after = await env.categoryRepo.findById(CAT_ID_A);
            assert.strictEqual(after?.sortOrder, 0);
            assert.strictEqual(env.actionRepo.size(), 0);
        });

        it(`refuses deactivateCategory when caller role is ${role}`, async () => {
            const env = build();
            env.categoryRepo.seed(makeCategory({ id: CAT_ID_A, isActive: true }));

            await assert.rejects(
                () =>
                    env.service.deactivateCategory(
                        CAT_ID_A,
                        caller(NON_ADMIN_USER_ID, role),
                    ),
                AdminForbiddenError,
            );
            const after = await env.categoryRepo.findById(CAT_ID_A);
            assert.strictEqual(after?.isActive, true);
            assert.strictEqual(env.actionRepo.size(), 0);
        });
    }
});

// ---------------------------------------------------------------------------
// Audit invariant — full surface
// ---------------------------------------------------------------------------

describe('AdminCategoryService — audit-row invariant', () => {
    it('writes one row per successful action, attributed to the calling admin', async () => {
        const env = build();

        // admin A creates → admin B updates → admin A deactivates.
        const created = await env.service.createCategory(
            { slug: 'salon', name: { en: 'Salon' } },
            caller(ADMIN_ID),
            'create',
        );
        await env.service.updateCategory(
            created.id,
            { sortOrder: 10 },
            caller(OTHER_ADMIN_ID),
            'update',
        );
        await env.service.deactivateCategory(
            created.id,
            caller(ADMIN_ID),
            'deactivate',
        );

        assert.strictEqual(env.actionRepo.size(), 3);

        const rows = env.actionRepo.rowsForTarget(TARGET_TYPE, created.id);
        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows[0]?.action, 'CREATE_CATEGORY');
        assert.strictEqual(rows[0]?.adminUserId, ADMIN_ID);
        assert.strictEqual(rows[0]?.notes, 'create');
        assert.strictEqual(rows[1]?.action, 'UPDATE_CATEGORY');
        assert.strictEqual(rows[1]?.adminUserId, OTHER_ADMIN_ID);
        assert.strictEqual(rows[1]?.notes, 'update');
        assert.strictEqual(rows[2]?.action, 'DEACTIVATE_CATEGORY');
        assert.strictEqual(rows[2]?.adminUserId, ADMIN_ID);
        assert.strictEqual(rows[2]?.notes, 'deactivate');

        assert.strictEqual(env.actionRepo.rowsByAdmin(ADMIN_ID).length, 2);
        assert.strictEqual(env.actionRepo.rowsByAdmin(OTHER_ADMIN_ID).length, 1);
    });

    it('writes zero rows when any guard fails before the mutation', async () => {
        const env = build();
        env.categoryRepo.seed(makeCategory({ id: CAT_ID_A, slug: 'salon' }));

        // Invalid input.
        await assert.rejects(
            () =>
                env.service.createCategory(
                    { slug: '', name: { en: 'Salon' } } as unknown as CreateCategoryInput,
                    caller(ADMIN_ID),
                ),
            AdminCategoryInvalidInputError,
        );
        // Wrong role.
        await assert.rejects(
            () =>
                env.service.createCategory(
                    { slug: 'spa', name: { en: 'Spa' } },
                    caller(NON_ADMIN_USER_ID, 'CUSTOMER'),
                ),
            AdminForbiddenError,
        );
        // Missing id.
        await assert.rejects(
            () =>
                env.service.updateCategory(
                    MISSING_CAT_ID,
                    {},
                    caller(ADMIN_ID),
                ),
            AdminCategoryNotFoundError,
        );
        // Duplicate slug.
        await assert.rejects(
            () =>
                env.service.createCategory(
                    { slug: 'salon', name: { en: 'Other Salon' } },
                    caller(ADMIN_ID),
                ),
            AdminCategorySlugTakenError,
        );
        // Already-inactive deactivate.
        const inactive = makeCategory({
            id: CAT_ID_B,
            slug: 'barber',
            isActive: false,
            name: { en: 'Barber' },
        });
        env.categoryRepo.seed(inactive);
        await assert.rejects(
            () => env.service.deactivateCategory(CAT_ID_B, caller(ADMIN_ID)),
            AdminCategoryInvalidTransitionError,
        );

        assert.strictEqual(env.actionRepo.size(), 0);
    });
});

