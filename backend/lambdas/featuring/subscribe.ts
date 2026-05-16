// EthioLink — Lambda handler for
// `POST /v1/businesses/{businessId}/featuring/subscribe`.
//
// Authenticated, BUSINESS_OWNER (owner-of-id). Creates a
// `PENDING_PAYMENT` subscription, calls the payment gateway,
// then transitions to ACTIVE on SUCCEEDED (the cash dev path)
// or returns the pending row for an async upstream (future
// Telebirr).
//
// Body shape:  { "packageCode": "FEATURING_7D" | "FEATURING_30D" }
//
// Service-error mapping:
//   * FeaturingDisabledError              → 503 FEATURING_DISABLED
//   * UnknownPackageError                 → 400 VALIDATION_ERROR
//   * AlreadyActiveError                  → 409 CONFLICT
//   * PaymentFailedError                  → 402 PAYMENT_REQUIRED
//   * OnlinePaymentsUnavailableError      → 503 ONLINE_PAYMENTS_UNAVAILABLE
//   * Other PaymentGatewayError           → 500 INTERNAL_ERROR

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../shared/adapters/auth/AuthProvider.js';
import {
    OnlinePaymentsUnavailableError,
    PaymentGatewayError,
} from '../../shared/adapters/payments/PaymentGateway.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { createPaymentGateways } from '../../shared/factories/paymentGatewayFactory.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgFeaturingRepository } from '../../shared/domains/featuring/featuringRepository.js';
import { PgPaymentIntentsRepository } from '../../shared/domains/payments/paymentIntentsRepository.js';
import {
    AlreadyActiveError,
    FeaturingDisabledError,
    FeaturingService,
    PaymentFailedError,
    UnknownPackageError,
} from '../../shared/domains/featuring/featuringService.js';
import { toSubscribeFeaturingResponse } from '../../shared/domains/featuring/featuringView.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import {
    conflict,
    errorResponse,
    internalError,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import { UUID_RE, authorizeOwnerForBusiness } from './_authz.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const businessRepo = new PgBusinessRepository(pool);
const featuringRepo = new PgFeaturingRepository(pool);

// Phase 10 — factory selects the online gateway based on
// `config.paymentsProvider`. `mock` (default) keeps the previous
// behaviour where featuring uses `CashGateway` directly; `chapa`
// switches in `ChapaGateway` so subscribe initiates a real hosted
// checkout and returns PENDING + redirectUrl. The featuring path
// uses the ONLINE slot — featuring purchases are never cash-on-
// arrival; the operator settles out-of-band only under the mock
// path until Chapa flips on.
const paymentGateways = createPaymentGateways(config);

const featuringService = new FeaturingService({
    featuringRepo,
    businessRepo,
    paymentGateway:
        config.paymentsProvider === 'chapa'
            ? paymentGateways.online
            : paymentGateways.cash,
    config: config.featuring,
    // Phase 10 commit 4 — persists a payment_intents row when the
    // online gateway returns PENDING with a providerRef. Cash
    // SUCCEEDED outcomes (the default `payments_provider = mock`
    // path) never reach the persist branch because the
    // authorization carries `providerRef: null`.
    paymentIntentsRepo: new PgPaymentIntentsRepository(pool),
    logger: baseLogger,
});

const ALLOWED_PACKAGES = new Set(['FEATURING_7D', 'FEATURING_30D']);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'featuring.subscribe',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('Business id must be a UUID.', {
            field: 'businessId',
        });
    }

    let packageCode: 'FEATURING_7D' | 'FEATURING_30D';
    try {
        packageCode = parseBody(event.body);
    } catch (err) {
        if (err instanceof ValidationFailure) {
            return validationError(err.message, err.details);
        }
        throw err;
    }

    try {
        const authz = await authorizeOwnerForBusiness(event, businessId, {
            authProvider,
            userService,
            businessRepo,
        });
        if (!authz.ok) return authz.response;

        try {
            const { subscription, authorization } =
                await featuringService.subscribe({
                    businessId,
                    packageCode,
                    callerUserId: authz.user.id,
                });
            // Phase 10 — surface payment.redirectUrl when the gateway
            // returns PENDING (Chapa). Mobile reads this and opens
            // the hosted checkout; SUCCEEDED outcomes (Cash / Chapa
            // post-webhook) ship `redirectUrl: null`.
            return ok(toSubscribeFeaturingResponse(subscription, authorization));
        } catch (err) {
            if (err instanceof FeaturingDisabledError) {
                return errorResponse(503, 'FEATURING_DISABLED', err.message);
            }
            if (err instanceof UnknownPackageError) {
                return validationError(err.message, {
                    field: 'packageCode',
                    value: err.packageCode,
                });
            }
            if (err instanceof AlreadyActiveError) {
                return conflict(err.message);
            }
            if (err instanceof PaymentFailedError) {
                return errorResponse(
                    402,
                    err.authorization.errorCode ?? 'PAYMENT_REQUIRED',
                    err.message,
                );
            }
            if (err instanceof OnlinePaymentsUnavailableError) {
                return errorResponse(503, err.code, err.message);
            }
            if (err instanceof PaymentGatewayError) {
                logger.error('featuring.subscribe.gatewayFailure', {
                    code: err.code,
                    message: err.message,
                });
                return internalError();
            }
            throw err;
        }
    } catch (err) {
        if (
            err instanceof TokenExpiredError ||
            err instanceof TokenInvalidError ||
            err instanceof ClaimsMalformedError ||
            err instanceof AuthError
        ) {
            logger.warn('auth.unauthenticated', { reason: err.message });
            return unauthenticated(err.message);
        }
        logger.error('featuring.subscribe.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

class ValidationFailure extends Error {
    public readonly details: Record<string, unknown>;
    constructor(message: string, details: Record<string, unknown>) {
        super(message);
        this.name = 'ValidationFailure';
        this.details = details;
    }
}

function parseBody(rawBody: string | null): 'FEATURING_7D' | 'FEATURING_30D' {
    if (rawBody === null || rawBody.trim() === '') {
        throw new ValidationFailure('Body is required.', {
            field: 'packageCode',
        });
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBody);
    } catch {
        throw new ValidationFailure('Body must be valid JSON.', {});
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ValidationFailure('Body must be a JSON object.', {});
    }
    const code = (parsed as Record<string, unknown>).packageCode;
    if (typeof code !== 'string' || !ALLOWED_PACKAGES.has(code)) {
        throw new ValidationFailure(
            'packageCode must be FEATURING_7D or FEATURING_30D.',
            {
                field: 'packageCode',
                allowed: [...ALLOWED_PACKAGES],
            },
        );
    }
    return code as 'FEATURING_7D' | 'FEATURING_30D';
}
