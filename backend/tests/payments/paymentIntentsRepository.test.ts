// EthioLink — paymentIntentsRepository (in-memory) tests.
//
// Phase 10 commit 3. The Postgres impl is exercised end-to-end via
// the webhook handler test against the in-memory variant — both
// implementations share the same `PaymentIntentsRepository`
// contract. These cases pin the contract:
//
//   * findByProviderRef returns null on unknown ref.
//   * insertOrFindByProviderRef inserts when absent + returns the
//     existing row on conflict (idempotent under retry).
//   * markSucceeded is idempotent against SUCCEEDED rows.
//   * markFailed refuses to downgrade SUCCEEDED rows.
//   * markFailed is idempotent against already-FAILED rows.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryPaymentIntentsRepository } from '../../shared/domains/payments/paymentIntentsRepository.js';

const PROVIDER = 'CHAPA' as const;

describe('InMemoryPaymentIntentsRepository — findByProviderRef', () => {
    it('returns null when no row matches', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const result = await repo.findByProviderRef('feat-missing-aaaa');
        assert.strictEqual(result, null);
    });
});

describe('InMemoryPaymentIntentsRepository — insertOrFindByProviderRef', () => {
    it('inserts a PENDING row when none exists', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const row = await repo.insertOrFindByProviderRef({
            appointmentId: null,
            featuringSubscriptionId: 'sub-1',
            provider: PROVIDER,
            amountEtb: 500,
            providerRef: 'feat-1-aaaa',
        });
        assert.strictEqual(row.status, 'PENDING');
        assert.strictEqual(row.featuringSubscriptionId, 'sub-1');
        assert.strictEqual(row.providerRef, 'feat-1-aaaa');
    });

    it('returns the existing row on conflict (idempotent retry)', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const first = await repo.insertOrFindByProviderRef({
            appointmentId: 'apt-1',
            featuringSubscriptionId: null,
            provider: PROVIDER,
            amountEtb: 300,
            providerRef: 'apt-1-bbbb',
        });
        const second = await repo.insertOrFindByProviderRef({
            appointmentId: 'apt-1',
            featuringSubscriptionId: null,
            provider: PROVIDER,
            amountEtb: 300,
            providerRef: 'apt-1-bbbb',
        });
        assert.strictEqual(second.id, first.id);
        assert.strictEqual(repo.listAll().length, 1);
    });
});

describe('InMemoryPaymentIntentsRepository — markSucceeded', () => {
    it('flips a PENDING row to SUCCEEDED', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const row = await repo.insertOrFindByProviderRef({
            appointmentId: null,
            featuringSubscriptionId: 'sub-1',
            provider: PROVIDER,
            amountEtb: 500,
            providerRef: 'feat-1-aaaa',
        });
        const updated = await repo.markSucceeded(row.id, { status: 'success' });
        assert.ok(updated);
        assert.strictEqual(updated!.status, 'SUCCEEDED');
        assert.deepStrictEqual(updated!.rawResponse, { status: 'success' });
    });

    it('is idempotent against an already-SUCCEEDED row', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const row = await repo.insertOrFindByProviderRef({
            appointmentId: null,
            featuringSubscriptionId: 'sub-1',
            provider: PROVIDER,
            amountEtb: 500,
            providerRef: 'feat-1-aaaa',
        });
        await repo.markSucceeded(row.id, { first: true });
        const second = await repo.markSucceeded(row.id, { second: true });
        // Second call returns current row unchanged.
        assert.strictEqual(second!.status, 'SUCCEEDED');
        assert.deepStrictEqual(second!.rawResponse, { first: true });
    });

    it('returns null for unknown id', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const updated = await repo.markSucceeded('does-not-exist', null);
        assert.strictEqual(updated, null);
    });
});

describe('InMemoryPaymentIntentsRepository — markFailed', () => {
    it('flips a PENDING row to FAILED', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const row = await repo.insertOrFindByProviderRef({
            appointmentId: 'apt-1',
            featuringSubscriptionId: null,
            provider: PROVIDER,
            amountEtb: 300,
            providerRef: 'apt-1-bbbb',
        });
        const updated = await repo.markFailed(row.id, {
            status: 'failed',
        });
        assert.strictEqual(updated!.status, 'FAILED');
    });

    it('refuses to downgrade SUCCEEDED', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const row = await repo.insertOrFindByProviderRef({
            appointmentId: null,
            featuringSubscriptionId: 'sub-1',
            provider: PROVIDER,
            amountEtb: 500,
            providerRef: 'feat-1-aaaa',
        });
        await repo.markSucceeded(row.id, { ok: true });
        const updated = await repo.markFailed(row.id, { reset: true });
        // SUCCEEDED preserved.
        assert.strictEqual(updated!.status, 'SUCCEEDED');
        assert.deepStrictEqual(updated!.rawResponse, { ok: true });
    });

    it('is idempotent against an already-FAILED row', async () => {
        const repo = new InMemoryPaymentIntentsRepository();
        const row = await repo.insertOrFindByProviderRef({
            appointmentId: 'apt-1',
            featuringSubscriptionId: null,
            provider: PROVIDER,
            amountEtb: 300,
            providerRef: 'apt-1-bbbb',
        });
        await repo.markFailed(row.id, { reason: 'first' });
        const second = await repo.markFailed(row.id, { reason: 'second' });
        assert.strictEqual(second!.status, 'FAILED');
        assert.deepStrictEqual(second!.rawResponse, { reason: 'first' });
    });
});
