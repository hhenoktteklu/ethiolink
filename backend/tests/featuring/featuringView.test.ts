// EthioLink — featuringView tests.
//
// Phase 10 first-routing commit. Two surfaces:
//
//   * `toFeaturingSubscriptionView` — pure projection used by
//     getActive / listHistory / subscribe (legacy callers).
//   * `toSubscribeFeaturingResponse` — wraps the subscription with
//     a `payment` block carrying redirectUrl. Cash featuring ships
//     redirectUrl: null; Chapa-style PENDING ships the URL.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PaymentAuthorization } from '../../shared/adapters/payments/PaymentGateway.js';
import type { FeaturingSubscription } from '../../shared/domains/featuring/featuringRepository.js';
import {
    toFeaturingSubscriptionView,
    toSubscribeFeaturingResponse,
} from '../../shared/domains/featuring/featuringView.js';

const SAMPLE_SUB: FeaturingSubscription = Object.freeze<FeaturingSubscription>({
    id: '11111111-1111-1111-1111-111111111111',
    businessId: '22222222-2222-2222-2222-222222222222',
    packageCode: 'FEATURING_7D',
    priceEtb: 500,
    startsAt: new Date('2026-06-01T00:00:00.000Z'),
    endsAt: new Date('2026-06-08T00:00:00.000Z'),
    status: 'PENDING_PAYMENT',
    source: 'OWNER_PURCHASE',
    cancelledAt: null,
    cancelledReason: null,
    createdByUserId: 'owner-1',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
});

const CASH_AUTH: PaymentAuthorization = Object.freeze<PaymentAuthorization>({
    status: 'SUCCEEDED',
    provider: 'CASH',
    providerRef: null,
    rawResponse: null,
    errorCode: null,
    errorMessage: null,
    authorizedAt: '2026-06-01T00:00:00.000Z',
    redirectUrl: null,
});

const CHAPA_PENDING_AUTH: PaymentAuthorization = Object.freeze<PaymentAuthorization>({
    status: 'PENDING',
    provider: 'CHAPA',
    providerRef: 'feat-22222222-87654321',
    rawResponse: { status: 'success' },
    errorCode: null,
    errorMessage: null,
    authorizedAt: '2026-06-01T00:00:00.000Z',
    redirectUrl: 'https://checkout.chapa.test/sess-feat-001',
});

describe('toFeaturingSubscriptionView', () => {
    it('emits ISO-8601 timestamps + the full subscription field set', () => {
        const view = toFeaturingSubscriptionView(SAMPLE_SUB);
        assert.strictEqual(view.id, SAMPLE_SUB.id);
        assert.strictEqual(view.packageCode, 'FEATURING_7D');
        assert.strictEqual(view.priceEtb, 500);
        assert.strictEqual(view.status, 'PENDING_PAYMENT');
        assert.strictEqual(view.startsAt, '2026-06-01T00:00:00.000Z');
        assert.strictEqual(view.endsAt, '2026-06-08T00:00:00.000Z');
        assert.strictEqual(view.cancelledAt, null);
    });

    it('does not leak createdByUserId or the redirectUrl field', () => {
        const view = toFeaturingSubscriptionView(SAMPLE_SUB) as unknown as Record<
            string,
            unknown
        >;
        // createdByUserId is private; the public view never carries it.
        assert.strictEqual(view.createdByUserId, undefined);
        // Phase 10: redirect URL belongs on the subscribe-response
        // wrapper, NOT the bare subscription view.
        assert.strictEqual(view.redirectUrl, undefined);
        assert.strictEqual(view.payment, undefined);
    });
});

describe('toSubscribeFeaturingResponse — Phase 10 wire wrapper', () => {
    it('cash featuring → payment.redirectUrl: null, status SUCCEEDED', () => {
        const response = toSubscribeFeaturingResponse(SAMPLE_SUB, CASH_AUTH);
        assert.strictEqual(response.subscription.id, SAMPLE_SUB.id);
        assert.strictEqual(response.payment.status, 'SUCCEEDED');
        assert.strictEqual(response.payment.provider, 'CASH');
        assert.strictEqual(response.payment.redirectUrl, null);
        assert.strictEqual(response.payment.providerRef, null);
    });

    it('Chapa PENDING featuring → payment.redirectUrl carries hosted checkout', () => {
        const response = toSubscribeFeaturingResponse(
            SAMPLE_SUB,
            CHAPA_PENDING_AUTH,
        );
        assert.strictEqual(response.subscription.status, 'PENDING_PAYMENT');
        assert.strictEqual(response.payment.status, 'PENDING');
        assert.strictEqual(response.payment.provider, 'CHAPA');
        assert.strictEqual(
            response.payment.redirectUrl,
            'https://checkout.chapa.test/sess-feat-001',
        );
        assert.strictEqual(
            response.payment.providerRef,
            'feat-22222222-87654321',
        );
    });

    it('subscription field equals toFeaturingSubscriptionView(...)', () => {
        const response = toSubscribeFeaturingResponse(SAMPLE_SUB, CASH_AUTH);
        const standalone = toFeaturingSubscriptionView(SAMPLE_SUB);
        assert.deepStrictEqual(response.subscription, standalone);
    });

    it('does not leak rawResponse or authorizedAt on the wire', () => {
        const response = toSubscribeFeaturingResponse(
            SAMPLE_SUB,
            CHAPA_PENDING_AUTH,
        ) as unknown as { payment: Record<string, unknown> };
        assert.strictEqual(response.payment.rawResponse, undefined);
        assert.strictEqual(response.payment.authorizedAt, undefined);
    });
});
