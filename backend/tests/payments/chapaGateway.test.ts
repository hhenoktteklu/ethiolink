// EthioLink — ChapaGateway unit tests.
//
// Phase 10 first commit. Drives the adapter against a recording
// fake transport so the suite stays platform-channel-free. Covers:
//
//   * `authorize` happy path → returns PENDING + redirect URL +
//     tx_ref preserved as providerRef.
//   * `authorize` 4xx → throws ChapaInvalidRequestError.
//   * `authorize` 5xx → throws ChapaUnavailableError.
//   * `authorize` timeout / network → throws ChapaUnavailableError.
//   * `authorize` 2xx without checkout_url → throws ChapaUnavailableError.
//   * `verify` SUCCESS → returns SUCCEEDED.
//   * `verify` FAILED → returns FAILED + errorCode CHAPA_DECLINED.
//   * `verify` PENDING → returns PENDING (caller no-ops).
//   * `verify` unknown body status → throws ChapaUnavailableError.
//   * `verify` 4xx → throws ChapaInvalidRequestError.
//   * `verify` empty providerRef → throws CHAPA_INVALID_REQUEST.
//   * `createChapaGateway` null / empty-key guard → throws
//     CHAPA_NOT_CONFIGURED.
//   * Helper: `synthesizeTxRef` produces stable refs for both
//     purposes.
//   * Helper: `formatAmountEtb` clamps + validates input.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    ChapaGateway,
    ChapaInvalidRequestError,
    ChapaUnavailableError,
    createChapaGateway,
    formatAmountEtb,
    synthesizeTxRef,
    type ChapaHttpRequestOptions,
    type ChapaHttpResponse,
    type ChapaHttpTransport,
    type ChapaProviderConfig,
} from '../../shared/adapters/payments/ChapaGateway.js';
import { PaymentGatewayError } from '../../shared/adapters/payments/PaymentGateway.js';

const TEST_CONFIG: ChapaProviderConfig = Object.freeze<ChapaProviderConfig>({
    apiBaseUrl: 'https://api.chapa.test',
    secretKey: 'CHASECK_TEST-xxxxxxxxxxxx',
    secretKeySecretArn: '',
    webhookSecret: 'whsec_test_xxxxxxxxxxxx',
    webhookSecretSecretArn: '',
    returnUrl: 'ethiolink://payments/return',
    timeoutMs: 5000,
    providerName: 'CHAPA',
});

const APPOINTMENT_INPUT = Object.freeze({
    purpose: 'APPOINTMENT' as const,
    appointmentId: '11111111-1111-1111-1111-111111111111',
    amountEtb: 300,
    idempotencyKey: 'idem-apt-0001',
});

const FEATURING_INPUT = Object.freeze({
    purpose: 'FEATURING' as const,
    featuringSubscriptionId: '22222222-2222-2222-2222-222222222222',
    businessId: '33333333-3333-3333-3333-333333333333',
    amountEtb: 500,
    idempotencyKey: 'idem-feat-0001',
});

// ---------------------------------------------------------------------------
// Fake transport — records calls and replays scripted responses
// ---------------------------------------------------------------------------

interface RecordedCall {
    readonly url: string;
    readonly options: ChapaHttpRequestOptions;
}

type Response = ChapaHttpResponse | (() => never);

class FakeChapaHttpTransport implements ChapaHttpTransport {
    public readonly calls: RecordedCall[] = [];
    private responses: Response[];

    constructor(responses: Response[]) {
        this.responses = responses;
    }

    async request(
        url: string,
        options: ChapaHttpRequestOptions,
    ): Promise<ChapaHttpResponse> {
        this.calls.push({ url, options });
        const next = this.responses.shift();
        if (next === undefined) {
            throw new Error(
                `FakeChapaHttpTransport: no scripted response for ${url}`,
            );
        }
        if (typeof next === 'function') {
            next(); // throws
            // unreachable
            throw new Error('thrower returned');
        }
        return next;
    }
}

function withCheckout(url: string): ChapaHttpResponse {
    return {
        status: 200,
        body: {
            status: 'success',
            message: 'Hosted checkout created.',
            data: { checkout_url: url },
        },
    };
}

