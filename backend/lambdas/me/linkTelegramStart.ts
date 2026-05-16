// EthioLink — Lambda handler for `POST /v1/me/link-telegram/start`.
//
// Phase 9 Track 2 commit "add Telegram link endpoints". Issues a
// fresh single-use linking code for the authenticated caller +
// returns the Telegram deep link the mobile app should open.
//
// 200 response shape:
//   { "deepLink": "https://t.me/<bot>?start=<code>",
//     "expiresAt": "<ISO-8601 UTC>" }
//
// Returns 503 when the operator hasn't wired Telegram yet
// (`config.telegramProvider === null`). The handler stays
// importable in every env stack — it only fails the request,
// not the cold start.
//
// Testable shape: the heavy lifting lives in `handleStart(deps,
// event)` so the unit tests can construct fakes and exercise the
// branches without booting `loadSecretsThenConfig`.

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
import {
    UserService,
} from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    errorResponse,
    internalError,
    notFound,
    ok,
    unauthenticated,
} from '../../shared/http/responses.js';
import { createLogger, type Logger } from '../../shared/logging/logger.js';

export interface LinkTelegramStartDeps {
    readonly authProvider: AuthProvider;
    readonly userService: UserService;
    /** Linker service. `null` when Telegram isn't configured in
     *  this env — the handler returns 503 instead of crashing on
     *  startup so deploying the code into an env that hasn't opted
     *  in is safe. */
    readonly linkService: TelegramLinkService | null;
    readonly logger: Logger;
}

export async function handleStart(
    deps: LinkTelegramStartDeps,
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
    const logger = deps.logger.child({ handler: 'me.linkTelegramStart' });

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
        const started = await deps.linkService.startLink(me.id);
        return ok({
            deepLink: started.deepLink,
            expiresAt: started.expiresAt,
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
        if (err instanceof TelegramLinkUserNotFoundError) {
            return notFound(err.message);
        }
        logger.error('me.linkTelegramStart.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
}

// ---------------------------------------------------------------------------
// Production wiring — lazy so importing this module from tests does
// not trigger `loadSecretsThenConfig` (and therefore does not need
// a populated DB env).
// ---------------------------------------------------------------------------

let cachedDeps: LinkTelegramStartDeps | null = null;

async function getProductionDeps(): Promise<LinkTelegramStartDeps> {
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
    return handleStart(
        {
            ...deps,
            logger: deps.logger.child({
                requestId: event.requestContext.requestId,
            }),
        },
        event,
    );
};
