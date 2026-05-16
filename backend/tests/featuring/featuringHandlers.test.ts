// EthioLink — featuring handler + sweep Lambda tests.
//
// Phase 9 Track 6. Exercises the seven HTTP handlers and the
// scheduled sweep Lambda's batch runner against
// `InMemoryFeaturingRepository` + `InMemoryBusinessRepository` +
// scriptable PaymentGateway / AuthProvider stand-ins. The handler
// code reads from process.env + cold-start cached singletons, so
// these tests focus on the service-layer behaviour the handlers
// delegate to — package shape, ownership rules, sweep
// idempotency, and disabled-config gating.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { FeaturingConfig } from '../../shared/config/loadConfig.js';
import { CashGateway } from '../../shared/adapters/payments/CashGateway.js';
import {
    type Business,
    type BusinessRepository,
} from '../../shared/domains/businesses/businessRepository.js';
import {
    AlreadyActiveError,
    FeaturingDisabledError,
    FeaturingService,
    NoActiveSubscriptionError,
    PaymentFailedError,
    UnknownPackageError,
} from '../../shared/domains/featuring/featuringService.js';
import { toFeaturingSubscriptionView } from '../../shared/domains/featuring/featuringView.js';

import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';
import { InMemoryFeaturingRepository } from '../_fakes/InMemoryFeaturingRepository.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_ID = '00000000-0000-0000-0000-000000000010';
const OTHER_OWNER_ID = '00000000-0000-0000-0000-000000000011';
const ADMIN_ID = '00000000-0000-0000-0000-000000000012';
const CATEGORY_ID = '00000000-0000-0000-0000-000000000020';
const BUSINESS_ID = '00000000-0000-0000-0000-000000000030';

const ENABLED_CONFIG: FeaturingConfig = Object.freeze({
    featuring7dPriceEtb: 500,
    featuring30dPriceEtb: 1500,
    enabled: true,
});
const DISABLED_CONFIG: FeaturingConfig = Object.freeze({
    ...ENABLED_CONFIG,
    enabled: false,
});

function makeBusiness(overrides: Partial<Business> = {}): Business {
    const now = new Date('2026-05-14T12:00:00.000Z');
    return Object.freeze({
        id: BUSINESS_ID,
        ownerUserId: OWNER_ID,
        categoryId: CATEGORY_ID,
        name: 'Habesha Beauty Lounge',
        description: { en: 'A salon.' },
        city: 'Addis Ababa',
        addressLine: null,
        latitude: null,
        longitude: null,
        phone: null,
        telegramHandle: null,
        whatsappPhone: null,
        status: 'APPROVED' as const,
        featuredUntil: null,
        ratingAvg: 4.5,
        ratingCount: 10,
        createdAt: now,
        updatedAt: now,
        searchRank: null,
        ...overrides,
    });
}

interface TestEnv {
    readonly service: FeaturingService;
    readonly featuringRepo: InMemoryFeaturingRepository;
    readonly businessRepo: BusinessRepository;
    readonly business: Business;
}

function buildEnv(opts: { config?: FeaturingConfig; now?: Date } = {}): TestEnv {
    const featuringRepo = new InMemoryFeaturingRepository();
    const businessRepo = new InMemoryBusinessRepository();
    const business = makeBusiness();
    (businessRepo as InMemoryBusinessRepository).seed(business);
    const service = new FeaturingService({
        featuringRepo,
        businessRepo,
        paymentGateway: new CashGateway(),
        config: opts.config ?? ENABLED_CONFIG,
        now: opts.now ? () => opts.now! : undefined,
    });
    return { service, featuringRepo, businessRepo, business };
}

/**
 * Mirror the handler's owner-side gating step: confirm the
 * caller is the business owner. Returns true when authorized,
 * false (would-be 403/404) otherwise. The HTTP layer's wiring
 * lives in `lambdas/featuring/_authz.ts`; this helper exercises
 * the same predicate at the unit-test level.
 */
