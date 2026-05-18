// EthioLink — businessView projection tests.
//
// Pins the wire shape of `toBusinessOwnerView` and the rejection
// surface in particular — the most-recent `REJECT_BUSINESS` row's
// notes flow from `admin_actions` through the `me.business`
// handler into a `BusinessOwnerView.rejection` envelope. This
// test class fixes that contract independent of the handler so a
// refactor of either side has to update the test deliberately.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Business } from '../../shared/domains/businesses/businessRepository.js';
import {
    toBusinessOwnerView,
    type BusinessRejection,
} from '../../shared/domains/businesses/businessView.js';

function makeBusiness(overrides: Partial<Business> = {}): Business {
    const now = new Date('2026-05-14T12:00:00.000Z');
    return Object.freeze({
        id: 'biz-1',
        ownerUserId: 'owner-1',
        categoryId: 'cat-1',
        name: 'Test Salon',
        description: { en: 'A test salon.' },
        city: 'Addis Ababa',
        addressLine: null,
        latitude: null,
        longitude: null,
        phone: null,
        telegramHandle: null,
        whatsappPhone: null,
        status: 'REJECTED',
        featuredUntil: null,
        ratingAvg: 0,
        ratingCount: 0,
        createdAt: now,
        updatedAt: now,
        searchRank: null,
        ...overrides,
    });
}

describe('toBusinessOwnerView', () => {
    it('includes status + ownerUserId on the projection', () => {
        const business = makeBusiness({ status: 'APPROVED' });
        const view = toBusinessOwnerView(business);

        assert.strictEqual(view.status, 'APPROVED');
        assert.strictEqual(view.ownerUserId, 'owner-1');
    });

    it('leaves rejection null when no options are supplied', () => {
        // Most call sites pass no second arg — the create / patch /
        // submit / admin-mutation handlers return the freshly-
        // mutated row without an audit lookup. Their owner views
        // must not surface a rejection envelope.
        const business = makeBusiness({ status: 'APPROVED' });
        const view = toBusinessOwnerView(business);
        assert.strictEqual(view.rejection, null);
    });

    it('leaves rejection null when an empty options object is supplied', () => {
        const business = makeBusiness({ status: 'APPROVED' });
        const view = toBusinessOwnerView(business, {});
        assert.strictEqual(view.rejection, null);
    });

    it('attaches the rejection envelope when supplied', () => {
        // The me.business handler is the only call site that
        // supplies this — it queries admin_actions for the most-
        // recent REJECT_BUSINESS row when the business is REJECTED
        // and threads the result through here.
        const rejection: BusinessRejection = {
            reason: 'Photo of license is unreadable.',
            rejectedAt: '2026-05-13T09:00:00.000Z',
        };
        const business = makeBusiness({ status: 'REJECTED' });
        const view = toBusinessOwnerView(business, { rejection });

        assert.deepStrictEqual(view.rejection, rejection);
        assert.strictEqual(view.status, 'REJECTED');
    });

    it('allows the rejection envelope to carry a null reason', () => {
        // The admin SPA labels the reject-dialog field "Reason
        // (recommended)" — recommended but not required, so the
        // backend may persist null in admin_actions.notes. The
        // wire shape preserves that nullability.
        const rejection: BusinessRejection = {
            reason: null,
            rejectedAt: '2026-05-13T09:00:00.000Z',
        };
        const business = makeBusiness({ status: 'REJECTED' });
        const view = toBusinessOwnerView(business, { rejection });

        assert.strictEqual(view.rejection?.reason, null);
        assert.strictEqual(view.rejection?.rejectedAt, '2026-05-13T09:00:00.000Z');
    });

    it('freezes the returned view (defensive against caller mutation)', () => {
        const view = toBusinessOwnerView(makeBusiness());
        assert.strictEqual(Object.isFrozen(view), true);
    });
});
