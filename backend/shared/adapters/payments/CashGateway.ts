// EthioLink — cash payment gateway.
//
// MVP's primary payment path. Cash settles in person at the
// appointment, so `authorize` is a synchronous no-op that records
// SUCCEEDED. No upstream provider, no presigned redirect, no webhook.
//
// Per the schema doc (`DATABASE_SCHEMA.md` → `payment_intents`), cash
// bookings do not write a `payment_intents` row at all — the booking
// service consumes this SUCCEEDED result and skips the intent insert
// for `CASH`. Returning a structured authorization (rather than just
// "void") keeps the booking-service code uniform across payment
// methods.
//
// Design notes:
//   * `providerRef` and `rawResponse` are `null`. There is nothing
//     to reference and nothing to reconcile.
//   * `authorizedAt` is filled in with `new Date().toISOString()`. The
//     clock is the only side effect; sufficient for an MVP that
//     doesn't need injected time here. Future tests that need a
//     deterministic clock can inject one via constructor — postponed
//     until a real call site demands it.
//   * `idempotencyKey` is accepted but ignored. There is no upstream
//     to dedupe against.

import type {
    PaymentAuthorization,
    PaymentAuthorizationInput,
    PaymentGateway,
} from './PaymentGateway.js';

export class CashGateway implements PaymentGateway {
    public readonly provider = 'CASH' as const;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params required by interface.
    async authorize(_input: PaymentAuthorizationInput): Promise<PaymentAuthorization> {
        return Object.freeze<PaymentAuthorization>({
            status: 'SUCCEEDED',
            provider: 'CASH',
            providerRef: null,
            rawResponse: null,
            errorCode: null,
            errorMessage: null,
            authorizedAt: new Date().toISOString(),
        });
    }
}
