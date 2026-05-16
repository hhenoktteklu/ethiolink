// EthioLink — Lambda handler for
// `GET /v1/admin/businesses/{id}/payment-intents`.
//
// Phase 10 commit 6. Authenticated, ADMIN-only. Read-only per-
// business reconciliation listing. The admin SPA's
// `BusinessDetailPage` mounts the "Payments" panel against this
// endpoint, then renders the rows in newest-first order.
//
// No mutations — refund / void surfaces are deferred to a Phase
// 10.5 follow-up alongside the real refund policy.
//
// Path parameters:
//   * id — business UUID. 400 VALIDATION_ERROR on a malformed
//          UUID; 200 with `items: []` if the business has zero
//          recorded payment intents.
//
// Query parameters:
//   * limit — 1..200. Defaults to 100. The admin reconciliation
//             page is unpaginated; a higher cap is the future
//             follow-up if a business sustains > 200 intents per
//             page-load (unlikely in MVP volume).

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../../shared/db/pgClient.js';
import { PgPaymentIntentsRepository } from '../../../shared/domains/payments/paymentIntentsRepository.js';
import { toPaymentIntentList } from '../../../shared/domains/payments/paymentIntentView.js';
import { PgUserRepository } from '../../../shared/domains/users/userRepository.js';
import { UserService } from '../../../shared/domains/users/userService.js';
import {
    internalError,
    ok,
    unauthenticated,
    validationError,
} from '../../../shared/http/responses.js';
import { UUID_RE } from '../../../shared/http/validation.js';
import { createLogger } from '../../../shared/logging/logger.js';

import { authorizeAdmin } from '../_authz.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const paymentIntentsRepo = new PgPaymentIntentsRepository(pool);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.payments.listForBusiness',
    });

    try {
        const authz = await authorizeAdmin(event, authProvider, userService);
        if (!authz.ok) return authz.response;

        const businessId = (event.pathParameters?.businessId ?? '').trim();
        if (!businessId || !UUID_RE.test(businessId)) {
            return validationError('Business id must be a UUID.', {
                field: 'businessId',
            });
        }

        const limitResult = parseLimit(event);
        if ('error' in limitResult) return limitResult.error;

        const rows = await paymentIntentsRepo.listForBusiness(
            businessId,
            limitResult.value,
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
        logger.error('admin.payments.listForBusiness.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseLimit(
    event: APIGatewayProxyEvent,
): { readonly value: number } | { readonly error: APIGatewayProxyResult } {
    const raw = event.queryStringParameters?.limit?.trim();
    if (raw === undefined || raw === '') return { value: DEFAULT_LIMIT };
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return {
            error: validationError(
                `limit must be an integer between 1 and ${MAX_LIMIT}.`,
                { field: 'limit', value: raw },
            ),
        };
    }
    return { value: parsed };
}
