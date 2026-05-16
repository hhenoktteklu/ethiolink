// EthioLink — Lambda handler for
// `POST /v1/admin/businesses/{id}/featuring/comp`.
//
// Authenticated, ADMIN-only. Creates an ACTIVE featuring
// subscription with `source = ADMIN_COMP` and `price_etb = 0`.
// Used for editorial featuring (category launches, partner
// agreements) where money doesn't change hands.
//
// Body shape:
//   { "durationDays": 14, "reason": "Category launch promo" }
//
// Service-error mapping:
//   * AlreadyActiveError → 409 CONFLICT
//   * RangeError         → 400 VALIDATION_ERROR

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../../shared/adapters/auth/AuthProvider.js';
import { CashGateway } from '../../../shared/adapters/payments/CashGateway.js';
import { CognitoAuthProvider } from '../../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../../shared/domains/businesses/businessRepository.js';
import { PgFeaturingRepository } from '../../../shared/domains/featuring/featuringRepository.js';
import {
    AlreadyActiveError,
    FeaturingService,
} from '../../../shared/domains/featuring/featuringService.js';
import { toFeaturingSubscriptionView } from '../../../shared/domains/featuring/featuringView.js';
import { PgUserRepository } from '../../../shared/domains/users/userRepository.js';
import { UserService } from '../../../shared/domains/users/userService.js';
import {
    conflict,
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../../shared/http/responses.js';
import { createLogger } from '../../../shared/logging/logger.js';
import { UUID_RE } from '../../featuring/_authz.js';

import { authorizeAdmin } from '../_authz.js';

const REASON_MAX = 500;

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const businessRepo = new PgBusinessRepository(pool);
const featuringRepo = new PgFeaturingRepository(pool);
const featuringService = new FeaturingService({
    featuringRepo,
    businessRepo,
    paymentGateway: new CashGateway(),
    config: config.featuring,
});

interface ParsedBody {
    readonly durationDays: number;
    readonly reason: string;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.featuring.comp',
    });

    const businessId = event.pathParameters?.id?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('Business id must be a UUID.', { field: 'id' });
    }

    let body: ParsedBody;
    try {
        body = parseBody(event.body);
    } catch (err) {
        if (err instanceof ValidationFailure) {
            return validationError(err.message, err.details);
        }
        throw err;
    }

    try {
        const authz = await authorizeAdmin(event, authProvider, userService);
        if (!authz.ok) return authz.response;

        const business = await businessRepo.findById(businessId);
        if (!business) return notFound('Business not found.');

        try {
            const sub = await featuringService.comp({
                businessId,
                durationDays: body.durationDays,
                adminUserId: authz.user.id,
                reason: body.reason,
            });
            return ok(toFeaturingSubscriptionView(sub));
        } catch (err) {
            if (err instanceof AlreadyActiveError) {
                return conflict(err.message);
            }
            if (err instanceof RangeError) {
                return validationError(err.message, { field: 'durationDays' });
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
        logger.error('admin.featuring.comp.failed', {
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

function parseBody(rawBody: string | null): ParsedBody {
    if (rawBody === null || rawBody.trim() === '') {
        throw new ValidationFailure('Body is required.', {});
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
    const obj = parsed as Record<string, unknown>;
    const durationDaysRaw = obj.durationDays;
    if (
        typeof durationDaysRaw !== 'number' ||
        !Number.isInteger(durationDaysRaw) ||
        durationDaysRaw <= 0
    ) {
        throw new ValidationFailure(
            'durationDays must be a positive integer.',
            { field: 'durationDays', value: durationDaysRaw },
        );
    }
    const reasonRaw = obj.reason;
    if (typeof reasonRaw !== 'string' || reasonRaw.trim().length === 0) {
        throw new ValidationFailure(
            'reason must be a non-empty string.',
            { field: 'reason' },
        );
    }
    if (reasonRaw.length > REASON_MAX) {
        throw new ValidationFailure(
            `reason must be ≤ ${REASON_MAX} characters.`,
            { field: 'reason', max: REASON_MAX },
        );
    }
    return {
        durationDays: durationDaysRaw,
        reason: reasonRaw.trim(),
    };
}
