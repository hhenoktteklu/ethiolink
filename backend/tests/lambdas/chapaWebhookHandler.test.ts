// EthioLink — Chapa webhook handler tests.
//
// Phase 10 commit 3. Drives `handleWebhook` against an in-memory
// payment_intents repo + a fake gateway. Covers:
//
//   * Signature mismatch → 401.
//   * Missing signature header → 401.
//   * Service not configured (webhookSecret empty) → 503.
//   * Malformed body (signed correctly) → 200 + handled=false.
//   * Missing tx_ref → 200 + handled=false.
//   * Unknown tx_ref → 200 + handled=false, no domain state change.
//   * verify returns SUCCEEDED + featuring row → subscription
//     transitions to ACTIVE, payment_intent flipped to SUCCEEDED.
//   * verify returns SUCCEEDED + appointment row → markPaymentSucceeded
//     called, payment_intent flipped to SUCCEEDED.
//   * verify returns FAILED → payment_intent flipped to FAILED.
//   * verify returns PENDING → 200 + handled=false, no state change.
//   * verify throws ChapaUnavailable → 500.
//   * verify throws ChapaInvalidRequest → 200 + handled=false.
//   * Replay: same webhook delivered twice against SUCCEEDED row →
//     second call is a logical no-op (idempotent).

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import type { APIGatewayProxyEvent } from 'aws-lambda';

import {
    ChapaInvalidRequestError,
    ChapaUnavailableError,
} from '../../shared/adapters/payments/ChapaGateway.js';
import type {
    PaymentAuthorization,
    PaymentGateway,
} from '../../shared/adapters/payments/PaymentGateway.js';
import { handleWebhook } from '../../lambdas/integrations/chapaWebhook.js';
import type { Logger } from '../../shared/logging/logger.js';
import { InMemoryPaymentIntentsRepository } from '../../shared/domains/payments/paymentIntentsRepository.js';

const WEBHOOK_SECRET = 'whsec_test_xxxx';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeGateway implements PaymentGateway {
    public readonly provider = 'CHAPA' as const;
    public verifyCalls: string[] = [];
    constructor(
        private readonly behavior:
            | { kind: 'succeeded' }
            | { kind: 'failed'; message: string }
            | { kind: 'pending' }
            | { kind: 'unavailable' }
            | { kind: 'invalid_request' },
    ) {}

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async authorize(): Promise<PaymentAuthorization> {
        throw new Error('not used in webhook tests');
    }

    async verify(providerRef: string): Promise<PaymentAuthorization> {
        this.verifyCalls.push(providerRef);
        if (this.behavior.kind === 'unavailable') {
            throw new ChapaUnavailableError('upstream timeout');
        }
        if (this.behavior.kind === 'invalid_request') {
            throw new ChapaInvalidRequestError(404, 'tx_ref not found');
        }
        if (this.behavior.kind === 'succeeded') {
            return makeAuth('SUCCEEDED', providerRef);
        }
        if (this.behavior.kind === 'pending') {
            return makeAuth('PENDING', providerRef);
        }
        return {
            ...makeAuth('FAILED', providerRef),
            errorCode: 'CHAPA_DECLINED',
            errorMessage: this.behavior.message,
        };
    }
}

function makeAuth(
    status: PaymentAuthorization['status'],
    providerRef: string,
): PaymentAuthorization {
    return Object.freeze<PaymentAuthorization>({
        status,
        provider: 'CHAPA',
        providerRef,
        rawResponse: { status: status.toLowerCase() },
        errorCode: null,
        errorMessage: null,
        authorizedAt: new Date().toISOString(),
        redirectUrl: null,
    });
}

class FakeFeaturingService {
    public activated: string[] = [];
    public shouldThrow: 'noActive' | 'invalidState' | null = null;
    async activateFromPayment(subscriptionId: string): Promise<unknown> {
        this.activated.push(subscriptionId);
        if (this.shouldThrow === 'noActive') {
            const { NoActiveSubscriptionError } = await import(
                '../../shared/domains/featuring/featuringService.js'
            );
            throw new NoActiveSubscriptionError(subscriptionId);
        }
        if (this.shouldThrow === 'invalidState') {
            const { InvalidActivationStateError } = await import(
                '../../shared/domains/featuring/featuringService.js'
            );
            throw new InvalidActivationStateError(subscriptionId, 'EXPIRED');
        }
        return { id: subscriptionId, status: 'ACTIVE' };
    }
}

