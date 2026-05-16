// EthioLink — featuring service.
//
// Phase 9 Track 6 — the application rules for paid featuring:
//
//   * `listPackages` returns the two pre-priced options (7-day /
//     30-day) sourced from `config.featuring`. Server-priced;
//     owners never send an amount on the wire.
//   * `subscribe` is the owner-side checkout entry point. It:
//       1. Resolves the package code → price + duration.
//       2. Refuses if the business already has an ACTIVE
//          subscription (`AlreadyActiveError`).
//       3. INSERTs the subscription as `PENDING_PAYMENT`.
//       4. Calls the payment gateway with the featuring-purpose
//          discriminated union.
//       5. On gateway success → transitions to ACTIVE and projects
//          `business_profiles.featured_until = max(existing,
//          new.ends_at)`. Returns the ACTIVE subscription.
//       6. On gateway failure (declined / unavailable) → leaves
//          the subscription PENDING_PAYMENT so the 10-minute sweep
//          can GC it. Re-throws the failure for the handler.
//   * `comp` is the admin-side editorial path. Same shape as
//     `subscribe` but skips the payment gateway entirely and
//     marks the row `source = ADMIN_COMP`.
//   * `cancel` flips an ACTIVE subscription to CANCELLED with a
//     reason + cancellation timestamp, then recomputes
//     `featured_until` (because the next sweep may project a
//     different value if other ACTIVE rows remain — though in
//     MVP that can't happen, the recompute is forward-safe).
//   * `expireSweep` is the EventBridge target: expire ACTIVE rows
//     past `ends_at`, GC PENDING_PAYMENT rows past their TTL, and
//     recompute `featured_until` for every affected business.
//
// Featuring is gated by `config.featuring.enabled`. When `false`,
// every owner-facing method (`listPackages`, `subscribe`) throws
// `FeaturingDisabledError`; `comp`, `cancel`, and `expireSweep`
// run regardless so admins can still curate ACTIVE rows in an
// env where the public rollout hasn't gone live.

import { randomUUID } from 'node:crypto';

import type {
    PaymentAuthorization,
    PaymentGateway,
} from '../../adapters/payments/PaymentGateway.js';
import { PaymentGatewayError } from '../../adapters/payments/PaymentGateway.js';
import type { FeaturingConfig } from '../../config/loadConfig.js';
import type { BusinessRepository } from '../businesses/businessRepository.js';
import type {
    FeaturingPackageCode,
    FeaturingRepository,
    FeaturingSubscription,
} from './featuringRepository.js';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface FeaturingPackage {
    readonly code: FeaturingPackageCode;
    readonly durationDays: number;
    readonly priceEtb: number;
}

export interface SubscribeInput {
    readonly businessId: string;
    readonly packageCode: FeaturingPackageCode;
    readonly callerUserId: string;
}

export interface CompInput {
    readonly businessId: string;
    /** Length of the comp in days. Must be a positive integer ≤ 365. */
    readonly durationDays: number;
    readonly adminUserId: string;
    /** Free-text reason for the comp. Persisted on the audit record by the handler. */
    readonly reason: string;
}

export interface CancelInput {
    readonly businessId: string;
    readonly adminUserId: string;
    readonly reason: string;
}

