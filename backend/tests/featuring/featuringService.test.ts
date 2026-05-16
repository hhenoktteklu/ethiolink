// EthioLink — FeaturingService tests.
//
// Phase 9 Track 6 paid-featuring foundation. Drives the service
// through `InMemoryFeaturingRepository` + `InMemoryBusinessRepository`
// + a scriptable `PaymentGateway` stand-in so every state
// transition lands without a real DB or upstream provider.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { FeaturingConfig } from '../../shared/config/loadConfig.js';
import {
    OnlinePaymentsUnavailableError,
    type PaymentAuthorization,
    type PaymentAuthorizationInput,
    type PaymentGateway,
} from '../../shared/adapters/payments/PaymentGateway.js';
import { CashGateway } from '../../shared/adapters/payments/CashGateway.js';
import {
    AlreadyActiveError,
    FeaturingDisabledError,
    FeaturingService,
    NoActiveSubscriptionError,
    PaymentFailedError,
    UnknownPackageError,
} from '../../shared/domains/featuring/featuringService.js';
import type { Business } from '../../shared/domains/businesses/businessRepository.js';

import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';
import { InMemoryFeaturingRepository } from '../_fakes/InMemoryFeaturingRepository.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_ID = '00000000-0000-0000-0000-000000000010';
const ADMIN_ID = '00000000-0000-0000-0000-000000000011';
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

function makeBusiness(
    overrides: Partial<Business> = {},
): Business {
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

/** Scriptable gateway — returns whatever the test asked for. */
class FakeGateway implements PaymentGateway {
    public readonly provider = 'CASH' as const;
    public lastInput: PaymentAuthorizationInput | null = null;

    constructor(
        private readonly behavior:
            | { kind: 'succeed' }
            | { kind: 'pending' }
            | { kind: 'declined'; errorCode: string; errorMessage: string }
            | { kind: 'throw'; error: Error },
    ) {}

    async authorize(
        input: PaymentAuthorizationInput,
    ): Promise<PaymentAuthorization> {
        this.lastInput = input;
        if (this.behavior.kind === 'throw') throw this.behavior.error;
        if (this.behavior.kind === 'succeed') {
            return Object.freeze<PaymentAuthorization>({
                status: 'SUCCEEDED',
                provider: 'CASH',
                providerRef: null,
                rawResponse: null,
                errorCode: null,
                errorMessage: null,
                authorizedAt: new Date().toISOString(),
            });
        }
        if (this.behavior.kind === 'pending') {
            return Object.freeze<PaymentAuthorization>({
                status: 'PENDING',
                provider: 'TELEBIRR',
                providerRef: 'pending-ref-1',
                rawResponse: null,
                errorCode: null,
                errorMessage: null,
                authorizedAt: new Date().toISOString(),
            });
        }
        return Object.freeze<PaymentAuthorization>({
            status: 'FAILED',
            provider: 'TELEBIRR',
            providerRef: null,
            rawResponse: null,
            errorCode: this.behavior.errorCode,
            errorMessage: this.behavior.errorMessage,
            authorizedAt: new Date().toISOString(),
        });
    }

    // Phase 10 — webhook verify path. Not exercised in the
    // service-level suite (the webhook handler ships in a later
    // commit); the implementation echoes the last input's behavior
    // so a future test can assert against it without ceremony.
    async verify(providerRef: string): Promise<PaymentAuthorization> {
        return Object.freeze<PaymentAuthorization>({
            status: 'SUCCEEDED',
            provider: 'TELEBIRR',
            providerRef,
            rawResponse: null,
            errorCode: null,
            errorMessage: null,
            authorizedAt: new Date().toISOString(),
        });
    }
}

interface TestEnv {
    readonly service: FeaturingService;
    readonly featuringRepo: InMemoryFeaturingRepository;
    readonly businessRepo: InMemoryBusinessRepository;
    readonly gateway: FakeGateway;
}

function buildEnv(opts: {
    gateway?: FakeGateway;
    config?: FeaturingConfig;
    now?: Date;
    business?: Business;
} = {}): TestEnv {
    const featuringRepo = new InMemoryFeaturingRepository();
    const businessRepo = new InMemoryBusinessRepository();
    businessRepo.seed(opts.business ?? makeBusiness());
    const gateway = opts.gateway ?? new FakeGateway({ kind: 'succeed' });
    const service = new FeaturingService({
        featuringRepo,
        businessRepo,
        paymentGateway: gateway,
        config: opts.config ?? ENABLED_CONFIG,
        now: opts.now ? () => opts.now! : undefined,
    });
    return { service, featuringRepo, businessRepo, gateway };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeaturingService.listPackages', () => {
    it('returns 7-day + 30-day packages with config prices', () => {
        const { service } = buildEnv();
        const packages = service.listPackages();
        assert.strictEqual(packages.length, 2);
        assert.deepStrictEqual(
            packages.map((p) => p.code).sort(),
            ['FEATURING_30D', 'FEATURING_7D'],
        );
        const seven = packages.find((p) => p.code === 'FEATURING_7D')!;
        const thirty = packages.find((p) => p.code === 'FEATURING_30D')!;
        assert.strictEqual(seven.durationDays, 7);
        assert.strictEqual(seven.priceEtb, 500);
        assert.strictEqual(thirty.durationDays, 30);
        assert.strictEqual(thirty.priceEtb, 1500);
    });

    it('throws FeaturingDisabledError when the env flag is off', () => {
        const { service } = buildEnv({ config: DISABLED_CONFIG });
        assert.throws(() => service.listPackages(), FeaturingDisabledError);
    });
});

