// EthioLink — Lambda handler for `DELETE /v1/me/link-telegram`.
//
// Phase 9 Track 2 commit "add Telegram link endpoints". Clears
// the caller's `users.telegram_chat_id` (and any in-flight
// linking codes via `TelegramLinkService.unlink`). Idempotent —
// calling it twice in a row is fine; the second call returns
// `{ linked: false }` exactly as the first.
//
// 200 response shape:
//   { "linked": false }

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
import { PgTelegramLinkCodeRepository } from '../../shared/domains/users/telegramLinkCodeRepository.js';
import {
    TelegramLinkService,
    TelegramLinkUserNotFoundError,
    type TelegramLinkServiceConfig,
} from '../../shared/domains/users/telegramLinkService.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    errorResponse,
    internalError,
    notFound,
    ok,
    unauthenticated,
} from '../../shared/http/responses.js';
import { createLogger, type Logger } from '../../shared/logging/logger.js';

export interface LinkTelegramUnlinkDeps {
    readonly authProvider: AuthProvider;
    readonly userService: UserService;
    /** Linker service. `null` when Telegram isn't configured —
     *  same 503 handling as `linkTelegramStart`. */
    readonly linkService: TelegramLinkService | null;
    readonly logger: Logger;
}

export async function handleUnlink(
    deps: LinkTelegramUnlinkDeps,
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
    const logger = deps.logger.child({ handler: 'me.linkTelegramUnlink' });

    if (!deps.linkService) {
        return errorResponse(
            503,
            'INTERNAL_ERROR',
            'Telegram integration is not configured for this environment.',
        );
    }

    try {
        const principal = await extractPrincipal(event, deps.authProvider);
        const me = await deps.userService.getByCognitoSub(principal.sub);
        if (!me) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }
        await deps.linkService.unlink(me.id);
        return ok({ linked: false });
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
        if (err instanceof TelegramLinkUserNotFoundError) {
            return notFound(err.message);
        }
        logger.error('me.linkTelegramUnlink.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
}

// ---------------------------------------------------------------------------
// Production wiring (lazy — see `linkTelegramStart.ts` header).
// ---------------------------------------------------------------------------

let cachedDeps: LinkTelegramUnlinkDeps | null = null;

async function getProductionDeps(): Promise<LinkTelegramUnlinkDeps> {
    if (cachedDeps) return cachedDeps;
    const config = await loadSecretsThenConfig();
    const baseLogger = createLogger({ level: config.logLevel });
    const pool = getPool(config);
    const userRepository = new PgUserRepository(pool);
    cachedDeps = {
        authProvider: new CognitoAuthProvider(config.cognito),
        userService: new UserService(userRepository, baseLogger),
        linkService: config.telegramProvider
            ? new TelegramLinkService({
                  userRepo: userRepository,
                  linkCodeRepo: new PgTelegramLinkCodeRepository(pool),
                  config: {
                      botUsername: config.telegramProvider.botUsername,
                      linkCodeTtlSeconds:
                          config.telegramProvider.linkCodeTtlSeconds,
                  } satisfies TelegramLinkServiceConfig,
                  logger: baseLogger,
              })
            : null,
        logger: baseLogger,
    };
    return cachedDeps;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const deps = await getProductionDeps();
    return handleUnlink(
        {
            ...deps,
            logger: deps.logger.child({
                requestId: event.requestContext.requestId,
            }),
        },
        event,
    );
};