function verifyResponse(
    inner: 'success' | 'failed' | 'pending' | string,
    extras: Record<string, unknown> = {},
): ChapaHttpResponse {
    return {
        status: 200,
        body: {
            status: 'success',
            data: { status: inner, ...extras },
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChapaGateway.authorize', () => {
    it('POSTs initialize and returns PENDING with checkout URL', async () => {
        const transport = new FakeChapaHttpTransport([
            withCheckout('https://checkout.chapa.test/sess-001'),
        ]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        const result = await gw.authorize({ ...FEATURING_INPUT });

        assert.strictEqual(result.status, 'PENDING');
        assert.strictEqual(result.provider, 'CHAPA');
        assert.strictEqual(
            result.redirectUrl,
            'https://checkout.chapa.test/sess-001',
        );
        assert.ok(result.providerRef && result.providerRef.startsWith('feat-'));
        assert.strictEqual(result.errorCode, null);
        assert.strictEqual(result.errorMessage, null);
        assert.match(
            result.authorizedAt,
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );

        assert.strictEqual(transport.calls.length, 1);
        const [call] = transport.calls;
        assert.strictEqual(call.options.method, 'POST');
        assert.strictEqual(
            call.url,
            'https://api.chapa.test/v1/transaction/initialize',
        );
        assert.strictEqual(
            call.options.headers.Authorization,
            'Bearer CHASECK_TEST-xxxxxxxxxxxx',
        );
        const body = call.options.body as Record<string, unknown>;
        assert.strictEqual(body.amount, '500.00');
        assert.strictEqual(body.currency, 'ETB');
        assert.strictEqual(body.tx_ref, result.providerRef);
        assert.strictEqual(body.return_url, 'ethiolink://payments/return');
        assert.ok(
            typeof body.email === 'string' &&
                (body.email as string).endsWith('@payments.ethiolink.local'),
        );
    });

    it('rolls APPOINTMENT input into the apt-* tx_ref namespace', async () => {
        const transport = new FakeChapaHttpTransport([
            withCheckout('https://checkout.chapa.test/sess-apt'),
        ]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        const result = await gw.authorize({ ...APPOINTMENT_INPUT });
        assert.ok(result.providerRef && result.providerRef.startsWith('apt-'));
    });

    it('4xx upstream → ChapaInvalidRequestError', async () => {
        const transport = new FakeChapaHttpTransport([
            {
                status: 400,
                body: { message: 'Invalid currency' },
            },
        ]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        await assert.rejects(
            () => gw.authorize({ ...FEATURING_INPUT }),
            (err: unknown) => {
                assert.ok(err instanceof ChapaInvalidRequestError);
                assert.strictEqual(err.code, 'CHAPA_INVALID_REQUEST');
                assert.strictEqual(err.status, 400);
                assert.match(err.message, /Invalid currency/);
                return true;
            },
        );
    });

    it('5xx upstream → ChapaUnavailableError', async () => {
        const transport = new FakeChapaHttpTransport([
            {
                status: 503,
                body: 'gateway down',
            },
        ]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        await assert.rejects(
            () => gw.authorize({ ...FEATURING_INPUT }),
            (err: unknown) =>
                err instanceof ChapaUnavailableError &&
                err.code === 'CHAPA_UNAVAILABLE',
        );
    });

    it('timeout / network error → ChapaUnavailableError', async () => {
        const transport = new FakeChapaHttpTransport([
            () => {
                const err = new Error('AbortError: aborted');
                err.name = 'AbortError';
                throw err;
            },
        ]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        await assert.rejects(
            () => gw.authorize({ ...FEATURING_INPUT }),
            (err: unknown) =>
                err instanceof ChapaUnavailableError &&
                /AbortError/.test(err.message),
        );
    });

    it('2xx without checkout_url → ChapaUnavailableError', async () => {
        const transport = new FakeChapaHttpTransport([
            { status: 200, body: { status: 'success', data: {} } },
        ]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        await assert.rejects(
            () => gw.authorize({ ...FEATURING_INPUT }),
            (err: unknown) =>
                err instanceof ChapaUnavailableError &&
                /no checkout URL/.test(err.message),
        );
    });
});

describe('ChapaGateway.verify', () => {
    it('SUCCESS body → SUCCEEDED', async () => {
        const transport = new FakeChapaHttpTransport([verifyResponse('success')]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        const result = await gw.verify('feat-abc-12345678');

        assert.strictEqual(result.status, 'SUCCEEDED');
        assert.strictEqual(result.provider, 'CHAPA');
        assert.strictEqual(result.providerRef, 'feat-abc-12345678');
        assert.strictEqual(result.errorCode, null);
        assert.strictEqual(result.redirectUrl ?? null, null);

        const [call] = transport.calls;
        assert.strictEqual(call.options.method, 'GET');
        assert.strictEqual(
            call.url,
            'https://api.chapa.test/v1/transaction/verify/feat-abc-12345678',
        );
    });

    it('FAILED body → FAILED + CHAPA_DECLINED', async () => {
        const transport = new FakeChapaHttpTransport([
            verifyResponse('failed', { message: 'Insufficient funds' }),
        ]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        const result = await gw.verify('feat-abc-12345678');

        assert.strictEqual(result.status, 'FAILED');
        assert.strictEqual(result.errorCode, 'CHAPA_DECLINED');
        assert.strictEqual(result.errorMessage, 'Insufficient funds');
    });

    it('PENDING body → PENDING (webhook landed before settle)', async () => {
        const transport = new FakeChapaHttpTransport([verifyResponse('pending')]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        const result = await gw.verify('feat-abc-12345678');
        assert.strictEqual(result.status, 'PENDING');
    });

    it('unknown body status → ChapaUnavailableError', async () => {
        const transport = new FakeChapaHttpTransport([
            verifyResponse('weird-new-status'),
        ]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        await assert.rejects(
            () => gw.verify('feat-abc-12345678'),
            (err: unknown) =>
                err instanceof ChapaUnavailableError &&
                /unknown status/.test(err.message),
        );
    });

    it('4xx upstream → ChapaInvalidRequestError', async () => {
        const transport = new FakeChapaHttpTransport([
            { status: 404, body: { message: 'tx_ref not found' } },
        ]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        await assert.rejects(
            () => gw.verify('feat-abc-12345678'),
            (err: unknown) =>
                err instanceof ChapaInvalidRequestError &&
                err.status === 404,
        );
    });

    it('empty providerRef → CHAPA_INVALID_REQUEST throw', async () => {
        const transport = new FakeChapaHttpTransport([]);
        const gw = new ChapaGateway(TEST_CONFIG, transport);
        await assert.rejects(
            () => gw.verify(''),
            (err: unknown) =>
                err instanceof PaymentGatewayError &&
                err.code === 'CHAPA_INVALID_REQUEST',
        );
        // No HTTP call was issued.
        assert.strictEqual(transport.calls.length, 0);
    });
});

describe('createChapaGateway()', () => {
    it('throws CHAPA_NOT_CONFIGURED when config is null', () => {
        assert.throws(
            () => createChapaGateway(null),
            (err: unknown) =>
                err instanceof PaymentGatewayError &&
                err.code === 'CHAPA_NOT_CONFIGURED',
        );
    });

    it('throws CHAPA_NOT_CONFIGURED when secretKey is empty', () => {
        const broken = { ...TEST_CONFIG, secretKey: '   ' };
        assert.throws(
            () => createChapaGateway(broken),
            (err: unknown) =>
                err instanceof PaymentGatewayError &&
                err.code === 'CHAPA_NOT_CONFIGURED',
        );
    });

    it('constructs the gateway when config is well-formed', () => {
        const gw = createChapaGateway(TEST_CONFIG);
        assert.strictEqual(gw.provider, 'CHAPA');
    });
});

describe('helpers', () => {
    it('synthesizeTxRef is stable for the same (id, idem) pair', () => {
        const a = synthesizeTxRef({ ...FEATURING_INPUT });
        const b = synthesizeTxRef({ ...FEATURING_INPUT });
        assert.strictEqual(a, b);
    });

    it('synthesizeTxRef differs across purposes', () => {
        const apt = synthesizeTxRef({ ...APPOINTMENT_INPUT });
        const feat = synthesizeTxRef({ ...FEATURING_INPUT });
        assert.ok(apt.startsWith('apt-'));
        assert.ok(feat.startsWith('feat-'));
    });

    it('synthesizeTxRef tolerates missing idempotencyKey', () => {
        const ref = synthesizeTxRef({
            purpose: 'APPOINTMENT',
            appointmentId: 'abc',
            amountEtb: 1,
        });
        assert.ok(ref.startsWith('apt-abc-'));
        // No exception, deterministic fallback slug.
    });

    it('formatAmountEtb uses fixed-2 decimal', () => {
        assert.strictEqual(formatAmountEtb(500), '500.00');
        assert.strictEqual(formatAmountEtb(0), '0.00');
        assert.strictEqual(formatAmountEtb(1500.5), '1500.50');
    });

    it('formatAmountEtb rejects negative / NaN', () => {
        assert.throws(
            () => formatAmountEtb(-1),
            (err: unknown) =>
                err instanceof PaymentGatewayError &&
                err.code === 'CHAPA_INVALID_REQUEST',
        );
        assert.throws(
            () => formatAmountEtb(Number.NaN),
            (err: unknown) =>
                err instanceof PaymentGatewayError &&
                err.code === 'CHAPA_INVALID_REQUEST',
        );
    });
});