class FakeAppointmentService {
    public succeeded: string[] = [];
    public failed: string[] = [];
    async markPaymentSucceeded(appointmentId: string): Promise<void> {
        this.succeeded.push(appointmentId);
    }
    async markPaymentFailed(appointmentId: string): Promise<void> {
        this.failed.push(appointmentId);
    }
}

const NOOP_LOGGER: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => NOOP_LOGGER,
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function signedEvent(
    body: string,
    overrides: { signature?: string; missingSignature?: boolean } = {},
): APIGatewayProxyEvent {
    const expected = createHmac('sha256', WEBHOOK_SECRET)
        .update(body, 'utf8')
        .digest('hex');
    const headers: Record<string, string> = {};
    if (!overrides.missingSignature) {
        headers['Chapa-Signature'] = overrides.signature ?? expected;
    }
    return {
        body,
        headers,
        httpMethod: 'POST',
        path: '/v1/integrations/chapa/webhook',
        pathParameters: null,
        queryStringParameters: null,
        multiValueHeaders: {},
        multiValueQueryStringParameters: null,
        isBase64Encoded: false,
        resource: '',
        stageVariables: null,
        requestContext: {
            requestId: 'req-1',
            path: '',
            stage: '',
            httpMethod: 'POST',
        } as APIGatewayProxyEvent['requestContext'],
    };
}

function buildDeps(
    overrides: {
        gateway?: FakeGateway;
        featuringService?: FakeFeaturingService;
        appointmentService?: FakeAppointmentService;
        paymentIntentsRepo?: InMemoryPaymentIntentsRepository;
        webhookSecret?: string;
        paymentGateway?: PaymentGateway | null;
    } = {},
) {
    const repo =
        overrides.paymentIntentsRepo ?? new InMemoryPaymentIntentsRepository();
    const gateway = overrides.gateway ?? new FakeGateway({ kind: 'succeeded' });
    const featuringService =
        overrides.featuringService ?? new FakeFeaturingService();
    const appointmentService =
        overrides.appointmentService ?? new FakeAppointmentService();
    return {
        deps: {
            webhookSecret:
                overrides.webhookSecret === undefined
                    ? WEBHOOK_SECRET
                    : overrides.webhookSecret,
            paymentGateway:
                overrides.paymentGateway === undefined
                    ? (gateway as unknown as PaymentGateway)
                    : overrides.paymentGateway,
            paymentIntentsRepo: repo,
            featuringService:
                featuringService as unknown as import('../../shared/domains/featuring/featuringService.js').FeaturingService,
            appointmentService:
                appointmentService as unknown as import('../../shared/domains/appointments/appointmentService.js').AppointmentService,
            logger: NOOP_LOGGER,
        },
        repo,
        gateway,
        featuringService,
        appointmentService,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chapaWebhook — signature gate', () => {
    it('401 on signature mismatch', async () => {
        const { deps } = buildDeps();
        const body = JSON.stringify({ tx_ref: 'apt-1-aaaaaaaa' });
        const res = await handleWebhook(
            deps,
            signedEvent(body, { signature: 'deadbeef' }),
        );
        assert.strictEqual(res.statusCode, 401);
        const parsed = JSON.parse(res.body) as { error: { code: string } };
        assert.strictEqual(parsed.error.code, 'UNAUTHENTICATED');
    });

    it('401 when signature header is missing', async () => {
        const { deps } = buildDeps();
        const res = await handleWebhook(
            deps,
            signedEvent('{}', { missingSignature: true }),
        );
        assert.strictEqual(res.statusCode, 401);
    });

    it('accepts sha256= prefixed signatures', async () => {
        const { deps, gateway } = buildDeps();
        const body = JSON.stringify({ tx_ref: 'apt-1-aaaaaaaa' });
        const expected = createHmac('sha256', WEBHOOK_SECRET)
            .update(body, 'utf8')
            .digest('hex');
        const res = await handleWebhook(
            deps,
            signedEvent(body, { signature: `sha256=${expected}` }),
        );
        // No row exists yet — still returns 200 (unknown_tx_ref), but
        // the verify call DID happen, which proves the signature
        // gate passed.
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(gateway.verifyCalls.length, 1);
    });
});

