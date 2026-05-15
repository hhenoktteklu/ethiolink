// EthioLink — Lambda handler for `POST /v1/businesses/{businessId}/services`.
//
// Authenticated, BUSINESS_OWNER-only (Phase 3 scope; admin write paths
// land in Phase 5). Creates a new active service owned by the business
// at `businessId`. The caller must own that business — ownership is
// enforced inside `serviceService.create`.
//
// Service errors → HTTP:
//   * ServiceBusinessNotFoundError → 404
//   * ServiceNotOwnedError         → 403

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
    ServiceBusinessNotFoundError,
    ServiceNotOwnedError,
    ServiceService,
    type CreateServiceInput,
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
        handler: 'services.create',
    });

    const businessId = event.pathParameters?.businessId?.trim();
    if (!businessId || !UUID_RE.test(businessId)) {
        return validationError('businessId must be a UUID.', { field: 'businessId' });
    }

    try {
        const principal = await extractPrincipal(event, authProvider);

        if (principal.role !== 'BUSINESS_OWNER') {
            return forbidden('Only BUSINESS_OWNER role can create services.');
        }

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let input: CreateServiceInput;
        try {
            input = parseCreateBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            const service = await serviceService.create(
                { userId: user.id, role: principal.role },
                businessId,
                input,
            );
            return ok(toServiceView(service));
        } catch (err) {
            if (err instanceof ServiceBusinessNotFoundError) {
                return notFound(err.message);
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
        logger.error('services.create.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseCreateBody(rawBody: string | null): CreateServiceInput {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });
    return {
        name: parseLocalizedTextRequired(obj.name, 'name', FieldLimits.NAME_MAX),
        description: parseLocalizedTextOrNull(
            obj.description,
            'description',
            FieldLimits.DESCRIPTION_MAX,
        ),
        durationMinutes: parsePositiveIntegerRequired(
            obj.durationMinutes,
            'durationMinutes',
            FieldLimits.DURATION_MAX_MINUTES,
        ),
        priceEtb: parsePriceOrNull(
            obj.priceEtb,
            'priceEtb',
            FieldLimits.PRICE_MAX_ETB,
        ),
    };
}
