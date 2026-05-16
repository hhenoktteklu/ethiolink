// EthioLink — Lambda handler for `POST /v1/integrations/chapa/webhook`.
//
// Phase 10 commit 3. Public route Chapa posts to after a customer
// completes (or cancels) a hosted checkout. Authentication is via
// the `Chapa-Signature` header — Chapa signs every webhook payload
// with HMAC-SHA256 using the merchant's webhook secret. We compute
// the expected signature over the raw request body, constant-time
// compare, and reject mismatches with 401.
//
// Trust posture:
//
//   The webhook body is NOT trusted as the source of truth for the
//   transaction outcome. After signature validation, the handler
//   calls `paymentGateway.verify(tx_ref)` against Chapa's
//   `/v1/transaction/verify/:tx_ref` endpoint, which returns the
//   canonical, authoritative status. The webhook body is only used
//   to (a) authenticate the caller and (b) extract the `tx_ref`
//   we'll verify against. This defense-in-depth posture means a
//   replayed-but-tampered webhook body still produces correct
//   domain state because we re-fetch from Chapa.
//
// Branches:
//
//   * Signature mismatch → 401 UNAUTHENTICATED.
//   * Telegram-style webhook-not-configured (env hasn't wired
//     Chapa) → 503 INTERNAL_ERROR.
//   * Malformed body → 200 (Chapa retries 5xx forever; we don't
//     want a stuck loop on a bad payload).
//   * Unknown `tx_ref` (no row in `payment_intents`) → 200 +
//     warning log. The webhook was authentic but we have no
//     domain context — either the row was already GCed by the
//     sweep, or the service-side INSERT errored.
//   * `verify` returns SUCCEEDED →
//       - mark `payment_intents` SUCCEEDED (idempotent).
//       - if the row points at a featuring subscription →
//         `featuringService.activateFromPayment(subscriptionId)`.
//       - if the row points at an appointment →
//         `appointmentService.markPaymentSucceeded(appointmentId)`.
//   * `verify` returns FAILED →
//       - mark `payment_intents` FAILED (idempotent; refused if
//         already SUCCEEDED).
//       - if appointment → `markPaymentFailed`.
//       - featuring row stays PENDING_PAYMENT for the sweep to GC.
//   * `verify` returns PENDING → 200; Chapa's own state hasn't
//     settled yet, we wait for the next webhook.
//   * `verify` throws `ChapaUnavailable` (transport / 5xx) → 500;
//     Chapa retries with exponential backoff.
//   * `verify` throws `ChapaInvalidRequest` (tx_ref not in Chapa's
//     system) → 200 + log; defending against forged tx_refs.
//
// Idempotency:
//
//   Every mutating call below is idempotent against replay. The
//   `payment_intents` CAS-update refuses to downgrade a SUCCEEDED
//   row; `featuringService.activateFromPayment` is a no-op against
//   an already-ACTIVE subscription; `appointmentService.markPayment*`
//   currently log-only. Chapa will retry this webhook up to 24h
//   under its standard backoff policy; that's by design and our
//   handler tolerates it.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    PaymentGatewayError,
    type PaymentGateway,
} from '../../shared/adapters/payments/PaymentGateway.js';
import { ChapaUnavailableError } from '../../shared/adapters/payments/ChapaGateway.js';
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { createPaymentGateways } from '../../shared/factories/paymentGatewayFactory.js';
import {
    AppointmentService,
} from '../../shared/domains/appointments/appointmentService.js';
import { PgAppointmentsRepository } from '../../shared/domains/appointments/appointmentsRepository.js';
import { PgAvailabilityRepository } from '../../shared/domains/availability/availabilityRepository.js';
import { SlotService } from '../../shared/domains/availability/slotService.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgFeaturingRepository } from '../../shared/domains/featuring/featuringRepository.js';
import {
    FeaturingService,
    InvalidActivationStateError,
    NoActiveSubscriptionError,
} from '../../shared/domains/featuring/featuringService.js';
import {
    PgPaymentIntentsRepository,
    type PaymentIntent,
    type PaymentIntentsRepository,
} from '../../shared/domains/payments/paymentIntentsRepository.js';
import { PgServiceRepository } from '../../shared/domains/services/serviceRepository.js';
import { PgStaffRepository } from '../../shared/domains/staff/staffRepository.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import {
    createNotificationService,
    shouldWireSmsGateway,
    shouldWireTelegramGateway,
} from '../../shared/domains/notifications/notificationServiceFactory.js';
import {
    errorResponse,
    internalError,
    ok,
} from '../../shared/http/responses.js';
import { createLogger, type Logger } from '../../shared/logging/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChapaWebhookDeps {
    /** Plain-text webhook signing secret. Empty → handler returns 503. */
    readonly webhookSecret: string;
    /** Online payment gateway. The handler calls `verify(tx_ref)`. */
    readonly paymentGateway: PaymentGateway | null;
    readonly paymentIntentsRepo: PaymentIntentsRepository;
    readonly featuringService: FeaturingService;
    readonly appointmentService: AppointmentService;
    readonly logger: Logger;
}

