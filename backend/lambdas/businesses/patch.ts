// EthioLink — Lambda handler for `PATCH /v1/businesses/{id}`.
//
// Authenticated, BUSINESS_OWNER-only (Phase 2 scope; API_SPEC also lists
// ADMIN as allowed — that wiring lands in Phase 5 along with the rest
// of the admin write paths).
//
// Patch semantics (matches PATCH /v1/me):
//   * Each field optional. `undefined` (absent from body) = no change.
//   * Explicit `null` = clear the column.
//   * Unknown fields are tolerated for forward compatibility.
//   * Empty `{}` is a valid no-op.
//
// Service errors → HTTP:
//   * BusinessNotFoundError → 404
//   * BusinessNotOwnedError → 403

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
import {
    BusinessNotFoundError,
    BusinessNotOwnedError,
    BusinessService,
    type UpdateBusinessInput,
} from '../../shared/domains/businesses/businessService.js';
import { toBusinessOwnerView } from '../../shared/domains/businesses/businessView.js';
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
    parseDescriptionOrNull,
    parseJsonObjectBody,
    parseLatitude,
    parseLongitude,
    parseRequiredUuid,
    parseStringOrNull,
    UUID_RE,
    ValidationFailure,
} from './_validators.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const businessService = new BusinessService(new PgBusinessRepository(pool));

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'businesses.patch',
    });

    const id = event.pathParameters?.id?.trim();
    if (!id || !UUID_RE.test(id)) {
        return validationError('Business id must be a UUID.', { field: 'id' });
    }

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'BUSINESS_OWNER') {
            return forbidden('Only BUSINESS_OWNER role can edit a business profile.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let patch: UpdateBusinessInput;
        try {
            patch = parsePatchBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            const business = await businessService.update(
                id,
                { userId: user.id, role: principal.role },
                patch,
            );
            return ok(toBusinessOwnerView(business));
        } catch (err) {
            if (err instanceof BusinessNotFoundError) {
                return notFound('Business not found.');
            }
            if (err instanceof BusinessNotOwnedError) {
                return forbidden('Caller does not own this business.');
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
        logger.error('businesses.patch.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

/**
 * Parse a partial patch body. Each field is gated on `'name' in obj` so
 * "field absent" maps to `undefined` (no change) and "field is `null`"
 * maps to `null` (clear). Unknown fields are silently ignored.
 */
function parsePatchBody(rawBody: string | null): UpdateBusinessInput {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: true });
    const patch: { -readonly [K in keyof UpdateBusinessInput]: UpdateBusinessInput[K] } = {};

    if ('categoryId' in obj) {
        patch.categoryId = parseRequiredUuid(obj.categoryId, 'categoryId');
    }
    if ('name' in obj) {
        patch.name = parseStringOrNull(obj.name, 'name', FieldLimits.NAME_MAX);
    }
    if ('description' in obj) {
        patch.description = parseDescriptionOrNull(obj.description);
    }
    if ('city' in obj) {
        patch.city = parseStringOrNull(obj.city, 'city', FieldLimits.CITY_MAX);
    }
    if ('addressLine' in obj) {
        patch.addressLine = parseStringOrNull(
            obj.addressLine,
            'addressLine',
            FieldLimits.ADDRESS_MAX,
        );
    }
    if ('latitude' in obj) {
        patch.latitude = parseLatitude(obj.latitude);
    }
    if ('longitude' in obj) {
        patch.longitude = parseLongitude(obj.longitude);
    }
    if ('phone' in obj) {
        patch.phone = parseStringOrNull(obj.phone, 'phone', FieldLimits.CONTACT_MAX);
    }
    if ('telegramHandle' in obj) {
        patch.telegramHandle = parseStringOrNull(
            obj.telegramHandle,
            'telegramHandle',
            FieldLimits.CONTACT_MAX,
        );
    }
    if ('whatsappPhone' in obj) {
        patch.whatsappPhone = parseStringOrNull(
            obj.whatsappPhone,
            'whatsappPhone',
            FieldLimits.CONTACT_MAX,
        );
    }

    return patch;
}
