// EthioLink — payment gateway factory.
//
// Phase 10 first commit. Central construction site for the payment
// gateway pair (`cashGateway` + `onlineGateway`) every appointment
// + featuring Lambda needs. Replaces the hand-construction sites
// scattered across `backend/lambdas/appointments/*.ts` +
// `backend/lambdas/featuring/subscribe.ts` — those call sites move
// onto this factory in the follow-up commit
// (`Phase 10: route online appointments through Chapa`). The
// factory ships in this commit so the wiring change can land
// independently and the appointment / featuring services don't
// have to change their construction pattern in the same diff that
// introduces the new gateway.
//
// Production behaviour stays unchanged because no call site
// consumes the factory yet — the appointment Lambdas still build
// `new CashGateway()` + `new MockOnlineGateway()` inline.
//
// Routing rules:
//
//   * `config.paymentsProvider === 'mock'` (default) →
//     `online: MockOnlineGateway`. Every `ONLINE_PENDING`
//     authorize throws `OnlinePaymentsUnavailableError`. No
//     change from Phase 9.
//
//   * `config.paymentsProvider === 'chapa'` AND
//     `config.chapaProvider !== null` →
//     `online: ChapaGateway`. The gateway initiates a real Chapa
//     hosted checkout and returns PENDING + a redirect URL.
//
//   * `config.paymentsProvider === 'chapa'` AND
//     `config.chapaProvider === null` → THROWS at factory call
//     time. The operator opted in to Chapa but didn't wire the
//     credentials; we'd rather fail the cold start than silently
//     route through the mock when the operator intended otherwise.
//     Mirrors the SMS / Telegram factory contract.
//
// The cash gateway is always wired — `paymentsProvider` only
// affects the online slot.

import { CashGateway } from '../adapters/payments/CashGateway.js';
import { ChapaGateway } from '../adapters/payments/ChapaGateway.js';
import type { ChapaHttpTransport } from '../adapters/payments/ChapaGateway.js';
import { MockOnlineGateway } from '../adapters/payments/MockOnlineGateway.js';
import type { PaymentGateway } from '../adapters/payments/PaymentGateway.js';
import { PaymentGatewayError } from '../adapters/payments/PaymentGateway.js';
import type { AppConfig } from '../config/loadConfig.js';

/**
 * Pair returned by the factory. The `cash` gateway always handles
 * `CASH` appointment payments and never returns PENDING; the
 * `online` gateway handles `ONLINE_PENDING` appointments + paid
 * featuring purchases, and may return PENDING + a `redirectUrl`
 * when wired to a real provider.
 */
export interface PaymentGatewayPair {
    readonly cash: PaymentGateway;
    readonly online: PaymentGateway;
}

/**
 * Options accepted by {@link createPaymentGateways}. The Chapa
 * transport is injectable for tests; production passes the default
 * fetch-based transport (which the gateway picks up internally
 * when the caller omits it).
 */
export interface CreatePaymentGatewaysOptions {
    /** Test seam — overrides the Chapa transport when the factory wires `ChapaGateway`. */
    readonly chapaTransport?: ChapaHttpTransport;
}

/**
 * Build the gateway pair from a resolved `AppConfig`. Throws when
 * the operator opted into Chapa but didn't wire the credentials —
 * see file header.
 */
export function createPaymentGateways(
    config: AppConfig,
    options: CreatePaymentGatewaysOptions = {},
): PaymentGatewayPair {
    const cash = new CashGateway();
    const online = buildOnlineGateway(config, options);
    return Object.freeze<PaymentGatewayPair>({ cash, online });
}

function buildOnlineGateway(
    config: AppConfig,
    options: CreatePaymentGatewaysOptions,
): PaymentGateway {
    switch (config.paymentsProvider) {
        case 'mock':
            return new MockOnlineGateway();
        case 'chapa':
            if (!config.chapaProvider) {
                throw new PaymentGatewayError(
                    'CHAPA_NOT_CONFIGURED',
                    'PAYMENTS_PROVIDER=chapa but CHAPA_SECRET_KEY / ' +
                        'CHAPA_WEBHOOK_SECRET / CHAPA_RETURN_URL are not all ' +
                        'set. Resolve the secrets via env or Secrets Manager.',
                );
            }
            return options.chapaTransport
                ? new ChapaGateway(config.chapaProvider, options.chapaTransport)
                : new ChapaGateway(config.chapaProvider);
        default: {
            // Exhaustiveness guard. `parseEnum` rejects unknown
            // values at config-load, so this branch is unreachable
            // in production. Throwing makes a future widening of
            // `PaymentsProvider` that forgets to extend this switch
            // loud rather than silent.
            const exhaustive: never = config.paymentsProvider;
            throw new PaymentGatewayError(
                'PAYMENTS_PROVIDER_UNKNOWN',
                `Unhandled PAYMENTS_PROVIDER value: ${String(exhaustive)}`,
            );
        }
    }
}