describe('chapaWebhook — service gating', () => {
    it('503 when chapa is not configured (empty secret)', async () => {
        const { deps } = buildDeps({ webhookSecret: '' });
        const body = JSON.stringify({ tx_ref: 'apt-1' });
        const res = await handleWebhook(deps, signedEvent(body));
        assert.strictEqual(res.statusCode, 503);
    });

    it('503 when chapa is not configured (null gateway)', async () => {
        const { deps } = buildDeps({ paymentGateway: null });
        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ tx_ref: 'apt-1' })),
        );
        assert.strictEqual(res.statusCode, 503);
    });
});

describe('chapaWebhook — body validation', () => {
    it('200 + handled=false on malformed body', async () => {
        const { deps } = buildDeps();
        const res = await handleWebhook(deps, signedEvent('not json {{{'));
        assert.strictEqual(res.statusCode, 200);
        const parsed = JSON.parse(res.body) as {
            handled: boolean;
            reason: string;
        };
        assert.strictEqual(parsed.handled, false);
        assert.strictEqual(parsed.reason, 'malformed_body');
    });

    it('200 + handled=false on missing tx_ref', async () => {
        const { deps, gateway } = buildDeps();
        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ data: {} })),
        );
        assert.strictEqual(res.statusCode, 200);
        const parsed = JSON.parse(res.body) as {
            handled: boolean;
            reason: string;
        };
        assert.strictEqual(parsed.handled, false);
        assert.strictEqual(parsed.reason, 'missing_tx_ref');
        // Verify wasn't called — we never got far enough.
        assert.strictEqual(gateway.verifyCalls.length, 0);
    });

    it('accepts tx_ref nested under data.tx_ref', async () => {
        const { deps, gateway } = buildDeps();
        const body = JSON.stringify({ data: { tx_ref: 'feat-1-zzzz' } });
        const res = await handleWebhook(deps, signedEvent(body));
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(gateway.verifyCalls, ['feat-1-zzzz']);
    });
});

describe('chapaWebhook — unknown tx_ref', () => {
    it('200 + handled=false when no payment_intents row matches', async () => {
        const { deps, gateway, featuringService } = buildDeps();
        const body = JSON.stringify({ tx_ref: 'feat-orphan-aaaaaaaa' });
        const res = await handleWebhook(deps, signedEvent(body));
        assert.strictEqual(res.statusCode, 200);
        const parsed = JSON.parse(res.body) as {
            handled: boolean;
            reason: string;
        };
        assert.strictEqual(parsed.handled, false);
        assert.strictEqual(parsed.reason, 'unknown_tx_ref');
        // Verify call happened (after signature) but no domain
        // dispatch fired.
        assert.strictEqual(gateway.verifyCalls.length, 1);
        assert.strictEqual(featuringService.activated.length, 0);
    });
});

