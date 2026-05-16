// EthioLink — Lambda handler for `GET /v1/me/telegram-status`.
//
// Phase 9 Track 2 commit "add Telegram link endpoints". Surfaces
// whether the caller has linked a Telegram chat id. The mobile
// app polls this after opening the deep link to confirm the
// bot-side redemption landed.
//
// 200 response shape:
//   { "linked": true,  "linkedAt": "<ISO-8601 UTC, updatedAt>" }
// or
//   { "linked": false, "linkedAt": null }
//
// `linkedAt` is the user's `updated_at` when the chat id is
// present (best-available timestamp without adding a dedicated
// `telegram_linked_at` column — the redemption is the most
// recent write on the row in practice).

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
    type AuthProvider,
} from '../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    internalError,
    notFound,
    ok,
    unauthenticated,
} from '../../shared/http/responses.js';
import { createLogger, type Logger } from '../../shared/logging/logger.js';

export interface LinkTelegramStatusDeps {
    readonly authProvider: AuthProvider;
    readonly userService: UserService;
    readonly logger: Logger;
}

export async function handleStatus(
    deps: LinkTelegramStatusDeps,
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
    const logger = deps.logger.child({ handler: 'me.linkTelegramStatus' });
    try {
        const principal = await extractPrincipal(event, deps.authProvider);
        const me = await deps.userService.getByCognitoSub(principal.sub);
        if (!me) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }
        const linked = me.telegramChatId !== null;
        return ok({
            linked,
            linkedAt: linked ? me.updatedAt.toISOString() : null,
        });
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
        logger.error('me.linkTelegramStatus.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
}

// ---------------------------------------------------------------------------
// Production wiring (lazy — see `linkTelegramStart.ts` header).
// ---------------------------------------------------------------------------

let cachedDeps: LinkTelegramStatusDeps | null = null;

async function getProductionDeps(): Promise<LinkTelegramStatusDeps> {
    if (cachedDeps) return cachedDeps;
    const config = await loadSecretsThenConfig();
    const baseLogger = createLogger({ level: config.logLevel });
    const userRepository = new PgUserRepository(getPool(config));
    cachedDeps = {
        authProvider: new CognitoAuthProvider(config.cognito),
        userService: new UserService(userRepository, baseLogger),
        logger: baseLogger,
    };
    return cachedDeps;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const deps = await getProductionDeps();
    return handleStatus(
        {
            ...deps,
            logger: deps.logger.child({
                requestId: event.requestContext.requestId,
            }),
        },
        event,
    );
};
