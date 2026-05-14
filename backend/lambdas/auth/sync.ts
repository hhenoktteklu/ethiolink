// EthioLink — Lambda handler for `POST /v1/auth/sync`.
//
// Thin entrypoint: extract the authenticated principal from the event, hand
// it to `UserService.syncFromPrincipal`, and serialize the result. All
// business logic lives in `shared/domains/users/userService.ts`.
//
// Idempotency: a second call for the same Cognito sub returns the same
// `users` row state — see the service's syncFromPrincipal for details.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadConfig } from '../../shared/config/loadConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { toUserView } from '../../shared/domains/users/userView.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import { internalError, ok, unauthenticated } from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

// Cold-start initialization. Lambdas reuse this across warm invocations.
const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const userRepository = new PgUserRepository(getPool(config));

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'auth.sync',
    });

    try {
        const principal = await extractPrincipal(event, authProvider);
        const userService = new UserService(userRepository, logger);
        const user = await userService.syncFromPrincipal(principal);
        return ok(toUserView(user));
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
        logger.error('auth.sync.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
