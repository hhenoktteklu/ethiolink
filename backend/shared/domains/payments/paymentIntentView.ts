// EthioLink — payment_intents wire shape.
//
// Phase 10 commit 6. Admin-only reconciliation view returned by:
//
//   * GET /v1/admin/businesses/{id}/payment-intents
//   * GET /v1/admin/payment-intents
//
// Mirrors the database row 1:1 with the existing project convention
// of ISO-8601 timestamps + camelCase keys. `rawResponse` is
// deliberately included — the admin reconciliation flow inspects
// the provider's verify-response payload to spot drift between our
// recorded status and the provider's canonical state.
//
// The `purpose` field is a derived discriminator: `APPOINTMENT`
// when `appointmentId` is non-null, `FEATURING` when
// `featuringSubscriptionId` is non-null. The XOR `CHECK` constraint
// on the table guarantees exactly one is set; the view exposes the
// derived label so admin SPA consumers can filter without testing
// both columns.

import type { PaymentIntent } from './paymentIntentsRepository.js';

export type PaymentIntentPurpose = 'APPOINTMENT' | 'FEATURING';

export interface PaymentIntentView {
    readonly id: string;
    readonly appointmentId: string | null;
    readonly featuringSubscriptionId: string | null;
    readonly purpose: PaymentIntentPurpose;
    readonly provider: string;
    readonly amountEtb: number;
    /** Currency code. Always `'ETB'` in MVP — recorded explicitly so a future widening lands cleanly. */
    readonly currency: 'ETB';
    readonly status: string;
    readonly providerRef: string | null;
    readonly rawResponse: unknown | null;
    /** ISO-8601 UTC datetime. */
    readonly createdAt: string;
    /** ISO-8601 UTC datetime. */
    readonly updatedAt: string;
}

export interface PaymentIntentList {
    readonly items: readonly PaymentIntentView[];
}

export function toPaymentIntentView(row: PaymentIntent): PaymentIntentView {
    // The XOR constraint guarantees exactly one of these is set;
    // we derive the discriminator defensively (a malformed row
    // with both null would still classify as APPOINTMENT, which
    // is the historical-default to surface odd data rather than
    // hide it).
    const purpose: PaymentIntentPurpose =
        row.featuringSubscriptionId !== null ? 'FEATURING' : 'APPOINTMENT';
    return Object.freeze<PaymentIntentView>({
        id: row.id,
        appointmentId: row.appointmentId,
        featuringSubscriptionId: row.featuringSubscriptionId,
        purpose,
        provider: row.provider,
        amountEtb: row.amountEtb,
        currency: 'ETB',
        status: row.status,
        providerRef: row.providerRef,
        rawResponse: row.rawResponse ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    });
}

export function toPaymentIntentList(
    rows: readonly PaymentIntent[],
): PaymentIntentList {
    return Object.freeze<PaymentIntentList>({
        items: Object.freeze(rows.map(toPaymentIntentView)),
    });
}
