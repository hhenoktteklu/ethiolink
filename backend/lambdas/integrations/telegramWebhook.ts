// EthioLink — Lambda handler for `POST /v1/integrations/telegram/webhook`.
//
// Phase 9 Track 2 commit "add Telegram link endpoints". The
// public route Telegram POSTs updates to (configured via the Bot
// API `setWebhook` call). Authentication is via the
// `X-Telegram-Bot-Api-Secret-Token` header — Telegram echoes back
// whatever secret was passed to `setWebhook`. We compare against
// `config.telegramProvider.webhookSecret`; mismatch returns 401.
//
// Linking flow:
//
//   1. The user opens the deep link from the mobile app.
//   2. Telegram launches the bot conversation and sends
//      `/start <code>` as the first message.
//   3. Telegram POSTs an Update payload to this Lambda:
//        { update_id, message: { chat: { id }, text: "/start <code>" } }
//   4. The Lambda validates the secret header, parses the
//      `/start` command, calls
//      `TelegramLinkService.redeemCode(code, chatId)`, and best-
//      effort replies via the Bot API with a confirmation
//      message.
//
// Other updates (group joins, non-/start messages, unknown
// commands) are silently acknowledged with 200 so Telegram does
// not retry them. The handler is permissive on every non-routing
// branch — Telegram's "we will retry on 5xx" policy means a
// throw in this handler causes the bot to deliver the same
// update many times.
//
// Bot reply is best-effort: the user can still see their
// `users.telegram_chat_id` populated via the mobile status poll
// even if the reply fails.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    defaultFetchTelegramHttpTransport,
    type TelegramHttpTransport,
    type TelegramProviderConfig,
} from '../../shared/adapters/notifications/GenericTelegramGateway.js';
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgTelegramLinkCodeRepository } from '../../shared/domains/users/telegramLinkCodeRepository.js';
import {
    TelegramLinkCodeExpiredError,
    TelegramLinkCodeNotFoundError,
    TelegramLinkError,
    TelegramLinkService,
    TelegramLinkUserNotFoundError,
    type TelegramLinkServiceConfig,
} from '../../shared/domains/users/telegramLinkService.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import {
    errorResponse,
    internalError,
    ok,
} from '../../shared/http/responses.js';
import { createLogger, type Logger } from '../../shared/logging/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Best-effort bot-reply hook. Takes a chat id + plain-text body
 * and POSTs `/sendMessage` to the Bot API. Production wires this
 * to the real fetch-based transport; tests pass a recording fake
 * so the assertions can verify the bot saw the right message.
 *
 * Errors are swallowed in the handler — the reply is a courtesy,
 * not part of the redemption contract.
 */
export type ReplyToBot = (chatId: string, text: string) => Promise<void>;

export interface TelegramWebhookDeps {
    /** Plain-text webhook secret to compare against the
     *  `X-Telegram-Bot-Api-Secret-Token` header. */
    readonly webhookSecret: string;
    /** Service the handler delegates redemption to. `null` when
     *  Telegram isn't configured — the handler returns 503 in
     *  that case so the operator notices via Telegram's webhook
     *  dashboard. */
    readonly linkService: TelegramLinkService | null;
    /** Bot reply hook (best-effort). */
    readonly replyToBot: ReplyToBot;
    readonly logger: Logger;
}

const SUCCESS_REPLY =
    '✅ Linked! You will receive booking notifications here.';
const FAILURE_REPLY =
    '❌ Linking code invalid or expired. Restart from the EthioLink app.';

