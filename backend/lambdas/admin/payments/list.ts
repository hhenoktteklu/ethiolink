// EthioLink — Lambda handler for `GET /v1/admin/payment-intents`.
//
// Phase 10 commit 6. Authenticated, ADMIN-only. Cross-business
// reconciliation read; the operator's mental model is "show me
// every payment intent in the last week so I can match against
// Chapa's payout statement". Mirrors the structure of the
// `/v1/admin/notifications` and `/v1/admin/appointments` listings.
//
// Query parameters (all optional):
//   * from       — ISO-8601 datetime, inclusive lower bound on
//                  `created_at`.
//   * to         — ISO-8601 datetime, exclusive upper bound.
//   * provider   — CASH / MOCK / TELEBIRR / CHAPA / CBE_BIRR.
//   * status     — PENDING / SUCCEEDED / FAILED / CANCELLED.
//   * limit      — integer 1..200. Defaults to 100.
//
// Sort: `created_at DESC, id DESC` — newest first.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../../shared/adapters/auth/CognitoAuthProvider.js';
import type { PaymentProvider } from '../../../shared/adapters/payments/PaymentGateway.js';
import { loadSecretsThenConfig } from '../../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../../shared/db/pgClient.js';
import {
    PgPaymentIntentsRepository,
    type PaymentIntentStatus,
} from '../../../shared/domains/payments/paymentIntentsRepository.js';
import { toPaymentIntentList } from '../../../shared/domains/payments/paymentIntentView.js';
import { PgUserRepository } from '../../../shared/domains/users/userRepository.js';
import { UserService } from '../../../shared/domains/users/userService.js';
import {
    internalError,
    ok,
    unauthenticated,
    validationError,
} from '../../../shared/http/responses.js';
import { createLogger } from '../../../shared/logging/logger.js';

import { authorizeAdmin } from '../_authz.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const PROVIDERS: readonly PaymentProvider[] = [
    'CASH',
    'MOCK',
    'TELEBIRR',
    'CHAPA',
    'CBE_BIRR',
];

const STATUSES: readonly PaymentIntentStatus[] = [
    'PENDING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
];

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const paymentIntentsRepo = new PgPaymentIntentsRepository(pool);

interface ParsedFilters {
    readonly fromUtc?: Date;
    readonly toUtc?: Date;
    readonly provider?: PaymentProvider;
    readonly status?: PaymentIntentStatus;
    readonly limit: number;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.payments.list',
    });

    try {
        const authz = await authorizeAdmin(event, authProvider, userService);
        if (!authz.ok) return authz.response;

        const parsed = parseQuery(event);
        if ('error' in parsed) return parsed.error;

        const rows = await paymentIntentsRepo.listAll(
            {
                fromUtc: parsed.fromUtc,
                toUtc: parsed.toUtc,
                provider: parsed.provider,
                status: parsed.status,
            },
            parsed.limit,
        );
        return ok(toPaymentIntentList(rows));
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
        logger.error('admin.payments.list.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseQuery(
    event: APIGatewayProxyEvent,
): ParsedFilters | { readonly error: APIGatewayProxyResult } {
    const qs = event.queryStringParameters ?? {};

    let provider: PaymentProvider | undefined;
    const providerRaw = qs.provider?.trim();
    if (providerRaw !== undefined && providerRaw !== '') {
        const upper = providerRaw.toUpperCase();
        if (!PROVIDERS.includes(upper as PaymentProvider)) {
            return {
                error: validationError(
                    `provider must be one of: ${PROVIDERS.join(', ')}.`,
                    { field: 'provider', allowed: PROVIDERS },
                ),
            };
        }
        provider = upper as PaymentProvider;
    }

    let status: PaymentIntentStatus | undefined;
    const statusRaw = qs.status?.trim();
    if (statusRaw !== undefined && statusRaw !== '') {
        const upper = statusRaw.toUpperCase();
        if (!STATUSES.includes(upper as PaymentIntentStatus)) {
            return {
                error: validationError(
                    `status must be one of: ${STATUSES.join(', ')}.`,
                    { field: 'status', allowed: STATUSES },
                ),
            };
        }
        status = upper as PaymentIntentStatus;
    }

    const fromUtc = parseOptionalDatetime(qs.from, 'from');
    if (fromUtc && 'error' in fromUtc) return fromUtc;

    const toUtc = parseOptionalDatetime(qs.to, 'to');
    if (toUtc && 'error' in toUtc) return toUtc;

    let limit = DEFAULT_LIMIT;
    const limitRaw = qs.limit?.trim();
    if (limitRaw !== undefined && limitRaw !== '') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
            return {
                error: validationError(
                    `limit must be an integer between 1 and ${MAX_LIMIT}.`,
                    { field: 'limit', value: limitRaw },
                ),
            };
        }
        limit = parsed;
    }

    return {
        fromUtc: fromUtc ? fromUtc.value : undefined,
        toUtc: toUtc ? toUtc.value : undefined,
        provider,
        status,
        limit,
    };
}

function parseOptionalDatetime(
    raw: string | undefined,
    field: string,
):
    | { readonly value: Date }
    | { readonly error: APIGatewayProxyResult }
    | undefined {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
        return {
            error: validationError(
                `${field} must be a valid ISO-8601 datetime.`,
                { field, value: trimmed },
            ),
        };
    }
    return { value: parsed };
}