describe('FeaturingService.subscribe — happy path', () => {
    it('creates an ACTIVE subscription and projects featured_until', async () => {
        const now = new Date('2026-06-01T00:00:00.000Z');
        const env = buildEnv({ now });

        const { subscription: sub } = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });

        assert.strictEqual(sub.status, 'ACTIVE');
        assert.strictEqual(sub.packageCode, 'FEATURING_7D');
        assert.strictEqual(sub.priceEtb, 500);
        assert.strictEqual(sub.source, 'OWNER_PURCHASE');
        // Duration: 7 days exactly.
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        assert.strictEqual(
            sub.endsAt.getTime() - sub.startsAt.getTime(),
            sevenDaysMs,
        );

        // Featured_until projected onto business_profiles.
        const business = await env.businessRepo.findById(BUSINESS_ID);
        assert.ok(business);
        assert.deepStrictEqual(business.featuredUntil, sub.endsAt);

        // Gateway saw the featuring-purpose input.
        const sentInput = env.gateway.lastInput;
        assert.ok(sentInput);
        assert.strictEqual(sentInput!.purpose, 'FEATURING');
        if (sentInput && sentInput.purpose === 'FEATURING') {
            assert.strictEqual(sentInput.amountEtb, 500);
            assert.strictEqual(sentInput.businessId, BUSINESS_ID);
        }
    });

    it('resolves price + duration from package code (30d)', async () => {
        const env = buildEnv();
        const { subscription: sub } = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_30D',
            callerUserId: OWNER_ID,
        });
        assert.strictEqual(sub.priceEtb, 1500);
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
        assert.strictEqual(
            sub.endsAt.getTime() - sub.startsAt.getTime(),
            thirtyDaysMs,
        );
    });
});