/** Result returned to the handler after a successful sweep run. */
export interface ExpireSweepResult {
    readonly expiredBusinessIds: readonly string[];
    readonly purgedPendingCount: number;
    readonly recomputedBusinessIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Errors — each maps to a single HTTP status in the handler layer
// ---------------------------------------------------------------------------

export class FeaturingDisabledError extends Error {
    constructor() {
        super('Featuring is not enabled in this environment.');
        this.name = 'FeaturingDisabledError';
    }
}

export class UnknownPackageError extends Error {
    public readonly packageCode: string;
    constructor(packageCode: string) {
        super(`Unknown featuring package: ${packageCode}`);
        this.name = 'UnknownPackageError';
        this.packageCode = packageCode;
    }
}

export class AlreadyActiveError extends Error {
    public readonly businessId: string;
    constructor(businessId: string) {
        super(`Business ${businessId} already has an active featuring subscription.`);
        this.name = 'AlreadyActiveError';
        this.businessId = businessId;
    }
}

export class NoActiveSubscriptionError extends Error {
    public readonly businessId: string;
    constructor(businessId: string) {
        super(`Business ${businessId} has no active featuring subscription.`);
        this.name = 'NoActiveSubscriptionError';
        this.businessId = businessId;
    }
}

export class PaymentFailedError extends Error {
    public readonly authorization: PaymentAuthorization;
    constructor(authorization: PaymentAuthorization) {
        super(authorization.errorMessage ?? 'Payment was declined.');
        this.name = 'PaymentFailedError';
        this.authorization = authorization;
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface FeaturingServiceDeps {
    readonly featuringRepo: FeaturingRepository;
    readonly businessRepo: BusinessRepository;
    readonly paymentGateway: PaymentGateway;
    readonly config: FeaturingConfig;
    /** Injectable clock — tests pass a fixed value. */
    readonly now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const HISTORY_DEFAULT_LIMIT = 50;
const COMP_DURATION_MAX_DAYS = 365;

export class FeaturingService {
    private readonly featuringRepo: FeaturingRepository;
    private readonly businessRepo: BusinessRepository;
    private readonly paymentGateway: PaymentGateway;
    private readonly config: FeaturingConfig;
    private readonly nowFn: () => Date;

    constructor(deps: FeaturingServiceDeps) {
        this.featuringRepo = deps.featuringRepo;
        this.businessRepo = deps.businessRepo;
        this.paymentGateway = deps.paymentGateway;
        this.config = deps.config;
        this.nowFn = deps.now ?? (() => new Date());
    }

    listPackages(): readonly FeaturingPackage[] {
        if (!this.config.enabled) {
            throw new FeaturingDisabledError();
        }
        return packagesFromConfig(this.config);
    }

    async subscribe(input: SubscribeInput): Promise<FeaturingSubscription> {
        if (!this.config.enabled) {
            throw new FeaturingDisabledError();
        }
        const pkg = resolvePackage(this.config, input.packageCode);

        // (1) Reject if there is already an ACTIVE subscription. The
        //     partial unique index is the binding guard; this check
        //     produces a clean domain error before we go anywhere
        //     near the payment gateway.
        const existing = await this.featuringRepo.findActiveByBusinessId(
            input.businessId,
        );
        if (existing) {
            throw new AlreadyActiveError(input.businessId);
        }

        const startsAt = this.nowFn();
        const endsAt = new Date(startsAt.getTime() + pkg.durationDays * DAY_MS);

        // (2) Insert the subscription as PENDING_PAYMENT.
        const pending = await this.featuringRepo.insert({
            businessId: input.businessId,
            packageCode: pkg.code,
            priceEtb: pkg.priceEtb,
            startsAt,
            endsAt,
            status: 'PENDING_PAYMENT',
            source: 'OWNER_PURCHASE',
            createdByUserId: input.callerUserId,
        });

        // (3) Call the payment gateway. CASH succeeds immediately;
        //     MockOnline throws OnlinePaymentsUnavailableError; future
        //     Telebirr returns PENDING + a redirect URL.
        let authorization: PaymentAuthorization;
        try {
            authorization = await this.paymentGateway.authorize({
                purpose: 'FEATURING',
                featuringSubscriptionId: pending.id,
                businessId: input.businessId,
                amountEtb: pkg.priceEtb,
                idempotencyKey: randomUUID(),
            });
        } catch (err) {
            // Gateway-class errors leave the PENDING_PAYMENT row
            // intact for the 10-minute sweep to GC. The error
            // surfaces to the handler.
            if (err instanceof PaymentGatewayError) {
                throw err;
            }
            throw err;
        }

        // (4) Branch on the authorization status. PENDING means an
        //     async upstream — the row stays PENDING_PAYMENT until a
        //     webhook flips it (a future commit). FAILED is a
        //     declined transaction; the row stays PENDING_PAYMENT
        //     for the sweep to GC. SUCCEEDED transitions to ACTIVE
        //     and projects the featured_until column.
        if (authorization.status === 'PENDING') {
            return pending;
        }
        if (authorization.status === 'FAILED') {
            throw new PaymentFailedError(authorization);
        }

        return this.activate(pending.id, input.businessId);
    }

    async comp(input: CompInput): Promise<FeaturingSubscription> {
        if (!Number.isInteger(input.durationDays) || input.durationDays <= 0) {
            throw new RangeError('durationDays must be a positive integer.');
        }
        if (input.durationDays > COMP_DURATION_MAX_DAYS) {
            throw new RangeError(
                `durationDays must be ≤ ${COMP_DURATION_MAX_DAYS}.`,
            );
        }
        const existing = await this.featuringRepo.findActiveByBusinessId(
            input.businessId,
        );
        if (existing) {
            throw new AlreadyActiveError(input.businessId);
        }
        const startsAt = this.nowFn();
        const endsAt = new Date(startsAt.getTime() + input.durationDays * DAY_MS);
        const created = await this.featuringRepo.insert({
            businessId: input.businessId,
            packageCode: 'FEATURING_30D',
            priceEtb: 0,
            startsAt,
            endsAt,
            status: 'ACTIVE',
            source: 'ADMIN_COMP',
            createdByUserId: input.adminUserId,
        });
        await this.recomputeFeaturedUntil(input.businessId);
        return created;
    }

    async cancel(input: CancelInput): Promise<FeaturingSubscription> {
        const active = await this.featuringRepo.findActiveByBusinessId(
            input.businessId,
        );
        if (!active) {
            throw new NoActiveSubscriptionError(input.businessId);
        }
        const updated = await this.featuringRepo.setStatus(active.id, {
            status: 'CANCELLED',
            cancelledAt: this.nowFn(),
            cancelledReason: input.reason,
        });
        await this.recomputeFeaturedUntil(input.businessId);
        return updated;
    }

    async listHistoryForBusiness(
        businessId: string,
        limit: number = HISTORY_DEFAULT_LIMIT,
    ): Promise<readonly FeaturingSubscription[]> {
        return this.featuringRepo.listForBusiness(businessId, limit);
    }

    async expireSweep(): Promise<ExpireSweepResult> {
        const now = this.nowFn();
        const expiredBusinessIds = await this.featuringRepo.expireActive(now);
        const purgedPendingCount = await this.featuringRepo.purgePendingOlderThan(
            new Date(now.getTime() - PENDING_TTL_MS),
        );
        const recomputed: string[] = [];
        for (const businessId of expiredBusinessIds) {
            await this.recomputeFeaturedUntil(businessId);
            recomputed.push(businessId);
        }
        return Object.freeze<ExpireSweepResult>({
            expiredBusinessIds,
            purgedPendingCount,
            recomputedBusinessIds: recomputed,
        });
    }

    // ----- private -----------------------------------------------------------

    private async activate(
        subscriptionId: string,
        businessId: string,
    ): Promise<FeaturingSubscription> {
        const activated = await this.featuringRepo.setStatus(subscriptionId, {
            status: 'ACTIVE',
        });
        await this.recomputeFeaturedUntil(businessId);
        return activated;
    }

    /**
     * Project the max(ends_at) over ACTIVE subscriptions into
     * `business_profiles.featured_until`. Called after every state
     * change that could affect the value (activate / cancel /
     * expire sweep). Idempotent.
     */
    private async recomputeFeaturedUntil(businessId: string): Promise<void> {
        const next = await this.featuringRepo.maxActiveEndsAtForBusiness(
            businessId,
        );
        await this.businessRepo.setFeaturedUntil(businessId, next);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function packagesFromConfig(
    config: FeaturingConfig,
): readonly FeaturingPackage[] {
    return Object.freeze([
        Object.freeze<FeaturingPackage>({
            code: 'FEATURING_7D',
            durationDays: 7,
            priceEtb: config.featuring7dPriceEtb,
        }),
        Object.freeze<FeaturingPackage>({
            code: 'FEATURING_30D',
            durationDays: 30,
            priceEtb: config.featuring30dPriceEtb,
        }),
    ]);
}

function resolvePackage(
    config: FeaturingConfig,
    code: string,
): FeaturingPackage {
    for (const pkg of packagesFromConfig(config)) {
        if (pkg.code === code) return pkg;
    }
    throw new UnknownPackageError(code);
}