// Header Chapa includes on every webhook. Different SDKs use
// slightly different cases — we tolerate the standard spellings.
const SIGNATURE_HEADER_NAMES = [
    'Chapa-Signature',
    'chapa-signature',
    'CHAPA-SIGNATURE',
    'X-Chapa-Signature',
    'x-chapa-signature',
] as const;

export async function handleWebhook(
    deps: ChapaWebhookDeps,
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
    const logger = deps.logger.child({ handler: 'integrations.chapaWebhook' });

    // 1. Env-gating. If Chapa isn't configured for this env, the
    //    webhook should never have been wired up — return 503 so
    //    the operator notices via Chapa's webhook delivery
    //    dashboard. We check the secret + the gateway slot
    //    together; both need to be present for the handler to
    //    function.
    if (!deps.webhookSecret || !deps.paymentGateway) {
        logger.warn('chapa.webhook.service_unavailable');
        return errorResponse(
            503,
            'INTERNAL_ERROR',
            'Chapa integration is not configured for this environment.',
        );
    }

    // 2. Signature gate. Compute the expected HMAC-SHA256 of the
    //    raw request body using the webhook secret; constant-time
    //    compare against the header. Mismatch → 401. We use the
    //    raw `event.body` string verbatim — JSON re-stringification
    //    would mangle whitespace and break the signature.
    const rawBody = event.body ?? '';
    const headerSignature = readSignatureHeader(event);
    if (
        !headerSignature ||
        !verifySignature(rawBody, headerSignature, deps.webhookSecret)
    ) {
        logger.warn('chapa.webhook.unauthorized', {
            hasHeader: headerSignature !== null,
        });
        return errorResponse(
            401,
            'UNAUTHENTICATED',
            'Invalid Chapa webhook signature.',
        );
    }

    // 3. Parse body. Anything that isn't well-formed JSON gets
    //    200'd so Chapa stops retrying — a forged-but-correctly-
    //    signed garbage payload is impossible (the signature gate
    //    above is binding), so we treat malformed bodies as
    //    benign and just log them.
    let parsed: Record<string, unknown> | null = null;
    try {
        const obj = rawBody ? JSON.parse(rawBody) : null;
        parsed = obj && typeof obj === 'object' && !Array.isArray(obj)
            ? (obj as Record<string, unknown>)
            : null;
    } catch {
        logger.warn('chapa.webhook.malformed_body');
        return ok({ ok: true, handled: false, reason: 'malformed_body' });
    }
    const txRef = extractTxRef(parsed);
    if (!txRef) {
        logger.warn('chapa.webhook.missing_tx_ref');
        return ok({ ok: true, handled: false, reason: 'missing_tx_ref' });
    }

    // 4. Trust nothing in the body beyond `tx_ref`. Re-fetch the
    //    canonical state from Chapa.
    let verified;
    try {
        verified = await deps.paymentGateway.verify(txRef);
    } catch (err) {
        if (err instanceof ChapaUnavailableError) {
            // Provider unreachable; 500 so Chapa retries later.
            logger.error('chapa.webhook.verify_unavailable', {
                txRef,
                error: err.message,
            });
            return internalError();
        }
        if (err instanceof PaymentGatewayError) {
            // 4xx from Chapa — tx_ref didn't exist upstream, or
            // some other config error. 200 to prevent retry loops;
            // log loudly so the operator sees it in CloudWatch.
            logger.warn('chapa.webhook.verify_invalid_request', {
                txRef,
                code: err.code,
                message: err.message,
            });
            return ok({ ok: true, handled: false, reason: 'verify_rejected' });
        }
        logger.error('chapa.webhook.verify_failed', {
            txRef,
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }

    if (verified.status === 'PENDING') {
        // Chapa's own state hasn't settled. Acknowledge; the next
        // webhook (Chapa's retry) lands the terminal outcome.
        logger.info('chapa.webhook.verify_pending', { txRef });
        return ok({ ok: true, handled: false, reason: 'verify_pending' });
    }

    // 5. Look up the payment_intents row. This is the bridge from
    //    the gateway's tx_ref into our domain. Unknown rows are
    //    logged + 200'd so Chapa stops retrying.
    let row = await deps.paymentIntentsRepo.findByProviderRef(txRef);
    if (!row) {
        logger.warn('chapa.webhook.unknown_tx_ref', { txRef });
        return ok({ ok: true, handled: false, reason: 'unknown_tx_ref' });
    }

    // 6. Idempotent terminal-state write. The repo's CAS update
    //    refuses to downgrade SUCCEEDED → FAILED; both methods
    //    return the current row regardless.
    if (verified.status === 'SUCCEEDED') {
        const updated = await deps.paymentIntentsRepo.markSucceeded(
            row.id,
            verified.rawResponse,
        );
        row = updated ?? row;
        await dispatchSucceeded(deps, row, logger);
    } else if (verified.status === 'FAILED') {
        const updated = await deps.paymentIntentsRepo.markFailed(
            row.id,
            verified.rawResponse,
        );
        row = updated ?? row;
        await dispatchFailed(deps, row, logger);
    }

    return ok({
        ok: true,
        handled: true,
        txRef,
        status: row.status,
    });
}

// ---------------------------------------------------------------------------
// Domain dispatch
// ---------------------------------------------------------------------------

async function dispatchSucceeded(
    deps: ChapaWebhookDeps,
    row: PaymentIntent,
    logger: Logger,
): Promise<void> {
    if (row.featuringSubscriptionId) {
        try {
            await deps.featuringService.activateFromPayment(
                row.featuringSubscriptionId,
            );
            logger.info('chapa.webhook.featuring_activated', {
                subscriptionId: row.featuringSubscriptionId,
                providerRef: row.providerRef,
            });
        } catch (err) {
            // Both errors are logical no-ops at the webhook layer:
            // a stale subscription id (sweep-GCed) or one already in
            // a terminal state. Neither warrants a retry.
            if (
                err instanceof NoActiveSubscriptionError ||
                err instanceof InvalidActivationStateError
            ) {
                logger.warn('chapa.webhook.featuring_activation_skipped', {
                    subscriptionId: row.featuringSubscriptionId,
                    reason: err.message,
                });
                return;
            }
            throw err;
        }
        return;
    }
    if (row.appointmentId) {
        await deps.appointmentService.markPaymentSucceeded(row.appointmentId);
        logger.info('chapa.webhook.appointment_payment_succeeded', {
            appointmentId: row.appointmentId,
            providerRef: row.providerRef,
        });
        return;
    }
    // XOR CHECK on the table makes one of the two FKs non-null,
    // so this branch is unreachable — defensive log only.
    logger.warn('chapa.webhook.row_without_target', {
        paymentIntentId: row.id,
    });
}

async function dispatchFailed(
    deps: ChapaWebhookDeps,
    row: PaymentIntent,
    logger: Logger,
): Promise<void> {
    if (row.appointmentId) {
        await deps.appointmentService.markPaymentFailed(row.appointmentId);
        logger.info('chapa.webhook.appointment_payment_failed', {
            appointmentId: row.appointmentId,
            providerRef: row.providerRef,
        });
        return;
    }
    if (row.featuringSubscriptionId) {
        // The featuring sweep (every 15 min) GCs PENDING_PAYMENT
        // rows past the 10-min TTL. We deliberately do NOT
        // transition the subscription to a terminal state here —
        // the customer may retry payment.
        logger.info('chapa.webhook.featuring_payment_failed', {
            subscriptionId: row.featuringSubscriptionId,
            providerRef: row.providerRef,
        });
        return;
    }
    logger.warn('chapa.webhook.row_without_target', { paymentIntentId: row.id });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSignatureHeader(event: APIGatewayProxyEvent): string | null {
    const headers = event.headers ?? {};
    for (const name of SIGNATURE_HEADER_NAMES) {
        const v = headers[name];
        if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
}

/**
 * HMAC-SHA256 verification. Chapa signs the raw request body using
 * the webhook secret. We compute the expected hex digest and
 * constant-time compare against the header.
 *
 * Some Chapa SDKs prefix the header with `sha256=` (Stripe-style);
 * we strip the prefix defensively.
 */
function verifySignature(
    rawBody: string,
    headerSignature: string,
    secret: string,
): boolean {
    if (!headerSignature || !secret) return false;
    const presented = headerSignature.replace(/^sha256=/i, '').trim();
    let expected: string;
    try {
        expected = createHmac('sha256', secret)
            .update(rawBody, 'utf8')
            .digest('hex');
    } catch {
        return false;
    }
    const a = Buffer.from(presented, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    try {
        return timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function extractTxRef(body: Record<string, unknown> | null): string | null {
    if (!body) return null;
    // Chapa's standard webhook payload nests transaction info under
    // `data` (matching their verify-response shape). Some test
    // payloads put `tx_ref` at the top level; we accept both.
    const direct = body.tx_ref;
    if (typeof direct === 'string' && direct.length > 0) return direct.trim();
    const data = body.data;
    if (typeof data === 'object' && data !== null) {
        const inner = (data as Record<string, unknown>).tx_ref;
        if (typeof inner === 'string' && inner.length > 0) return inner.trim();
    }
    return null;
}

// ---------------------------------------------------------------------------
// Production wiring (lazy).
// ---------------------------------------------------------------------------

let cachedDeps: ChapaWebhookDeps | null = null;

async function getProductionDeps(): Promise<ChapaWebhookDeps> {
    if (cachedDeps) return cachedDeps;
    const config = await loadSecretsThenConfig();
    const baseLogger = createLogger({ level: config.logLevel });
    const pool = getPool(config);

    const gateways = createPaymentGateways(config);
    const onlineGateway: PaymentGateway | null =
        config.paymentsProvider === 'chapa' ? gateways.online : null;

    const appointmentsRepo = new PgAppointmentsRepository(pool);
    const businessRepo = new PgBusinessRepository(pool);
    const serviceRepo = new PgServiceRepository(pool);
    const staffRepo = new PgStaffRepository(pool);
    const userRepo = new PgUserRepository(pool);
    const availabilityRepo = new PgAvailabilityRepository(pool);
    const featuringRepo = new PgFeaturingRepository(pool);
    const paymentIntentsRepo = new PgPaymentIntentsRepository(pool);
    const notificationService = createNotificationService({
        pool,
        config,
        logger: baseLogger,
    });

    const appointmentService = new AppointmentService({
        appointmentsRepo,
        businessRepo,
        serviceRepo,
        userRepo,
        slotService: new SlotService(
            availabilityRepo,
            staffRepo,
            serviceRepo,
            appointmentsRepo,
            {
                slotStepMinutes: config.booking.slotStepMinutes,
                bufferMinutes: config.booking.bufferMinutes,
                timezone: config.booking.defaultTimezone,
            },
        ),
        cashGateway: gateways.cash,
        onlineGateway: gateways.online,
        notificationService,
        logger: baseLogger,
        options: {
            cancelCutoffMinutes: config.booking.cancelCutoffMinutes,
            timezone: config.booking.defaultTimezone,
            smsRoutingEnabled: shouldWireSmsGateway(config),
            telegramRoutingEnabled: shouldWireTelegramGateway(config),
        },
    });

    const featuringService = new FeaturingService({
        featuringRepo,
        businessRepo,
        paymentGateway: gateways.online,
        config: config.featuring,
    });

    cachedDeps = {
        webhookSecret: config.chapaProvider?.webhookSecret ?? '',
        paymentGateway: onlineGateway,
        paymentIntentsRepo,
        featuringService,
        appointmentService,
        logger: baseLogger,
    };
    return cachedDeps;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const deps = await getProductionDeps();
    return handleWebhook(
        {
            ...deps,
            logger: deps.logger.child({
                requestId: event.requestContext.requestId,
            }),
        },
        event,
    );
};

