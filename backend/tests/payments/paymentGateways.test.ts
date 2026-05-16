// EthioLink — payment gateway unit tests.
//
// Tiny suite covering the two MVP implementations of `PaymentGateway`:
//
//   * `CashGateway` always returns a SUCCEEDED authorization with
//     null provider metadata and a current `authorizedAt`.
//   * `MockOnlineGateway` always throws `OnlinePaymentsUnavailableError`
//     with the expected stable `code` and a non-empty message.
//
// These gateways are dependency-free; no fakes or injected clocks
// needed. When real online providers ship, each gets its own test
// file alongside this one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CashGateway } from '../../shared/adapters/payments/CashGateway.js';
import { MockOnlineGateway } from '../../shared/adapters/payments/MockOnlineGateway.js';
import {
    OnlinePaymentsUnavailableError,
    PaymentGatewayError,
    PaymentVerificationUnsupportedError,
} from '../../shared/adapters/payments/PaymentGateway.js';

const SAMPLE_INPUT = Object.freeze({
    purpose: 'APPOINTMENT' as const,
    appointmentId: '00000000-0000-0000-0000-000000000001',
    amountEtb: 300,
    idempotencyKey: 'idem-1',
});

const SAMPLE_FEATURING_INPUT = Object.freeze({
    purpose: 'FEATURING' as const,
    featuringSubscriptionId: '00000000-0000-0000-0000-000000000002',
    businessId: '00000000-0000-0000-0000-000000000003',
    amountEtb: 500,
    idempotencyKey: 'idem-feat-1',
});

describe('CashGateway', () => {
    it('reports provider = CASH', () => {
        const gw = new CashGateway();
        assert.strictEqual(gw.provider, 'CASH');
    });

    it('returns a SUCCEEDED authorization with no provider metadata', async () => {
        const gw = new CashGateway();
        const result = await gw.authorize({ ...SAMPLE_INPUT });

        assert.strictEqual(result.status, 'SUCCEEDED');
        assert.strictEqual(result.provider, 'CASH');
        assert.strictEqual(result.providerRef, null);
        assert.strictEqual(result.rawResponse, null);
        assert.strictEqual(result.errorCode, null);
        assert.strictEqual(result.errorMessage, null);
        assert.match(
            result.authorizedAt,
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
        // Phase 10 — synchronous gateways set `redirectUrl: null`.
        assert.strictEqual(result.redirectUrl ?? null, null);
    });

    it('verify() throws PaymentVerificationUnsupportedError', async () => {
        // Phase 10 — cash never returns PENDING from authorize, so
        // verify is unreachable; the throw makes a routing bug loud.
        const gw = new CashGateway();
        await assert.rejects(
            () => gw.verify('any-ref'),
            (err: unknown) => {
                assert.ok(
                    err instanceof PaymentVerificationUnsupportedError,
                    `expected PaymentVerificationUnsupportedError, got ${err}`,
                );
                assert.ok(err instanceof PaymentGatewayError);
                assert.strictEqual(
                    err.code,
                    'PAYMENT_VERIFICATION_UNSUPPORTED',
                );
                return true;
            },
        );
    });

    it('ignores the idempotency key (cash has no upstream)', async () => {
        const gw = new CashGateway();
        const a = await gw.authorize({ ...SAMPLE_INPUT, idempotencyKey: 'one' });
        const b = await gw.authorize({ ...SAMPLE_INPUT, idempotencyKey: 'two' });
        // Both should succeed identically; no idempotency-based dedupe.
        assert.strictEqual(a.status, b.status);
        assert.strictEqual(a.provider, b.provider);
    });
});

describe('MockOnlineGateway', () => {
    it('reports provider = MOCK', () => {
        const gw = new MockOnlineGateway();
        assert.strictEqual(gw.provider, 'MOCK');
    });

    it('throws OnlinePaymentsUnavailableError on every authorize', async () => {
        const gw = new MockOnlineGateway();
        await assert.rejects(
            () => gw.authorize({ ...SAMPLE_INPUT }),
            (err: unknown) => {
                assert.ok(
                    err instanceof OnlinePaymentsUnavailableError,
                    `expected OnlinePaymentsUnavailableError, got ${err}`,
                );
                assert.ok(err instanceof PaymentGatewayError);
                assert.strictEqual(err.code, 'ONLINE_PAYMENTS_UNAVAILABLE');
                assert.ok(err.message.length > 0);
                return true;
            },
        );
    });

    it('verify() throws PaymentVerificationUnsupportedError', async () => {
        // Phase 10 — mock never authorizes, so no payment_intents
        // row ever points at it; verify is unreachable.
        const gw = new MockOnlineGateway();
        await assert.rejects(
            () => gw.verify('any-ref'),
            (err: unknown) =>
                err instanceof PaymentVerificationUnsupportedError &&
                err.code === 'PAYMENT_VERIFICATION_UNSUPPORTED',
        );
    });
});

describe('PaymentGateway — Phase 9 Track 6 featuring purpose', () => {
    it('CashGateway accepts featuring input and returns SUCCEEDED', async () => {
        const gw = new CashGateway();
        const result = await gw.authorize({ ...SAMPLE_FEATURING_INPUT });
        // Cash is the default fallback for any featuring purchase in
        // an env where the online gateway isn't wired. Returns the
        // same shape as the appointment path; the featuring service
        // persists the `payment_intents` row keyed by
        // `featuringSubscriptionId`.
        assert.strictEqual(result.status, 'SUCCEEDED');
        assert.strictEqual(result.provider, 'CASH');
    });

    it('MockOnlineGateway still rejects featuring purpose', async () => {
        const gw = new MockOnlineGateway();
        await assert.rejects(
            () => gw.authorize({ ...SAMPLE_FEATURING_INPUT }),
            (err: unknown) => err instanceof OnlinePaymentsUnavailableError,
        );
    });
});