describe('FeaturingService.subscribe — rejection paths', () => {
    it('rejects when featuring is disabled', async () => {
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

    it('rejects unknown package codes', async () => {
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

    it('rejects when an ACTIVE subscription already exists', async () => {
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
        // Featured_until still reflects the first subscription.
        const business = await env.businessRepo.findById(BUSINESS_ID);
        assert.ok(business?.featuredUntil);
    });

    it('surfaces gateway-class errors (unavailable / network)', async () => {
        const env = buildEnv({
            gateway: new FakeGateway({
                kind: 'throw',
                error: new OnlinePaymentsUnavailableError('boom'),
            }),
        });
        await assert.rejects(
            () =>
                env.service.subscribe({
                    businessId: BUSINESS_ID,
                    packageCode: 'FEATURING_7D',
                    callerUserId: OWNER_ID,
                }),
            OnlinePaymentsUnavailableError,
        );
        // The PENDING_PAYMENT row is left in place for the sweep
        // to GC.
        const rows = env.featuringRepo.all();
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0]!.status, 'PENDING_PAYMENT');
    });

    it('translates a FAILED authorization into PaymentFailedError', async () => {
        const env = buildEnv({
            gateway: new FakeGateway({
                kind: 'declined',
                errorCode: 'CARD_DECLINED',
                errorMessage: 'Bank declined.',
            }),
        });
        await assert.rejects(
            () =>
                env.service.subscribe({
                    businessId: BUSINESS_ID,
                    packageCode: 'FEATURING_7D',
                    callerUserId: OWNER_ID,
                }),
            (err: unknown) =>
                err instanceof PaymentFailedError &&
                err.authorization.errorCode === 'CARD_DECLINED',
        );
    });

    it('leaves PENDING_PAYMENT in place when the gateway returns PENDING', async () => {
        const env = buildEnv({
            gateway: new FakeGateway({ kind: 'pending' }),
        });
        const { subscription: sub } = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        // Async upstream — the subscription is created but not yet
        // ACTIVE. featured_until is not projected.
        assert.strictEqual(sub.status, 'PENDING_PAYMENT');
        const business = await env.businessRepo.findById(BUSINESS_ID);
        assert.strictEqual(business?.featuredUntil, null);
    });

    it('Phase 10 — PENDING result carries the authorization for the handler', async () => {
        // The handler needs `authorization.redirectUrl` to surface
        // the Chapa hosted checkout to the mobile client. The
        // service returns both the subscription AND the gateway
        // authorization; this test pins the SubscribeResult shape.
        const env = buildEnv({
            gateway: new FakeGateway({ kind: 'pending' }),
        });
        const result = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        assert.strictEqual(result.authorization.status, 'PENDING');
        assert.strictEqual(result.authorization.providerRef, 'pending-ref-1');
        assert.strictEqual(result.subscription.status, 'PENDING_PAYMENT');
    });

    it('Phase 10 — SUCCEEDED result also carries the authorization', async () => {
        // Even the synchronous SUCCEEDED path returns the
        // authorization so the handler's wire-shape contract is
        // uniform across both branches.
        const env = buildEnv();
        const result = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        assert.strictEqual(result.authorization.status, 'SUCCEEDED');
        assert.strictEqual(result.subscription.status, 'ACTIVE');
    });
});

describe('FeaturingService.activateFromPayment — Phase 10 webhook hook', () => {
    it('transitions PENDING_PAYMENT → ACTIVE and projects featured_until', async () => {
        const env = buildEnv({
            gateway: new FakeGateway({ kind: 'pending' }),
        });
        const { subscription: sub } = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        assert.strictEqual(sub.status, 'PENDING_PAYMENT');

        const activated = await env.service.activateFromPayment(sub.id);
        assert.strictEqual(activated.status, 'ACTIVE');

        const business = await env.businessRepo.findById(BUSINESS_ID);
        assert.deepStrictEqual(business?.featuredUntil, activated.endsAt);
    });

    it('is idempotent — already-ACTIVE call returns the row unchanged', async () => {
        const env = buildEnv();
        const { subscription: sub } = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        assert.strictEqual(sub.status, 'ACTIVE');

        const second = await env.service.activateFromPayment(sub.id);
        assert.strictEqual(second.status, 'ACTIVE');
        assert.strictEqual(second.id, sub.id);
    });

    it('throws NoActiveSubscriptionError on unknown id (sweep already GCed)', async () => {
        const env = buildEnv();
        await assert.rejects(
            () => env.service.activateFromPayment('does-not-exist'),
            (err: unknown) =>
                err instanceof Error && err.name === 'NoActiveSubscriptionError',
        );
    });

    it('throws InvalidActivationStateError on EXPIRED row', async () => {
        const env = buildEnv({
            gateway: new FakeGateway({ kind: 'pending' }),
        });
        const { subscription: sub } = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        // Force the row into a non-PENDING terminal state.
        await env.featuringRepo.setStatus(sub.id, { status: 'EXPIRED' });

        await assert.rejects(
            () => env.service.activateFromPayment(sub.id),
            (err: unknown) =>
                err instanceof Error &&
                err.name === 'InvalidActivationStateError',
        );
    });
});

describe('FeaturingService.subscribe with CashGateway', () => {
    it('end-to-end activates under CashGateway (dev flow)', async () => {
        const env = buildEnv({
            gateway: new CashGateway() as unknown as FakeGateway,
        });
        const { subscription: sub } = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        assert.strictEqual(sub.status, 'ACTIVE');
    });
});

describe('FeaturingService.comp', () => {
    it('creates an ACTIVE row with source=ADMIN_COMP and price 0', async () => {
        const env = buildEnv();
        const sub = await env.service.comp({
            businessId: BUSINESS_ID,
            durationDays: 14,
            adminUserId: ADMIN_ID,
            reason: 'Category launch promo.',
        });
        assert.strictEqual(sub.status, 'ACTIVE');
        assert.strictEqual(sub.source, 'ADMIN_COMP');
        assert.strictEqual(sub.priceEtb, 0);
        // featured_until projected.
        const business = await env.businessRepo.findById(BUSINESS_ID);
        assert.deepStrictEqual(business?.featuredUntil, sub.endsAt);
    });

    it('rejects when an ACTIVE subscription already exists', async () => {
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

    it('rejects invalid durations', async () => {
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
        await assert.rejects(
            () =>
                env.service.comp({
                    businessId: BUSINESS_ID,
                    durationDays: 366,
                    adminUserId: ADMIN_ID,
                    reason: 'Too long.',
                }),
            RangeError,
        );
    });
});

describe('FeaturingService.cancel', () => {
    it('flips ACTIVE to CANCELLED and clears featured_until', async () => {
        const env = buildEnv();
        await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        const cancelled = await env.service.cancel({
            businessId: BUSINESS_ID,
            adminUserId: ADMIN_ID,
            reason: 'Operator override.',
        });
        assert.strictEqual(cancelled.status, 'CANCELLED');
        assert.strictEqual(cancelled.cancelledReason, 'Operator override.');
        assert.ok(cancelled.cancelledAt);

        const business = await env.businessRepo.findById(BUSINESS_ID);
        assert.strictEqual(business?.featuredUntil, null);
    });

    it('throws NoActiveSubscriptionError when nothing is active', async () => {
        const env = buildEnv();
        await assert.rejects(
            () =>
                env.service.cancel({
                    businessId: BUSINESS_ID,
                    adminUserId: ADMIN_ID,
                    reason: 'Nope.',
                }),
            NoActiveSubscriptionError,
        );
    });
});

describe('FeaturingService.expireSweep', () => {
    it('expires past-due ACTIVE rows and clears featured_until', async () => {
        const startsAt = new Date('2026-06-01T00:00:00.000Z');
        const endsAt = new Date('2026-06-08T00:00:00.000Z');
        const env = buildEnv({ now: new Date('2026-07-01T00:00:00.000Z') });
        // Seed an ACTIVE row whose ends_at is in the past.
        env.featuringRepo.seed({
            id: randomUUID(),
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            priceEtb: 500,
            startsAt,
            endsAt,
            status: 'ACTIVE',
            source: 'OWNER_PURCHASE',
            cancelledAt: null,
            cancelledReason: null,
            createdByUserId: OWNER_ID,
            createdAt: startsAt,
            updatedAt: startsAt,
        });
        // Pre-populate the projection so the sweep has something
        // to clear.
        await env.businessRepo.setFeaturedUntil(BUSINESS_ID, endsAt);

        const result = await env.service.expireSweep();

        assert.deepStrictEqual(
            [...result.expiredBusinessIds].sort(),
            [BUSINESS_ID],
        );
        // Business profile's featured_until is recomputed (now null).
        const business = await env.businessRepo.findById(BUSINESS_ID);
        assert.strictEqual(business?.featuredUntil, null);
        // Row flipped to EXPIRED.
        const all = env.featuringRepo.all();
        assert.strictEqual(all.length, 1);
        assert.strictEqual(all[0]!.status, 'EXPIRED');
    });

    it('purges stale PENDING_PAYMENT rows past the 10-minute TTL', async () => {
        const now = new Date('2026-06-01T00:30:00.000Z');
        const env = buildEnv({ now });
        // Stale PENDING row — 20 minutes ago.
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
        const now = new Date('2026-07-01T00:00:00.000Z');
        const env = buildEnv({ now });
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
        assert.strictEqual(second.purgedPendingCount, 0);
    });
});

describe('FeaturingService.listHistoryForBusiness', () => {
    it('returns rows in created_at DESC order', async () => {
        const env = buildEnv();
        const { subscription: first } = await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        // Cancel the first so a second can be created.
        await env.service.cancel({
            businessId: BUSINESS_ID,
            adminUserId: ADMIN_ID,
            reason: 'Make way for #2.',
        });
        const second = await env.service.comp({
            businessId: BUSINESS_ID,
            durationDays: 14,
            adminUserId: ADMIN_ID,
            reason: 'Comp.',
        });

        const history = await env.service.listHistoryForBusiness(
            BUSINESS_ID,
            10,
        );
        // Newest first; both rows present.
        assert.strictEqual(history.length, 2);
        assert.strictEqual(history[0]!.id, second.id);
        assert.strictEqual(history[1]!.id, first.id);
    });
});
