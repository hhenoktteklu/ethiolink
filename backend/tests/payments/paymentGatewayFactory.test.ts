// EthioLink — paymentGatewayFactory unit tests.
//
// Phase 10 first commit. Factory builds the `(cash, online)`
// gateway pair from a resolved `AppConfig`. Tests cover the three
// branches:
//
//   * `paymentsProvider = 'mock'` (default) → online is
//     `MockOnlineGateway`.
//   * `paymentsProvider = 'chapa'` + config present → online is
//     `ChapaGateway`.
//   * `paymentsProvider = 'chapa'` + config missing → throws
//     CHAPA_NOT_CONFIGURED at factory time (loud over silent
//     mock-fallback).
//
// Plus: cash gateway is always wired identically regardless of
// online slot, and the optional `chapaTransport` test seam flows
// through to the constructed gateway.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CashGateway } from '../../shared/adapters/payments/CashGateway.js';
import { ChapaGateway } from '../../shared/adapters/payments/ChapaGateway.js';
import type {
    ChapaHttpRequestOptions,
    ChapaHttpResponse,
    ChapaHttpTransport,
    ChapaProviderConfig,
} from '../../shared/adapters/payments/ChapaGateway.js';
import { MockOnlineGateway } from '../../shared/adapters/payments/MockOnlineGateway.js';
import { PaymentGatewayError } from '../../shared/adapters/payments/PaymentGateway.js';
import type { AppConfig } from '../../shared/config/loadConfig.js';
import { createPaymentGateways } from '../../shared/factories/paymentGatewayFactory.js';

const BASE_CONFIG: AppConfig = Object.freeze<AppConfig>({
    nodeEnv: 'test',
    logLevel: 'info',
    region: 'eu-west-1',
    pg: Object.freeze({
        host: 'localhost',
        port: 5432,
        database: 'ethiolink',
        user: 'ethiolink',
        password: 'ethiolink',
        ssl: false,
    }),
    cognito: Object.freeze({
        userPoolId: 'pool',
        appClientIdMobile: 'mobile',
        appClientIdAdmin: 'admin',
        region: 'eu-west-1',
    }),
    s3: Object.freeze({
        publicBucket: '',
        privateBucket: '',
        uploadUrlExpiresSeconds: 900,
        readUrlExpiresSeconds: 3600,
    }),
    booking: Object.freeze({
        slotStepMinutes: 15,
        bufferMinutes: 5,
        cancelCutoffMinutes: 240,
        defaultTimezone: 'Africa/Addis_Ababa',
    }),
    featuring: Object.freeze({
        featuring7dPriceEtb: 500,
        featuring30dPriceEtb: 1500,
        enabled: false,
    }),
    smsProvider: null,
    telegramProvider: null,
    chapaProvider: null,
    notificationsProvider: 'mock',
    paymentsProvider: 'mock',
});

const CHAPA_CONFIG: ChapaProviderConfig = Object.freeze<ChapaProviderConfig>({
    apiBaseUrl: 'https://api.chapa.test',
    secretKey: 'CHASECK_TEST-xxxx',
    secretKeySecretArn: '',
    webhookSecret: 'whsec_test_xxxx',
    webhookSecretSecretArn: '',
    returnUrl: 'ethiolink://payments/return',
    timeoutMs: 12000,
    providerName: 'CHAPA',
});

class TrackingTransport implements ChapaHttpTransport {
    public called = false;
    async request(
        _url: string,
        _options: ChapaHttpRequestOptions,
    ): Promise<ChapaHttpResponse> {
        this.called = true;
        return { status: 200, body: { status: 'success', data: {} } };
    }
}

describe('createPaymentGateways', () => {
    it('mock default → cash + MockOnlineGateway', () => {
        const pair = createPaymentGateways(BASE_CONFIG);
        assert.ok(pair.cash instanceof CashGateway);
        assert.ok(pair.online instanceof MockOnlineGateway);
        assert.strictEqual(pair.online.provider, 'MOCK');
    });

    it('chapa + config → cash + ChapaGateway', () => {
        const cfg: AppConfig = {
            ...BASE_CONFIG,
            paymentsProvider: 'chapa',
            chapaProvider: CHAPA_CONFIG,
        };
        const pair = createPaymentGateways(cfg);
        assert.ok(pair.cash instanceof CashGateway);
        assert.ok(pair.online instanceof ChapaGateway);
        assert.strictEqual(pair.online.provider, 'CHAPA');
    });

    it('chapa + missing config → throws CHAPA_NOT_CONFIGURED', () => {
        const cfg: AppConfig = {
            ...BASE_CONFIG,
            paymentsProvider: 'chapa',
            chapaProvider: null,
        };
        assert.throws(
            () => createPaymentGateways(cfg),
            (err: unknown) =>
                err instanceof PaymentGatewayError &&
                err.code === 'CHAPA_NOT_CONFIGURED',
        );
    });

    it('flows the optional Chapa transport seam through', async () => {
        const transport = new TrackingTransport();
        const cfg: AppConfig = {
            ...BASE_CONFIG,
            paymentsProvider: 'chapa',
            chapaProvider: CHAPA_CONFIG,
        };
        const pair = createPaymentGateways(cfg, { chapaTransport: transport });
        // Trigger the online gateway to confirm it uses the injected
        // transport rather than the production fetch path.
        await assert.rejects(
            () =>
                pair.online.authorize({
                    purpose: 'FEATURING',
                    featuringSubscriptionId: 'sub-1',
                    businessId: 'biz-1',
                    amountEtb: 500,
                    idempotencyKey: 'idem-x',
                }),
            // The fake transport returns an empty `data` body — the
            // gateway's "no checkout URL" guard fires.
            (err: unknown) =>
                err instanceof PaymentGatewayError &&
                err.code === 'CHAPA_UNAVAILABLE',
        );
        assert.strictEqual(transport.called, true);
    });

    it('cash gateway is always wired regardless of online slot', () => {
        const mockPair = createPaymentGateways(BASE_CONFIG);
        const chapaPair = createPaymentGateways({
            ...BASE_CONFIG,
            paymentsProvider: 'chapa',
            chapaProvider: CHAPA_CONFIG,
        });
        assert.strictEqual(mockPair.cash.provider, 'CASH');
        assert.strictEqual(chapaPair.cash.provider, 'CASH');
    });
});