export async function handleWebhook(
    deps: TelegramWebhookDeps,
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
    const logger = deps.logger.child({
        handler: 'integrations.telegramWebhook',
    });

    // 1. Secret-header gate. Telegram sends the configured
    //    `setWebhook` secret on every update. Mismatch → 401.
    const headerSecret = readWebhookSecretHeader(event);
    if (
        !deps.webhookSecret ||
        !headerSecret ||
        !constantTimeEqual(headerSecret, deps.webhookSecret)
    ) {
        logger.warn('telegram.webhook.unauthorized');
        return errorResponse(
            401,
            'UNAUTHENTICATED',
            'Invalid Telegram webhook secret.',
        );
    }

    // 2. Service gating. If Telegram isn't configured in this env,
    //    the webhook should never have been wired up — return 503
    //    so the operator notices the misconfiguration. We still
    //    acknowledge the secret-header check so a noisy webhook
    //    doesn't leak the dev/prod gating state.
    if (!deps.linkService) {
        logger.warn('telegram.webhook.service_unavailable');
        return errorResponse(
            503,
            'INTERNAL_ERROR',
            'Telegram integration is not configured for this environment.',
        );
    }

    // 3. Parse the update. Anything that isn't well-formed JSON or
    //    isn't a `message` update gets acknowledged — Telegram
    //    retries 5xx forever, so we 200 on every non-error path.
    let parsed: unknown;
    try {
        parsed = event.body ? JSON.parse(event.body) : {};
    } catch {
        logger.warn('telegram.webhook.malformed_body');
        return ok({ ok: true });
    }

    const update = parsed as Record<string, unknown> | null;
    const message =
        update && typeof update.message === 'object' && update.message !== null
            ? (update.message as Record<string, unknown>)
            : null;
    if (!message) {
        return ok({ ok: true });
    }

    const text = typeof message.text === 'string' ? message.text : '';
    const chat =
        typeof message.chat === 'object' && message.chat !== null
            ? (message.chat as Record<string, unknown>)
            : null;
    const chatId = extractChatId(chat);

    if (!chatId || !text.startsWith('/start ')) {
        // Not a linking command — acknowledge silently. Bot
        // small-talk + unrelated commands land here.
        return ok({ ok: true });
    }

    const code = text.slice('/start '.length).trim();
    if (code === '') {
        // `/start` with no payload — Telegram delivers this when
        // the user types `/start` directly. Reply with usage copy.
        await deps.replyToBot(chatId, FAILURE_REPLY).catch(() => undefined);
        return ok({ ok: true });
    }

    try {
        await deps.linkService.redeemCode(code, chatId);
        await deps.replyToBot(chatId, SUCCESS_REPLY).catch(() => undefined);
        logger.info('telegram.webhook.linked');
        return ok({ ok: true });
    } catch (err) {
        if (
            err instanceof TelegramLinkCodeNotFoundError ||
            err instanceof TelegramLinkCodeExpiredError ||
            err instanceof TelegramLinkUserNotFoundError ||
            err instanceof TelegramLinkError
        ) {
            logger.info('telegram.webhook.link_failed', {
                code: err.code,
            });
            await deps
                .replyToBot(chatId, FAILURE_REPLY)
                .catch(() => undefined);
            return ok({ ok: true });
        }
        logger.error('telegram.webhook.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readWebhookSecretHeader(event: APIGatewayProxyEvent): string | null {
    const headers = event.headers ?? {};
    const candidates = [
        headers['X-Telegram-Bot-Api-Secret-Token'],
        headers['x-telegram-bot-api-secret-token'],
        headers['X-TELEGRAM-BOT-API-SECRET-TOKEN'],
    ];
    for (const v of candidates) {
        if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
}

/**
 * Length-stable equality check. Telegram's secret tokens are
 * short (recommended 16+ chars) so a timing-attack vector is
 * mild, but the cost of doing this right is one line.
 */
function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

function extractChatId(chat: Record<string, unknown> | null): string | null {
    if (!chat) return null;
    const id = chat.id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    if (typeof id === 'string' && id.length > 0) return id;
    return null;
}

/**
 * Build a `ReplyToBot` from a `TelegramHttpTransport` + the
 * provider config. Exported so tests can synthesise the
 * production wiring against a recording transport.
 */
export function makeReplyToBot(
    config: TelegramProviderConfig,
    transport: TelegramHttpTransport,
): ReplyToBot {
    return async (chatId, text) => {
        const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
        await transport.post(url, {
            body: { chat_id: chatId, text },
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            timeoutMs: config.timeoutMs || 10000,
        });
    };
}

// ---------------------------------------------------------------------------
// Production wiring (lazy).
// ---------------------------------------------------------------------------

let cachedDeps: TelegramWebhookDeps | null = null;

async function getProductionDeps(): Promise<TelegramWebhookDeps> {
    if (cachedDeps) return cachedDeps;
    const config = await loadSecretsThenConfig();
    const baseLogger = createLogger({ level: config.logLevel });
    const pool = getPool(config);
    const userRepository = new PgUserRepository(pool);

    const linkService: TelegramLinkService | null = config.telegramProvider
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
        : null;

    const replyToBot: ReplyToBot = config.telegramProvider
        ? makeReplyToBot(
              config.telegramProvider,
              defaultFetchTelegramHttpTransport(),
          )
        : async () => undefined;

    cachedDeps = {
        webhookSecret: config.telegramProvider?.webhookSecret ?? '',
        linkService,
        replyToBot,
        logger: baseLogger,
    };
    return cachedDeps;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const deps = await getProductionDeps();
    return handleWebhook(
        {
            ...deps,
            logger: deps.logger.child({
                requestId: event.requestContext.requestId,
            }),
        },
        event,
    );
};
