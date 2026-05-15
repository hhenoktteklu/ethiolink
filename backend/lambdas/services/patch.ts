// EthioLink — Lambda handler for `PATCH /v1/businesses/{businessId}/services/{id}`.
//
// Authenticated, BUSINESS_OWNER-only. Edits a service's mutable fields.
// Ownership is enforced inside `serviceService.update` — the service
// resolves the parent business via the row's `business_id` and compares
// against the caller. The path's `businessId` parameter is informational;
// the lookup is the source of truth.
//
// Patch semantics:
//   * Each field optional. Absent = no change.
//   * `name` and `durationMinutes` are NOT NULL in the DB and cannot be
//     cleared (`null` rejected by the validators).
//   * `description` and `priceEtb` accept `null` to clear.
//   * Unknown fields tolerated for forward compatibility.
//
// Service errors → HTTP:
//   * ServiceNotFoundError  → 404
//   * ServiceNotOwnedError  → 403

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgServiceRepository } from '../../shared/domains/services/serviceRepository.js';
import {
    ServiceNotFoundError,
    ServiceNotOwnedError,
    ServiceService,
    type UpdateServiceInput,
} from '../../shared/domains/services/serviceService.js';
import { toServiceView } from '../../shared/domains/services/serviceView.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    forbidden,
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import {
    FieldLimits,
    UUID_RE,
    ValidationFailure,
    parseJsonObjectBody,
    parseLocalizedTextOrNull,
    parseLocalizedTextRequired,
    parsePositiveIntegerRequired,
    parsePriceOrNull,
} from './_validators.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const serviceService = new ServiceService(
    new PgServiceRepository(pool),
    new PgBusinessRepository(pool),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'services.patch',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('businessId must be a UUID.', { field: 'businessId' });
    }
    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('id must be a UUID.', { field: 'id' });
    }

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'BUSINESS_OWNER') {
            return forbidden('Only BUSINESS_OWNER role can edit services.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let patch: UpdateServiceInput;
        try {
            patch = parsePatchBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            const service = await serviceService.update(
                id,
                { userId: user.id, role: principal.role },
                patch,
            );
            return ok(toServiceView(service));
        } catch (err) {
            if (err instanceof ServiceNotFoundError) {
                return notFound('Service not found.');
            }
            if (err instanceof ServiceNotOwnedError) {
                return forbidden(err.message);
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
        logger.error('services.patch.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parsePatchBody(rawBody: string | null): UpdateServiceInput {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: true });
    const patch: { -readonly [K in keyof UpdateServiceInput]: UpdateServiceInput[K] } = {};

    if ('name' in obj) {
        patch.name = parseLocalizedTextRequired(obj.name, 'name', FieldLimits.NAME_MAX);
    }
    if ('description' in obj) {
        patch.description = parseLocalizedTextOrNull(
            obj.description,
            'description',
            FieldLimits.DESCRIPTION_MAX,
        );
    }
    if ('durationMinutes' in obj) {
        patch.durationMinutes = parsePositiveIntegerRequired(
            obj.durationMinutes,
            'durationMinutes',
            FieldLimits.DURATION_MAX_MINUTES,
        );
    }
    if ('priceEtb' in obj) {
        patch.priceEtb = parsePriceOrNull(
            obj.priceEtb,
            'priceEtb',
            FieldLimits.PRICE_MAX_ETB,
        );
    }

    return patch;
}
