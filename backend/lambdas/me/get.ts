// EthioLink — Lambda handler for `GET /v1/me`.
//
// Returns the calling user's row. The user must already exist in the
// `users` table — meaning the client must have hit `/v1/auth/sync` at
// least once. Returns 404 if not.

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
import {
    internalError,
    notFound,
    ok,
    unauthenticated,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const userRepository = new PgUserRepository(getPool(config));

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'me.get',
    });

    try {
        const principal = await extractPrincipal(event, authProvider);
        const userService = new UserService(userRepository, logger);
        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound('User profile not found. Call POST /v1/auth/sync first.');
        }
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
        logger.error('me.get.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};
