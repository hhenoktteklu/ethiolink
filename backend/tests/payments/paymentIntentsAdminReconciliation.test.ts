// EthioLink — admin payment-intents reconciliation tests.
//
// Phase 10 commit 6. Covers the two new repository methods +
// the view mapping that bridges the in-memory rows to the wire
// shape. Postgres-impl tests live alongside the existing
// `paymentIntentsRepository.test.ts` and exercise the same
// contract — these cases pin the public surface.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    InMemoryPaymentIntentsRepository,
    type PaymentIntent,
} from '../../shared/domains/payments/paymentIntentsRepository.js';
import {
    toPaymentIntentList,
    toPaymentIntentView,
} from '../../shared/domains/payments/paymentIntentView.js';

const BUSINESS_A = '00000000-0000-0000-0000-0000000000a1';
const BUSINESS_B = '00000000-0000-0000-0000-0000000000b1';

function seedRow(
    repo: InMemoryPaymentIntentsRepository,
    overrides: {
        id?: string;
        providerRef?: string;
        appointmentId?: string | null;
        featuringSubscriptionId?: string | null;
        provider?: PaymentIntent['provider'];
        status?: PaymentIntent['status'];
        amountEtb?: number;
        createdAt?: Date;
        businessId?: string;
    } = {},
): PaymentIntent {
    const now = overrides.createdAt ?? new Date();
    const row: PaymentIntent = Object.freeze<PaymentIntent>({
        id: overrides.id ?? `pi-seed-${Math.random().toString(36).slice(2, 8)}`,
        appointmentId: overrides.appointmentId ?? null,
        featuringSubscriptionId: overrides.featuringSubscriptionId ?? null,
        provider: overrides.provider ?? 'CHAPA',
        amountEtb: overrides.amountEtb ?? 500,
        status: overrides.status ?? 'PENDING',
        providerRef:
            overrides.providerRef ??
            `tx-${Math.random().toString(36).slice(2, 10)}`,
        rawResponse: null,
        createdAt: now,
        updatedAt: now,
    });
    repo.seed(row, overrides.businessId);
    return row;
}

describe('InMemoryPaymentIntentsRepository.listForBusiness', () => {
    it('returns only rows attached to the requested business', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const a1 = seedRow(repo, {
            businessId: BUSINESS_A,
            appointmentId: 'apt-a1',
            createdAt: new Date('2026-05-10T10:00:00.000Z'),
        });
        const a2 = seedRow(repo, {
            businessId: BUSINESS_A,
            featuringSubscriptionId: 'sub-a1',
            createdAt: new Date('2026-05-11T10:00:00.000Z'),
        });
        seedRow(repo, {
            businessId: BUSINESS_B,
            appointmentId: 'apt-b1',
            createdAt: new Date('2026-05-12T10:00:00.000Z'),
        });
        const rows = await repo.listForBusiness(BUSINESS_A, 100);
        assert.strictEqual(rows.length, 2);
        // Newest first: a2 (2026-05-11) before a1 (2026-05-10).
        assert.strictEqual(rows[0]!.id, a2.id);
        assert.strictEqual(rows[1]!.id, a1.id);
    });

    it('respects limit', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        for (let i = 0; i < 5; i++) {
            seedRow(repo, {
                businessId: BUSINESS_A,
                appointmentId: `apt-${i}`,
                createdAt: new Date(2026, 4, 10 + i),
            });
        }
        const rows = await repo.listForBusiness(BUSINESS_A, 3);
        assert.strictEqual(rows.length, 3);
    });

    it('returns empty array when business has no recorded intents', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        seedRow(repo, { businessId: BUSINESS_A, appointmentId: 'apt-a1' });
        const rows = await repo.listForBusiness(BUSINESS_B, 100);
        assert.deepStrictEqual(rows, []);
    });
});