describe('chapaWebhook — SUCCEEDED', () => {
    it('featuring row → activates subscription + marks intent SUCCEEDED', async () => {
        const { deps, repo, featuringService } = buildDeps();
        const row = await repo.insertOrFindByProviderRef({
            appointmentId: null,
            featuringSubscriptionId: 'sub-1',
            provider: 'CHAPA',
            amountEtb: 500,
            providerRef: 'feat-sub-1-aaaa',
        });

        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ tx_ref: 'feat-sub-1-aaaa' })),
        );
        assert.strictEqual(res.statusCode, 200);
        const parsed = JSON.parse(res.body) as {
            handled: boolean;
            status: string;
        };
        assert.strictEqual(parsed.handled, true);
        assert.strictEqual(parsed.status, 'SUCCEEDED');

        // Subscription activation triggered.
        assert.deepStrictEqual(featuringService.activated, ['sub-1']);
        // Intent row flipped.
        const updated = (await repo.findByProviderRef('feat-sub-1-aaaa'))!;
        assert.strictEqual(updated.status, 'SUCCEEDED');
        assert.strictEqual(updated.id, row.id);
    });

    it('appointment row → markPaymentSucceeded + marks intent SUCCEEDED', async () => {
        const { deps, repo, appointmentService, featuringService } = buildDeps();
        await repo.insertOrFindByProviderRef({
            appointmentId: 'apt-1',
            featuringSubscriptionId: null,
            provider: 'CHAPA',
            amountEtb: 300,
            providerRef: 'apt-1-bbbb',
        });

        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ tx_ref: 'apt-1-bbbb' })),
        );
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(appointmentService.succeeded, ['apt-1']);
        assert.deepStrictEqual(featuringService.activated, []);
        const updated = (await repo.findByProviderRef('apt-1-bbbb'))!;
        assert.strictEqual(updated.status, 'SUCCEEDED');
    });

    it('swallows NoActiveSubscriptionError from featuring service', async () => {
        const featuringService = new FakeFeaturingService();
        featuringService.shouldThrow = 'noActive';
        const { deps, repo } = buildDeps({ featuringService });
        await repo.insertOrFindByProviderRef({
            appointmentId: null,
            featuringSubscriptionId: 'sub-stale',
            provider: 'CHAPA',
            amountEtb: 500,
            providerRef: 'feat-stale-cccc',
        });
        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ tx_ref: 'feat-stale-cccc' })),
        );
        // Still 200 + intent is SUCCEEDED — the stale subscription
        // is a webhook-layer logical no-op.
        assert.strictEqual(res.statusCode, 200);
        const updated = (await repo.findByProviderRef('feat-stale-cccc'))!;
        assert.strictEqual(updated.status, 'SUCCEEDED');
    });

    it('swallows InvalidActivationStateError from featuring service', async () => {
        const featuringService = new FakeFeaturingService();
        featuringService.shouldThrow = 'invalidState';
        const { deps, repo } = buildDeps({ featuringService });
        await repo.insertOrFindByProviderRef({
            appointmentId: null,
            featuringSubscriptionId: 'sub-expired',
            provider: 'CHAPA',
            amountEtb: 500,
            providerRef: 'feat-expired-dddd',
        });
        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ tx_ref: 'feat-expired-dddd' })),
        );
        assert.strictEqual(res.statusCode, 200);
    });
});

describe('chapaWebhook — FAILED', () => {
    it('appointment row → markPaymentFailed + intent FAILED', async () => {
        const gateway = new FakeGateway({ kind: 'failed', message: 'declined' });
        const { deps, repo, appointmentService } = buildDeps({ gateway });
        await repo.insertOrFindByProviderRef({
            appointmentId: 'apt-2',
            featuringSubscriptionId: null,
            provider: 'CHAPA',
            amountEtb: 300,
            providerRef: 'apt-2-eeee',
        });
        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ tx_ref: 'apt-2-eeee' })),
        );
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(appointmentService.failed, ['apt-2']);
        const updated = (await repo.findByProviderRef('apt-2-eeee'))!;
        assert.strictEqual(updated.status, 'FAILED');
    });

    it('featuring row → intent FAILED, subscription left PENDING_PAYMENT', async () => {
        const gateway = new FakeGateway({ kind: 'failed', message: 'declined' });
        const { deps, repo, featuringService } = buildDeps({ gateway });
        await repo.insertOrFindByProviderRef({
            appointmentId: null,
            featuringSubscriptionId: 'sub-pending',
            provider: 'CHAPA',
            amountEtb: 500,
            providerRef: 'feat-pending-ffff',
        });
        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ tx_ref: 'feat-pending-ffff' })),
        );
        assert.strictEqual(res.statusCode, 200);
        // No activation attempted — subscription stays PENDING_PAYMENT
        // for the sweep to GC.
        assert.deepStrictEqual(featuringService.activated, []);
        const updated = (await repo.findByProviderRef('feat-pending-ffff'))!;
        assert.strictEqual(updated.status, 'FAILED');
    });
});

