// EthioLink — Lambda handler for `POST /v1/businesses`.
//
// Authenticated, BUSINESS_OWNER-only. Creates a fresh DRAFT business
// owned by the calling user.
//
// Auth path:
//   1. Extract Cognito principal; 401 on auth failures.
//   2. Refuse non-BUSINESS_OWNER callers with 403.
//   3. Resolve principal.sub to a `users` row; 404 with hint to call
//      POST /v1/auth/sync first if the user is unsynced.
//
// Body validation: hand-written, shared with PATCH via _validators.ts.
//
// Service errors → HTTP:
//   * BusinessAlreadyExistsError → 409 CONFLICT (one business per owner)

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
    BusinessAlreadyExistsError,
    BusinessService,
    type CreateBusinessInput,
} from '../../shared/domains/businesses/businessService.js';
import { toBusinessOwnerView } from '../../shared/domains/businesses/businessView.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    conflict,
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
        handler: 'businesses.create',
    });

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'BUSINESS_OWNER') {
            return forbidden('Only BUSINESS_OWNER role can create a business profile.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let input: CreateBusinessInput;
        try {
            input = parseCreateBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            const business = await businessService.create(user.id, input);
            return ok(toBusinessOwnerView(business));
        } catch (err) {
            if (err instanceof BusinessAlreadyExistsError) {
                return conflict(err.message);
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
        logger.error('businesses.create.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseCreateBody(rawBody: string | null): CreateBusinessInput {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });
    return {
        categoryId: parseRequiredUuid(obj.categoryId, 'categoryId'),
        name: parseStringOrNull(obj.name, 'name', FieldLimits.NAME_MAX),
        description: parseDescriptionOrNull(obj.description),
        city: parseStringOrNull(obj.city, 'city', FieldLimits.CITY_MAX),
        addressLine: parseStringOrNull(
            obj.addressLine,
            'addressLine',
            FieldLimits.ADDRESS_MAX,
        ),
        latitude: parseLatitude(obj.latitude),
        longitude: parseLongitude(obj.longitude),
        phone: parseStringOrNull(obj.phone, 'phone', FieldLimits.CONTACT_MAX),
        telegramHandle: parseStringOrNull(
            obj.telegramHandle,
            'telegramHandle',
            FieldLimits.CONTACT_MAX,
        ),
        whatsappPhone: parseStringOrNull(
            obj.whatsappPhone,
            'whatsappPhone',
            FieldLimits.CONTACT_MAX,
        ),
    };
}
