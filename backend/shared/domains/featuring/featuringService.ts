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
import type { Logger } from '../../logging/logger.js';
import type { BusinessRepository } from '../businesses/businessRepository.js';
import type { PaymentIntentsRepository } from '../payments/paymentIntentsRepository.js';
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

/**
 * Phase 10 — result returned from `subscribe`. The handler returns
 * `subscription` as the canonical view row and surfaces
 * `authorization.redirectUrl` to the mobile client when the gateway
 * went `PENDING` (Chapa hosted checkout). For `SUCCEEDED` outcomes
 * the row is already `ACTIVE` and `authorization.redirectUrl` is
 * `null`. The handler does not need to switch on the status; it
 * reads `authorization.redirectUrl` (nullable) verbatim.
 *
 * The earlier shape returned `FeaturingSubscription` directly; this
 * widening is additive and does not affect the wire shape — only
 * the in-process service surface.
 */
export interface SubscribeResult {
    readonly subscription: FeaturingSubscription;
    readonly authorization: PaymentAuthorization;
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

/**
 * Phase 10 commit 3 — webhook tried to activate a subscription
 * that isn't in `PENDING_PAYMENT`. EXPIRED / CANCELLED / REFUNDED
 * rows can't be reanimated by a late webhook; the handler
 * swallows this as a logical no-op.
 */
export class InvalidActivationStateError extends Error {
    public readonly subscriptionId: string;
    public readonly status: string;
    constructor(subscriptionId: string, status: string) {
        super(
            `Cannot activate featuring subscription ${subscriptionId}: status is ${status}, not PENDING_PAYMENT.`,
        );
        this.name = 'InvalidActivationStateError';
        this.subscriptionId = subscriptionId;
        this.status = status;
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
    /**
     * Phase 10 commit 4 — optional payment-intents repo. When set,
     * `subscribe()` persists a `payment_intents` row whenever the
     * payment gateway returns `PENDING` with a non-null
     * `providerRef` (Chapa hosted checkout). The webhook handler
     * (Phase 10 commit 3) reverse-looks-up via `findByProviderRef`.
     * Cash + synchronous SUCCEEDED outcomes do not write here per
     * `DATABASE_SCHEMA.md`. When unset, the persist is skipped —
     * existing tests + the local-dev path without an online gateway
     * continue working unchanged.
     */
    readonly paymentIntentsRepo?: PaymentIntentsRepository;
    /**
     * Structured logger — used to surface the
     * `payment_intent_repo_missing` warning when an online
     * provider returns PENDING but no repo is wired. Optional so
     * existing tests stay buoyant; a no-op default lands when
     * unset.
     */
    readonly logger?: Logger;
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
    private readonly paymentIntentsRepo: PaymentIntentsRepository | null;
    private readonly logger: Logger | null;

    constructor(deps: FeaturingServiceDeps) {
        this.featuringRepo = deps.featuringRepo;
        this.businessRepo = deps.businessRepo;
        this.paymentGateway = deps.paymentGateway;
        this.config = deps.config;
        this.nowFn = deps.now ?? (() => new Date());
        this.paymentIntentsRepo = deps.paymentIntentsRepo ?? null;
        this.logger = deps.logger ?? null;
    }

    listPackages(): readonly FeaturingPackage[] {
        if (!this.config.enabled) {
            throw new FeaturingDisabledError();
        }
        return packagesFromConfig(this.config);
    }

    async subscribe(input: SubscribeInput): Promise<SubscribeResult> {
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
        //
        //     Phase 10: the handler needs `authorization.redirectUrl`
        //     when PENDING (Chapa hosted checkout), so the service
        //     returns both the row + the authorization. SUCCEEDED
        //     paths return `redirectUrl: null` from the gateway,
        //     which the wire view encodes as a JSON `null`.
        if (authorization.status === 'PENDING') {
            // Phase 10 commit 4 — persist a payment_intents row so
            // the webhook handler can find the subscription via
            // `findByProviderRef`. Gated on a non-null providerRef
            // (Chapa hosted checkout returns one; future async
            // providers should too). The persist is idempotent at
            // the DB layer via `ON CONFLICT (provider_ref) DO
            // NOTHING`.
            if (authorization.providerRef) {
                if (this.paymentIntentsRepo) {
                    try {
                        await this.paymentIntentsRepo.insertOrFindByProviderRef({
                            appointmentId: null,
                            featuringSubscriptionId: pending.id,
                            provider: authorization.provider,
                            amountEtb: pkg.priceEtb,
                            providerRef: authorization.providerRef,
                            status: 'PENDING',
                            rawResponse: authorization.rawResponse ?? null,
                        });
                    } catch (err) {
                        // The subscription row exists in
                        // PENDING_PAYMENT and the gateway already
                        // returned a redirect URL to the owner;
                        // failing to persist the intent leaves the
                        // webhook handler with nothing to find.
                        // Bubble up so the handler 500s and Chapa
                        // can retry the entire flow from a fresh
                        // subscribe attempt.
                        this.logger?.error(
                            'featuring.subscribe.payment_intent_persist_failed',
                            {
                                subscriptionId: pending.id,
                                providerRef: authorization.providerRef,
                                error:
                                    err instanceof Error
                                        ? err.message
                                        : String(err),
                            },
                        );
                        throw err;
                    }
                } else {
                    // Online provider produced PENDING + providerRef
                    // but the operator forgot to wire the repo. The
                    // webhook will arrive and find nothing. Log
                    // loudly; the operator wires the repo or rolls
                    // back to `payments_provider = mock`.
                    this.logger?.error(
                        'featuring.subscribe.payment_intent_repo_missing',
                        {
                            subscriptionId: pending.id,
                            provider: authorization.provider,
                            providerRef: authorization.providerRef,
                        },
                    );
                }
            }
            return Object.freeze<SubscribeResult>({
                subscription: pending,
                authorization,
            });
        }
        if (authorization.status === 'FAILED') {
            throw new PaymentFailedError(authorization);
        }

        const activated = await this.activate(pending.id, input.businessId);
        return Object.freeze<SubscribeResult>({
            subscription: activated,
            authorization,
        });
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

    /**
     * Phase 10 commit 3 — webhook activation hook.
     *
     * Called by the Chapa webhook handler after `verify(tx_ref)`
     * returns SUCCEEDED for a featuring subscription. Looks up the
     * subscription, transitions PENDING_PAYMENT → ACTIVE, and
     * projects `featured_until` onto the business. Idempotent:
     *
     *   * ACTIVE → no-op, returns the current row (replayed webhook).
     *   * PENDING_PAYMENT → activate.
     *   * EXPIRED / CANCELLED / REFUNDED → throws
     *     `InvalidActivationStateError`. The webhook handler
     *     catches this and 200s without surfacing the error to
     *     Chapa (a CANCELLED row that's also been refunded
     *     out-of-band is a legitimate operator action; the
     *     webhook is the loser).
     *   * Unknown subscription id → throws
     *     `NoActiveSubscriptionError` (re-used; the handler
     *     swallows it as a logical no-op).
     */
    async activateFromPayment(
        subscriptionId: string,
    ): Promise<FeaturingSubscription> {
        const existing = await this.featuringRepo.findById(subscriptionId);
        if (!existing) {
            throw new NoActiveSubscriptionError(subscriptionId);
        }
        if (existing.status === 'ACTIVE') {
            // Idempotent — webhook replay against an already-active
            // subscription. The featured_until projection is also
            // idempotent so we deliberately skip the recompute.
            return existing;
        }
        if (existing.status !== 'PENDING_PAYMENT') {
            throw new InvalidActivationStateError(
                subscriptionId,
                existing.status,
            );
        }
        return this.activate(subscriptionId, existing.businessId);
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