describe('chapaWebhook — verify error handling', () => {
    it('verify PENDING → 200 + handled=false', async () => {
        const gateway = new FakeGateway({ kind: 'pending' });
        const { deps, featuringService } = buildDeps({ gateway });
        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ tx_ref: 'feat-1-aaaa' })),
        );
        assert.strictEqual(res.statusCode, 200);
        const parsed = JSON.parse(res.body) as {
            handled: boolean;
            reason: string;
        };
        assert.strictEqual(parsed.handled, false);
        assert.strictEqual(parsed.reason, 'verify_pending');
        assert.strictEqual(featuringService.activated.length, 0);
    });

    it('ChapaUnavailable → 500 so Chapa retries', async () => {
        const gateway = new FakeGateway({ kind: 'unavailable' });
        const { deps } = buildDeps({ gateway });
        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ tx_ref: 'feat-1-aaaa' })),
        );
        assert.strictEqual(res.statusCode, 500);
    });

    it('ChapaInvalidRequest → 200 + handled=false (no retry)', async () => {
        const gateway = new FakeGateway({ kind: 'invalid_request' });
        const { deps } = buildDeps({ gateway });
        const res = await handleWebhook(
            deps,
            signedEvent(JSON.stringify({ tx_ref: 'feat-1-aaaa' })),
        );
        assert.strictEqual(res.statusCode, 200);
        const parsed = JSON.parse(res.body) as {
            handled: boolean;
            reason: string;
        };
        assert.strictEqual(parsed.handled, false);
        assert.strictEqual(parsed.reason, 'verify_rejected');
    });
});

describe('chapaWebhook — replay idempotency', () => {
    it('replayed SUCCEEDED webhook is a no-op against the SUCCEEDED row', async () => {
        const { deps, repo, gateway, featuringService } = buildDeps();
        await repo.insertOrFindByProviderRef({
            appointmentId: null,
            featuringSubscriptionId: 'sub-replay',
            provider: 'CHAPA',
            amountEtb: 500,
            providerRef: 'feat-replay-gggg',
        });
        const event = signedEvent(
            JSON.stringify({ tx_ref: 'feat-replay-gggg' }),
        );

        const first = await handleWebhook(deps, event);
        const second = await handleWebhook(deps, event);
        assert.strictEqual(first.statusCode, 200);
        assert.strictEqual(second.statusCode, 200);

        // verify called twice (each webhook does its own verify
        // round-trip — that's the defense-in-depth posture).
        assert.strictEqual(gateway.verifyCalls.length, 2);
        // Activation called twice — `activateFromPayment` is itself
        // idempotent against ACTIVE rows in production. The fake
        // service records both calls; the production code path
        // would short-circuit on the second.
        assert.deepStrictEqual(featuringService.activated, [
            'sub-replay',
            'sub-replay',
        ]);
        // Intent row stayed SUCCEEDED.
        const updated = (await repo.findByProviderRef('feat-replay-gggg'))!;
        assert.strictEqual(updated.status, 'SUCCEEDED');
    });

    it('replayed FAILED webhook against SUCCEEDED row does not downgrade', async () => {
        const { deps, repo } = buildDeps();
        await repo.insertOrFindByProviderRef({
            appointmentId: null,
            featuringSubscriptionId: 'sub-protect',
            provider: 'CHAPA',
            amountEtb: 500,
            providerRef: 'feat-protect-hhhh',
            status: 'SUCCEEDED',
        });
        const failGateway = new FakeGateway({
            kind: 'failed',
            message: 'late retry',
        });
        const { deps: failDeps, repo: failRepo } = buildDeps({
            gateway: failGateway,
            paymentIntentsRepo: repo,
        });
        const res = await handleWebhook(
            failDeps,
            signedEvent(JSON.stringify({ tx_ref: 'feat-protect-hhhh' })),
        );
        assert.strictEqual(res.statusCode, 200);
        const updated = (await failRepo.findByProviderRef(
            'feat-protect-hhhh',
        ))!;
        // SUCCEEDED preserved — CAS update refuses the downgrade.
        assert.strictEqual(updated.status, 'SUCCEEDED');
    });
});
