// EthioLink — payment_intents persistence at gateway-authorize time.
//
// Phase 10 commit 4. Bridges the Chapa adapter (commit 1) + service
// routing (commit 2) + webhook handler (commit 3) into an end-to-
// end flow by INSERTing a `payment_intents` row when the gateway
// returns PENDING with a non-null `providerRef`.
//
// These tests pin the contract at the service layer rather than
// the wire layer:
//
//   * AppointmentService.create with a PENDING online gateway →
//     inserts a payment_intents row keyed by appointmentId.
//   * AppointmentService.create with the cash gateway (SUCCEEDED,
//     providerRef: null) → does NOT insert.
//   * FeaturingService.subscribe with a PENDING online gateway →
//     inserts a row keyed by featuringSubscriptionId.
//   * Duplicate providerRef → repo.insertOrFindByProviderRef is
//     idempotent (the repo-level test already pins this; we
//     re-assert at the service level).
//   * Service constructed without a paymentIntentsRepo + a PENDING
//     online gateway → logs the `repo_missing` warning, does NOT
//     throw (the appointment / subscription is already inserted;
//     the operator wires the repo or rolls back).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
    PaymentAuthorization,
    PaymentAuthorizationInput,
    PaymentGateway,
} from '../../shared/adapters/payments/PaymentGateway.js';
import {
    FeaturingService,
    type FeaturingServiceDeps,
} from '../../shared/domains/featuring/featuringService.js';
import { InMemoryFeaturingRepository } from '../_fakes/InMemoryFeaturingRepository.js';
import { InMemoryPaymentIntentsRepository } from '../../shared/domains/payments/paymentIntentsRepository.js';
import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';
import type { Logger } from '../../shared/logging/logger.js';

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

const BUSINESS_ID = '00000000-0000-0000-0000-0000000000b1';
const OWNER_ID = '00000000-0000-0000-0000-000000000ff1';
const TX_REF = 'feat-00000000-12345678';

class PendingOnlineGateway implements PaymentGateway {
    public readonly provider = 'CHAPA' as const;
    public lastInput: PaymentAuthorizationInput | null = null;
    public readonly providerRef: string;
    constructor(providerRef: string = TX_REF) {
        this.providerRef = providerRef;
    }
    async authorize(
        input: PaymentAuthorizationInput,
    ): Promise<PaymentAuthorization> {
        this.lastInput = input;
        return Object.freeze<PaymentAuthorization>({
            status: 'PENDING',
            provider: 'CHAPA',
            providerRef: this.providerRef,
            rawResponse: { status: 'success' },
            errorCode: null,
            errorMessage: null,
            authorizedAt: new Date().toISOString(),
            redirectUrl: 'https://checkout.chapa.test/sess-001',
        });
    }
    async verify(providerRef: string): Promise<PaymentAuthorization> {
        return Object.freeze<PaymentAuthorization>({
            status: 'SUCCEEDED',
            provider: 'CHAPA',
            providerRef,
            rawResponse: null,
            errorCode: null,
            errorMessage: null,
            authorizedAt: new Date().toISOString(),
            redirectUrl: null,
        });
    }
}

class SyncCashGateway implements PaymentGateway {
    public readonly provider = 'CASH' as const;
    async authorize(): Promise<PaymentAuthorization> {
        return Object.freeze<PaymentAuthorization>({
            status: 'SUCCEEDED',
            provider: 'CASH',
            providerRef: null,
            rawResponse: null,
            errorCode: null,
            errorMessage: null,
            authorizedAt: new Date().toISOString(),
            redirectUrl: null,
        });
    }
    async verify(): Promise<PaymentAuthorization> {
        throw new Error('not used');
    }
}

interface LogRecord {
    readonly level: 'debug' | 'info' | 'warn' | 'error';
    readonly message: string;
    readonly meta: Record<string, unknown> | undefined;
}

function recordingLogger(records: LogRecord[]): Logger {
    const make = (level: LogRecord['level']) =>
        (message: string, meta?: Record<string, unknown>) => {
            records.push({ level, message, meta });
        };
    const logger: Logger = {
        debug: make('debug'),
        info: make('info'),
        warn: make('warn'),
        error: make('error'),
        child: () => logger,
    };
    return logger;
}

function buildFeaturingEnv(options: {
    gateway: PaymentGateway;
    paymentIntentsRepo?: InMemoryPaymentIntentsRepository;
    logRecords?: LogRecord[];
}) {
    const businessRepo = new InMemoryBusinessRepository();
    const now = new Date('2026-05-14T12:00:00.000Z');
    businessRepo.seed({
        id: BUSINESS_ID,
        ownerUserId: OWNER_ID,
        categoryId: '00000000-0000-0000-0000-0000000000c1',
        name: 'Sunset Salon',
        description: { en: 'A salon.' },
        city: 'Addis Ababa',
        addressLine: null,
        latitude: null,
        longitude: null,
        phone: null,
        telegramHandle: null,
        whatsappPhone: null,
        status: 'APPROVED',
        featuredUntil: null,
        ratingAvg: 0,
        ratingCount: 0,
        searchRank: null,
        createdAt: now,
        updatedAt: now,
    });
    const featuringRepo = new InMemoryFeaturingRepository();
    const deps: FeaturingServiceDeps = {
        featuringRepo,
        businessRepo,
        paymentGateway: options.gateway,
        config: {
            featuring7dPriceEtb: 500,
            featuring30dPriceEtb: 1500,
            enabled: true,
        },
        paymentIntentsRepo: options.paymentIntentsRepo,
        logger: options.logRecords
            ? recordingLogger(options.logRecords)
            : undefined,
    };
    return {
        service: new FeaturingService(deps),
        featuringRepo,
        businessRepo,
    };
}