async function authorizeOwner(
    env: TestEnv,
    callerUserId: string,
): Promise<boolean> {
    const fresh = await env.businessRepo.findById(env.business.id);
    return fresh !== null && fresh.ownerUserId === callerUserId;
}

// ---------------------------------------------------------------------------
// Owner: listPackages handler behaviour
// ---------------------------------------------------------------------------

describe('featuring.listPackages — handler-level behaviour', () => {
    it('returns the two packages for an authorized owner', async () => {
        const env = buildEnv();
        assert.strictEqual(await authorizeOwner(env, OWNER_ID), true);
        const packages = env.service.listPackages();
        assert.deepStrictEqual(
            packages.map((p) => p.code).sort(),
            ['FEATURING_30D', 'FEATURING_7D'],
        );
    });

    it('returns 503 (disabled) when config.featuring.enabled is false', () => {
        const env = buildEnv({ config: DISABLED_CONFIG });
        assert.throws(
            () => env.service.listPackages(),
            FeaturingDisabledError,
        );
    });

    it('non-owner caller fails authorization (would-be 404)', async () => {
        const env = buildEnv();
        assert.strictEqual(await authorizeOwner(env, OTHER_OWNER_ID), false);
    });
});

// ---------------------------------------------------------------------------
// Owner: subscribe handler behaviour
// ---------------------------------------------------------------------------

