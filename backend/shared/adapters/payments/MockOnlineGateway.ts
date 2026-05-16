// EthioLink — mock online-payments gateway.
//
// MVP placeholder for the `ONLINE_PENDING` payment method. Real
// online providers (Telebirr, Chapa, CBE Birr) are post-MVP and will
// each ship as their own `PaymentGateway` implementation behind this
// same port. Until then, every `authorize` call throws
// `OnlinePaymentsUnavailableError` so the booking service can refuse
// online attempts with a clear 400.
//
// Why a typed error instead of returning `status: 'FAILED'`:
//   * `FAILED` means "the user's payment was declined" — a normal
//     business outcome that should be persisted to `payment_intents`
//     and surfaced to the caller as a 200 with a domain payload.
//   * `OnlinePaymentsUnavailableError` means "this code path is not
//     implemented" — the booking service should reject the request
//     outright with a `400 ONLINE_PAYMENTS_UNAVAILABLE` and not write
//     anything to `payment_intents`. The error class makes the two
//     cases unambiguously distinguishable.
//
// When Telebirr / Chapa / CBE Birr ship, `MockOnlineGateway` either
// stays around as a config-toggled smoke gateway for local dev or
// gets deleted — that's a Phase-6+ decision. The `provider: 'MOCK'`
// identifier matches the `payment_intents.provider` CHECK list so a
// future real-MOCK gateway (e.g. one that always succeeds for
// integration tests) can slot in without a schema change.

import type {
    PaymentAuthorization,
    PaymentAuthorizationInput,
    PaymentGateway,
} from './PaymentGateway.js';
import {
    OnlinePaymentsUnavailableError,
    PaymentVerificationUnsupportedError,
} from './PaymentGateway.js';

const UNAVAILABLE_MESSAGE =
    'Online payments are not yet available. Please select cash payment.';

export class MockOnlineGateway implements PaymentGateway {
    public readonly provider = 'MOCK' as const;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params required by interface.
    async authorize(_input: PaymentAuthorizationInput): Promise<PaymentAuthorization> {
        throw new OnlinePaymentsUnavailableError(UNAVAILABLE_MESSAGE);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params required by interface.
    async verify(_providerRef: string): Promise<PaymentAuthorization> {
        // The mock gateway never authorizes anything, so no
        // `payment_intents` row ever points at provider = 'MOCK' with
        // a non-null `provider_ref`. A `verify` call on the mock is
        // therefore unreachable in production; throwing the typed
        // error makes a misrouted webhook loud.
        throw new PaymentVerificationUnsupportedError('MOCK');
    }
}