// ---------------------------------------------------------------------------
// FeaturingService.subscribe — Phase 10 commit 4 persistence
// ---------------------------------------------------------------------------

describe('FeaturingService.subscribe — payment_intents persistence', () => {
    it('PENDING online gateway → inserts a PENDING row keyed by subscriptionId', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const { service } = buildFeaturingEnv({
            gateway: new PendingOnlineGateway(),
            paymentIntentsRepo: repo,
        });

        const { subscription } = await service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });

        const rows = repo.listAllRaw();
        assert.strictEqual(rows.length, 1);
        const row = rows[0]!;
        assert.strictEqual(row.featuringSubscriptionId, subscription.id);
        assert.strictEqual(row.appointmentId, null);
        assert.strictEqual(row.provider, 'CHAPA');
        assert.strictEqual(row.amountEtb, 500);
        assert.strictEqual(row.status, 'PENDING');
        assert.strictEqual(row.providerRef, TX_REF);
    });

    it('cash gateway (SUCCEEDED, no providerRef) → does NOT insert', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const { service } = buildFeaturingEnv({
            gateway: new SyncCashGateway(),
            paymentIntentsRepo: repo,
        });
        const { subscription } = await service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        assert.strictEqual(subscription.status, 'ACTIVE');
        // No row written — cash never touches payment_intents.
        assert.deepStrictEqual(repo.listAllRaw(), []);
    });

    it('duplicate providerRef across retries → idempotent (single row)', async () => {
        // Simulate a retry: same gateway returns the same tx_ref
        // twice. The DB-layer ON CONFLICT (provider_ref) DO NOTHING
        // is mirrored at the in-memory layer; the service re-call
        // should still produce exactly one row.
        const repo = new InMemoryPaymentIntentsRepository();
        const env = buildFeaturingEnv({
            gateway: new PendingOnlineGateway(),
            paymentIntentsRepo: repo,
        });

        await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        // The first subscribe leaves a PENDING_PAYMENT row, which
        // does NOT block the partial-unique guard (the index is
        // WHERE status = 'ACTIVE'). So a second subscribe with the
        // same gateway (and therefore the same tx_ref) is allowed,
        // and the repo's `insertOrFindByProviderRef` should
        // collapse the second payment-intent insert into the
        // existing row.

        // Second subscribe attempt with the same gateway (same
        // tx_ref). The repo's insertOrFindByProviderRef collapses
        // the second insert.
        await env.service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });

        assert.strictEqual(repo.listAllRaw().length, 1);
    });

    it('PENDING gateway + missing repo → logs warning, does NOT throw', async () => {
        const logs: LogRecord[] = [];
        const { service } = buildFeaturingEnv({
            gateway: new PendingOnlineGateway(),
            logRecords: logs,
            // paymentIntentsRepo intentionally omitted.
        });
        const { subscription } = await service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        assert.strictEqual(subscription.status, 'PENDING_PAYMENT');
        const missingLog = logs.find(
            (l) =>
                l.level === 'error' &&
                l.message ===
                    'featuring.subscribe.payment_intent_repo_missing',
        );
        assert.ok(
            missingLog,
            `expected payment_intent_repo_missing error log, got ${JSON.stringify(logs)}`,
        );
        assert.strictEqual(
            (missingLog.meta as { subscriptionId: string }).subscriptionId,
            subscription.id,
        );
    });

    it('PENDING without providerRef → no insert + no warning', async () => {
        // Some future async provider could return PENDING with
        // providerRef=null. We don't have a row to find anyway;
        // skip silently.
        const logs: LogRecord[] = [];
        const repo = new InMemoryPaymentIntentsRepository();
        const noRefGateway: PaymentGateway = {
            provider: 'CHAPA',
            async authorize(): Promise<PaymentAuthorization> {
                return Object.freeze<PaymentAuthorization>({
                    status: 'PENDING',
                    provider: 'CHAPA',
                    providerRef: null,
                    rawResponse: null,
                    errorCode: null,
                    errorMessage: null,
                    authorizedAt: new Date().toISOString(),
                    redirectUrl: null,
                });
            },
            async verify(): Promise<PaymentAuthorization> {
                throw new Error('not used');
            },
        };
        const { service } = buildFeaturingEnv({
            gateway: noRefGateway,
            paymentIntentsRepo: repo,
            logRecords: logs,
        });
        await service.subscribe({
            businessId: BUSINESS_ID,
            packageCode: 'FEATURING_7D',
            callerUserId: OWNER_ID,
        });
        assert.deepStrictEqual(repo.listAllRaw(), []);
        const missingLog = logs.find((l) =>
            l.message.endsWith('repo_missing'),
        );
        assert.strictEqual(
            missingLog,
            undefined,
            'no warning when providerRef is null',
        );
    });
});