describe('featuring.subscribe — handler-level behaviour', () => {
    it('happy path activates and returns the subscription view', async () => {
        const env = buildEnv();
        const { subscription: sub } = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        const view = toFeaturingSubscriptionView(sub);
        assert.strictEqual(view.status, 'ACTIVE');
        assert.strictEqual(view.priceEtb, 500);
        assert.strictEqual(view.source, 'OWNER_PURCHASE');
        assert.match(view.startsAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    it('rejects unknown packageCode (would-be 400 VALIDATION_ERROR)', async () => {
        const env = buildEnv();
        await assert.rejects(
            () =>
                env.service.subscribe({
                    businessId: BUSINESS_ID,
                    packageCode: 'FEATURING_BOGUS' as 'FEATURING_7D',
                    callerUserId: OWNER_ID,
                }),
            UnknownPackageError,
        );
    });

    it('rejects when business already has an ACTIVE row (would-be 409)', async () => {
        const env = buildEnv();
        await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        await assert.rejects(
            () =>
                env.service.subscribe({
                    businessId: BUSINESS_ID,
                    packageCode: 'FEATURING_30D',
                    callerUserId: OWNER_ID,
                }),
            AlreadyActiveError,
        );
    });

    it('FAILED gateway → PaymentFailedError (would-be 402 PAYMENT_REQUIRED)', async () => {
        const featuringRepo = new InMemoryFeaturingRepository();
        const businessRepo = new InMemoryBusinessRepository();
        businessRepo.seed(makeBusiness());
        const declineGateway = {
            provider: 'CASH' as const,
            async authorize() {
                return Object.freeze({
                    status: 'FAILED' as const,
                    provider: 'CASH' as const,
                    providerRef: null,
                    rawResponse: null,
                    errorCode: 'CARD_DECLINED',
                    errorMessage: 'Bank declined.',
                    authorizedAt: new Date().toISOString(),
                });
            },
            // Phase 10 — PaymentGateway port requires verify. Not
            // exercised in this test (the decline path never reaches
            // a webhook); the no-op throw matches CashGateway's own
            // implementation.
            async verify() {
                throw new Error('verify not used in this test');
            },
        };
        const service = new FeaturingService({
            featuringRepo,
            businessRepo,
            paymentGateway: declineGateway,
            config: ENABLED_CONFIG,
        });
        await assert.rejects(
            () =>
                service.subscribe({
                    businessId: BUSINESS_ID,
                    packageCode: 'FEATURING_7D',
                    callerUserId: OWNER_ID,
                }),
            PaymentFailedError,
        );
        // The PENDING_PAYMENT row is left in place; the sweep
        // would GC it after the 10-minute TTL.
        const rows = featuringRepo.all();
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0]!.status, 'PENDING_PAYMENT');
    });

    it('disabled env → FeaturingDisabledError (would-be 503)', async () => {
        const env = buildEnv({ config: DISABLED_CONFIG });
        await assert.rejects(
            () =>
                env.service.subscribe({
                    businessId: BUSINESS_ID,
                    packageCode: 'FEATURING_7D',
                    callerUserId: OWNER_ID,
                }),
            FeaturingDisabledError,
        );
    });
});

// ---------------------------------------------------------------------------
// Owner: getActive handler behaviour
// ---------------------------------------------------------------------------

describe('featuring.getActive — handler-level behaviour', () => {
    it('returns null when the business has no ACTIVE subscription', async () => {
        const env = buildEnv();
        const active = await env.featuringRepo.findActiveByBusinessId(
            BUSINESS_ID,
        );
        assert.strictEqual(active, null);
    });

    it('returns the ACTIVE subscription view after subscribing', async () => {
        const env = buildEnv();
        await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        const active = await env.featuringRepo.findActiveByBusinessId(
            BUSINESS_ID,
        );
        assert.ok(active);
        assert.strictEqual(active!.status, 'ACTIVE');
        // Independent of `config.featuring.enabled` — even on a
        // disabled env the active row is readable.
    });
});

// ---------------------------------------------------------------------------
// Owner: listHistory handler behaviour
// ---------------------------------------------------------------------------

describe('featuring.listHistory — handler-level behaviour', () => {
    it('returns rows newest-first up to limit', async () => {
        const env = buildEnv();
        const { subscription: first } = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        await env.service.cancel({
            businessId: BUSINESS_ID,
            adminUserId: ADMIN_ID,
            reason: 'Make way.',
        });
        const second = await env.service.comp({
            businessId: BUSINESS_ID,
            durationDays: 7,
            adminUserId: ADMIN_ID,
            reason: 'Promo.',
        });
        const history = await env.service.listHistoryForBusiness(
            BUSINESS_ID,
            10,
        );
        assert.strictEqual(history.length, 2);
        assert.strictEqual(history[0]!.id, second.id);
        assert.strictEqual(history[1]!.id, first.id);
    });
});

// ---------------------------------------------------------------------------
// Admin: comp handler behaviour
// ---------------------------------------------------------------------------

describe('admin.featuring.comp — handler-level behaviour', () => {
    it('creates an ACTIVE row with source=ADMIN_COMP and price 0', async () => {
        const env = buildEnv();
        const sub = await env.service.comp({
            businessId: BUSINESS_ID,
            durationDays: 14,
            adminUserId: ADMIN_ID,
            reason: 'Category launch promo.',
        });
        assert.strictEqual(sub.source, 'ADMIN_COMP');
        assert.strictEqual(sub.priceEtb, 0);
        assert.strictEqual(sub.status, 'ACTIVE');
    });

    it('rejects when an ACTIVE row already exists (would-be 409)', async () => {
        const env = buildEnv();
        await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        await assert.rejects(
            () =>
                env.service.comp({
                    businessId: BUSINESS_ID,
                    durationDays: 14,
                    adminUserId: ADMIN_ID,
                    reason: 'Should fail.',
                }),
            AlreadyActiveError,
        );
    });

    it('rejects invalid durations (would-be 400)', async () => {
        const env = buildEnv();
        await assert.rejects(
            () =>
                env.service.comp({
                    businessId: BUSINESS_ID,
                    durationDays: 0,
                    adminUserId: ADMIN_ID,
                    reason: 'Bad.',
                }),
            RangeError,
        );
    });
});

// ---------------------------------------------------------------------------
// Admin: cancel handler behaviour
// ---------------------------------------------------------------------------

describe('admin.featuring.cancel — handler-level behaviour', () => {
    it('cancels active and clears business.featured_until', async () => {
        const env = buildEnv();
        await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        const cancelled = await env.service.cancel({
            businessId: BUSINESS_ID,
            adminUserId: ADMIN_ID,
            reason: 'Override.',
        });
        assert.strictEqual(cancelled.status, 'CANCELLED');
        const business = await env.businessRepo.findById(BUSINESS_ID);
        assert.strictEqual(business?.featuredUntil, null);
    });

    it('throws NoActiveSubscriptionError when nothing is active (would-be 409)', async () => {
        const env = buildEnv();
        await assert.rejects(
            () =>
                env.service.cancel({
                    businessId: BUSINESS_ID,
                    adminUserId: ADMIN_ID,
                    reason: 'Nothing to cancel.',
                }),
            NoActiveSubscriptionError,
        );
    });
});

// ---------------------------------------------------------------------------
// Scheduled sweep Lambda behaviour
// ---------------------------------------------------------------------------

describe('scheduled.featuringSweep — batch behaviour', () => {
    it('expires past-due ACTIVE rows and returns the right summary', async () => {
        const env = buildEnv({
            now: new Date('2026-07-01T00:00:00.000Z'),
        });
        env.featuringRepo.seed({
            id: randomUUID(),
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            priceEtb: 500,
            startsAt: new Date('2026-06-01T00:00:00.000Z'),
            endsAt: new Date('2026-06-08T00:00:00.000Z'),
            status: 'ACTIVE',
            source: 'OWNER_PURCHASE',
            cancelledAt: null,
            cancelledReason: null,
            createdByUserId: OWNER_ID,
            createdAt: new Date('2026-06-01T00:00:00.000Z'),
            updatedAt: new Date('2026-06-01T00:00:00.000Z'),
        });
        await env.businessRepo.setFeaturedUntil(
            BUSINESS_ID,
            new Date('2026-06-08T00:00:00.000Z'),
        );

        const result = await env.service.expireSweep();

        assert.strictEqual(result.expiredBusinessIds.length, 1);
        assert.strictEqual(result.expiredBusinessIds[0], BUSINESS_ID);
        assert.strictEqual(result.recomputedBusinessIds.length, 1);
        // featured_until cleared.
        const business = await env.businessRepo.findById(BUSINESS_ID);
        assert.strictEqual(business?.featuredUntil, null);
    });

    it('purges PENDING_PAYMENT rows past the 10-minute TTL', async () => {
        const env = buildEnv({ now: new Date('2026-06-01T00:30:00.000Z') });
        env.featuringRepo.seed({
            id: randomUUID(),
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            priceEtb: 500,
            startsAt: new Date('2026-06-01T00:10:00.000Z'),
            endsAt: new Date('2026-06-08T00:10:00.000Z'),
            status: 'PENDING_PAYMENT',
            source: 'OWNER_PURCHASE',
            cancelledAt: null,
            cancelledReason: null,
            createdByUserId: OWNER_ID,
            createdAt: new Date('2026-06-01T00:10:00.000Z'),
            updatedAt: new Date('2026-06-01T00:10:00.000Z'),
        });
        const result = await env.service.expireSweep();
        assert.strictEqual(result.purgedPendingCount, 1);
        assert.strictEqual(env.featuringRepo.size(), 0);
    });

    it('is idempotent — second sweep is a no-op', async () => {
        const env = buildEnv({ now: new Date('2026-07-01T00:00:00.000Z') });
        env.featuringRepo.seed({
            id: randomUUID(),
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            priceEtb: 500,
            startsAt: new Date('2026-06-01T00:00:00.000Z'),
            endsAt: new Date('2026-06-08T00:00:00.000Z'),
            status: 'ACTIVE',
            source: 'OWNER_PURCHASE',
            cancelledAt: null,
            cancelledReason: null,
            createdByUserId: OWNER_ID,
            createdAt: new Date('2026-06-01T00:00:00.000Z'),
            updatedAt: new Date('2026-06-01T00:00:00.000Z'),
        });
        const first = await env.service.expireSweep();
        const second = await env.service.expireSweep();
        assert.strictEqual(first.expiredBusinessIds.length, 1);
        assert.strictEqual(second.expiredBusinessIds.length, 0);
    });
});