describe('InMemoryPaymentIntentsRepository.listAll', () => {
    it('filters by from / to / provider / status', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        seedRow(repo, {
            id: 'pi-1',
            provider: 'CHAPA',
            status: 'SUCCEEDED',
            createdAt: new Date('2026-05-10T10:00:00.000Z'),
        });
        seedRow(repo, {
            id: 'pi-2',
            provider: 'CHAPA',
            status: 'FAILED',
            createdAt: new Date('2026-05-11T10:00:00.000Z'),
        });
        seedRow(repo, {
            id: 'pi-3',
            provider: 'TELEBIRR',
            status: 'SUCCEEDED',
            createdAt: new Date('2026-05-12T10:00:00.000Z'),
        });
        seedRow(repo, {
            id: 'pi-4',
            provider: 'CHAPA',
            status: 'SUCCEEDED',
            createdAt: new Date('2026-05-13T10:00:00.000Z'),
        });

        // Provider + status filters.
        let rows = await repo.listAll(
            { provider: 'CHAPA', status: 'SUCCEEDED' },
            100,
        );
        assert.deepStrictEqual(
            rows.map((r) => r.id),
            ['pi-4', 'pi-1'],
        );

        // Date window — inclusive lower, exclusive upper.
        rows = await repo.listAll(
            {
                fromUtc: new Date('2026-05-11T00:00:00.000Z'),
                toUtc: new Date('2026-05-13T00:00:00.000Z'),
            },
            100,
        );
        assert.deepStrictEqual(
            rows.map((r) => r.id),
            ['pi-3', 'pi-2'],
        );

        // No filters → newest-first across the board.
        rows = await repo.listAll({}, 100);
        assert.deepStrictEqual(
            rows.map((r) => r.id),
            ['pi-4', 'pi-3', 'pi-2', 'pi-1'],
        );
    });

    it('respects limit', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        for (let i = 0; i < 10; i++) {
            seedRow(repo, {
                id: `pi-${i}`,
                createdAt: new Date(2026, 4, 1 + i),
            });
        }
        const rows = await repo.listAll({}, 3);
        assert.strictEqual(rows.length, 3);
    });
});

describe('toPaymentIntentView', () => {
    it('emits ISO-8601 timestamps + the full field set', () => {
        const row: PaymentIntent = Object.freeze<PaymentIntent>({
            id: 'pi-1',
            appointmentId: 'apt-1',
            featuringSubscriptionId: null,
            provider: 'CHAPA',
            amountEtb: 300,
            status: 'SUCCEEDED',
            providerRef: 'apt-1-aaaa',
            rawResponse: { status: 'success' },
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:01:00.000Z'),
        });
        const view = toPaymentIntentView(row);
        assert.strictEqual(view.id, 'pi-1');
        assert.strictEqual(view.purpose, 'APPOINTMENT');
        assert.strictEqual(view.provider, 'CHAPA');
        assert.strictEqual(view.status, 'SUCCEEDED');
        assert.strictEqual(view.amountEtb, 300);
        assert.strictEqual(view.currency, 'ETB');
        assert.strictEqual(view.providerRef, 'apt-1-aaaa');
        assert.deepStrictEqual(view.rawResponse, { status: 'success' });
        assert.strictEqual(view.createdAt, '2026-05-15T10:00:00.000Z');
        assert.strictEqual(view.updatedAt, '2026-05-15T10:01:00.000Z');
    });

    it('discriminates FEATURING purpose when featuringSubscriptionId is set', () => {
        const row: PaymentIntent = Object.freeze<PaymentIntent>({
            id: 'pi-2',
            appointmentId: null,
            featuringSubscriptionId: 'sub-1',
            provider: 'CHAPA',
            amountEtb: 500,
            status: 'PENDING',
            providerRef: 'feat-1-aaaa',
            rawResponse: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:00.000Z'),
        });
        const view = toPaymentIntentView(row);
        assert.strictEqual(view.purpose, 'FEATURING');
    });

    it('toPaymentIntentList wraps rows in the items envelope', () => {
        const repo = new InMemoryPaymentIntentsRepository();
        seedRow(repo, {
            id: 'pi-a',
            createdAt: new Date('2026-05-10T10:00:00.000Z'),
        });
        seedRow(repo, {
            id: 'pi-b',
            createdAt: new Date('2026-05-11T10:00:00.000Z'),
        });
        const list = toPaymentIntentList(repo.listAllRaw());
        assert.ok('items' in list);
        assert.strictEqual(list.items.length, 2);
        // Newest first.
        assert.strictEqual(list.items[0]!.id, 'pi-b');
    });
});
