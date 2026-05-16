// EthioLink — generic Telegram notification gateway.
//
// Phase 9 Track 2 foundation. Implements the `NotificationGateway`
// port over the public Telegram Bot API
// (https://api.telegram.org/bot<TOKEN>/sendMessage). Provider tag
// is `'TELEGRAM_BOT'` — written to `notification_logs.provider`
// when the dispatcher routes through this gateway.
//
// Posture mirrors `GenericSmsGateway`:
//
//   * Provider-rejected sends (4xx) → return
//     `NotificationSendResult` with `status: 'FAILED'` and a
//     stable `errorCode`. The dispatcher persists the row; no
//     throw. Sub-codes distinguish the rejection class so the
//     application layer can react (e.g. the `'bot was blocked'`
//     case will clear `users.telegram_chat_id` in a future commit
//     so subsequent messages fall back to SMS automatically).
//   * Provider unreachable (5xx / timeout / network) → throw
//     `TelegramProviderUnavailableError` (subclass of
//     `NotificationGatewayError`). The dispatcher catches the
//     base class and writes `FAILED` with the error message.
//   * Missing `recipient.telegramChatId` → throw
//     `NotificationGatewayError('TELEGRAM_RECIPIENT_MISSING', …)`.
//     Programming error — the dispatcher's channel selector
//     should never route a Telegram send without a chat id.
//
// Transport seam:
//
//   `TelegramHttpTransport` mirrors `SmsHttpTransport`. Tests
//   inject `FakeTelegramHttpTransport` to script responses
//   without a network round-trip. Production passes
//   `defaultFetchTelegramHttpTransport()`.
//
// Wire shape:
//
//   POST https://api.telegram.org/bot<TOKEN>/sendMessage
//   Content-Type: application/json
//   {
//     "chat_id": "<recipient.telegramChatId>",
//     "text": "<rendered.body>"
//   }
//
//   Successful response:
//     { "ok": true, "result": { "message_id": 1234, ... } }
//
//   Errored response (any 4xx / 5xx):
//     { "ok": false, "error_code": <int>, "description": "<text>" }
//
// MarkdownV2 escaping is deliberately NOT applied in this commit.
// All Telegram messages ship as plain text — Telegram renders them
// verbatim with no formatting. Adding optional formatting via the
// `parse_mode` parameter is a later polish commit; it requires a
// careful escape helper that handles every reserved character
// (`_*[]()~` + ten more) consistently across templates. Plain text
// is the safer default and matches the SMS surface (which doesn't
// support formatting either).

import type {
    NotificationGateway,
    NotificationSendInput,
    NotificationSendResult,
} from './NotificationGateway.js';
import { NotificationGatewayError } from './NotificationGateway.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the generic Telegram gateway. Structurally
 * aligned with `AppConfig.telegramProvider` (see `loadConfig.ts`)
 * so the loaded config can be passed straight to
 * {@link createGenericTelegramGateway} without adaptation.
 */
export interface TelegramProviderConfig {
    /** Bot username without the leading `@`. Used by the link-code
     *  service for deep-link generation; the gateway itself does not
     *  consume it but carries it on the config for symmetry. */
    readonly botUsername: string;
    /** Bot token issued by BotFather. Resolved from the env var or
     *  from Secrets Manager via `loadSecretsThenConfig`. */
    readonly botToken: string;
    /** ARN of the Secrets Manager secret holding the bot token. Empty
     *  string when the operator supplied the plain token directly
     *  (dev path). Passthrough — the gateway does not consume it. */
    readonly botTokenSecretArn: string;
    /** Per-webhook secret used to authenticate the inbound webhook
     *  (set via Telegram's `setWebhook` API). Read by the future
     *  webhook Lambda; the gateway carries it for symmetry. */
    readonly webhookSecret: string;
    /** ARN of the Secrets Manager secret holding the webhook secret.
     *  Empty string when the operator supplied it directly. */
    readonly webhookSecretArn: string;
    /** Provider identifier written to `notification_logs.provider`.
     *  Defaults to `'TELEGRAM_BOT'`. */
    readonly providerName: string;
    /** Code-TTL on issued linking codes, in seconds. Defaults to
     *  600 (10 minutes) at the service layer when 0. Carried on
     *  the config so it's per-env tunable. */
    readonly linkCodeTtlSeconds: number;
    /** HTTP request timeout in milliseconds. Default 10000 (10 s). */
    readonly timeoutMs: number;
}

export interface TelegramHttpRequestOptions {
    readonly body: unknown;
    readonly headers: Record<string, string>;
    readonly timeoutMs: number;
}

export interface TelegramHttpResponse {
    readonly status: number;
    /** Parsed JSON, raw string, or `null` (empty body). */
    readonly body: unknown;
}

export interface TelegramHttpTransport {
    post(
        url: string,
        options: TelegramHttpRequestOptions,
    ): Promise<TelegramHttpResponse>;
}

/**
 * Subclass of {@link NotificationGatewayError} raised when the
 * Telegram Bot API is unreachable (5xx, timeout, network). Lets a
 * future retry job distinguish "Telegram rejected our chat id"
 * (4xx → `NotificationSendResult.status = 'FAILED'`, no throw)
 * from "Telegram itself is down" (this class, thrown).
 */
export class TelegramProviderUnavailableError extends NotificationGatewayError {
    constructor(message: string) {
        super('TELEGRAM_PROVIDER_UNAVAILABLE', message);
        this.name = 'TelegramProviderUnavailableError';
    }
}

// ---------------------------------------------------------------------------
// Default fetch-based transport
// ---------------------------------------------------------------------------

export function defaultFetchTelegramHttpTransport(): TelegramHttpTransport {
    return {
        async post(url, options) {
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(),
                options.timeoutMs,
            );
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: options.headers,
                    body: JSON.stringify(options.body),
                    signal: controller.signal,
                });
                const text = await response.text();
                let parsed: unknown = null;
                if (text) {
                    try {
                        parsed = JSON.parse(text);
                    } catch {
                        parsed = text;
                    }
                }
                return { status: response.status, body: parsed };
            } finally {
                clearTimeout(timer);
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER_NAME = 'TELEGRAM_BOT';
const DEFAULT_TIMEOUT_MS = 10000;
const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Factory used by the dispatcher (future commit) to construct the
 * gateway from `AppConfig.telegramProvider`. Throws when the
 * config is null — the caller is expected to check before calling.
 */
export function createGenericTelegramGateway(
    config: TelegramProviderConfig | null,
    transport: TelegramHttpTransport = defaultFetchTelegramHttpTransport(),
): GenericTelegramGateway {
    if (!config) {
        throw new NotificationGatewayError(
            'TELEGRAM_PROVIDER_NOT_CONFIGURED',
            'Telegram provider config is missing. Set TELEGRAM_BOT_USERNAME, ' +
                'TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN_SECRET_ARN), and ' +
                'TELEGRAM_WEBHOOK_SECRET (or TELEGRAM_WEBHOOK_SECRET_ARN).',
        );
    }
    return new GenericTelegramGateway(config, transport);
}

export class GenericTelegramGateway implements NotificationGateway {
    public readonly channel = 'TELEGRAM' as const;
    public readonly provider: string;

    private readonly config: TelegramProviderConfig;
    private readonly transport: TelegramHttpTransport;

    constructor(
        config: TelegramProviderConfig,
        transport: TelegramHttpTransport = defaultFetchTelegramHttpTransport(),
    ) {
        this.config = config;
        this.transport = transport;
        this.provider = config.providerName || DEFAULT_PROVIDER_NAME;
    }

    async send(input: NotificationSendInput): Promise<NotificationSendResult> {
        const chatId = input.recipient.telegramChatId?.trim();
        if (!chatId) {
            throw new NotificationGatewayError(
                'TELEGRAM_RECIPIENT_MISSING',
                'Telegram send requires `recipient.telegramChatId`; got empty value.',
            );
        }

        const url = `${TELEGRAM_API_BASE}/bot${this.config.botToken}/sendMessage`;
        const requestBody: Record<string, unknown> = {
            chat_id: chatId,
            text: input.rendered.body,
        };

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };

        const sentAt = new Date().toISOString();

        let response: TelegramHttpResponse;
        try {
            response = await this.transport.post(url, {
                body: requestBody,
                headers,
                timeoutMs: this.config.timeoutMs || DEFAULT_TIMEOUT_MS,
            });
        } catch (err) {
            throw new TelegramProviderUnavailableError(
                `Telegram provider unreachable: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }

        if (response.status >= 500) {
            throw new TelegramProviderUnavailableError(
                `Telegram returned HTTP ${response.status}: ${truncate(
                    stringifyBody(response.body),
                    200,
                )}`,
            );
        }

        if (response.status >= 400) {
            const code = classifyRejection(response.status, response.body);
            return Object.freeze<NotificationSendResult>({
                status: 'FAILED',
                provider: this.provider,
                providerRef: null,
                rawResponse: response.body ?? null,
                errorCode: code,
                errorMessage: `Telegram rejected with HTTP ${response.status}: ${truncate(
                    descriptionOf(response.body),
                    200,
                )}`,
                sentAt,
            });
        }

        // 2xx — Telegram returns `{ ok: true, result: { message_id, ... } }`.
        return Object.freeze<NotificationSendResult>({
            status: 'SENT',
            provider: this.provider,
            providerRef: extractProviderRef(response.body),
            rawResponse: response.body ?? null,
            errorCode: null,
            errorMessage: null,
            sentAt,
        });
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Map a 4xx response to a stable error code. The codes are
 * application-stable strings the future "clear chat id when
 * forbidden" path can switch on. Reserved codes:
 *
 *   * `TELEGRAM_FORBIDDEN`     — Telegram 403. Common cause: user
 *     blocked the bot. Future commit clears `users.telegram_chat_id`
 *     in response and falls back to SMS on the next send.
 *   * `TELEGRAM_CHAT_NOT_FOUND` — Telegram 400 with description
 *     containing "chat not found". Same handling as forbidden.
 *   * `TELEGRAM_RATE_LIMITED`  — Telegram 429. Retry-after lives
 *     in the response body. The dispatcher does not retry today;
 *     a future job can.
 *   * `TELEGRAM_REJECTED`      — Generic 4xx (bad request,
 *     malformed body, etc.). The default for anything not matching
 *     a more specific bucket above.
 */
function classifyRejection(status: number, body: unknown): string {
    if (status === 403) return 'TELEGRAM_FORBIDDEN';
    if (status === 429) return 'TELEGRAM_RATE_LIMITED';
    if (status === 400) {
        const desc = descriptionOf(body).toLowerCase();
        if (desc.includes('chat not found')) return 'TELEGRAM_CHAT_NOT_FOUND';
        if (desc.includes('bot was blocked')) return 'TELEGRAM_FORBIDDEN';
    }
    return 'TELEGRAM_REJECTED';
}

/**
 * Extract the vendor-issued message id from a 2xx Bot API
 * response. Telegram's success payload is
 * `{ ok: true, result: { message_id: <int>, ... } }` — we
 * stringify the integer because `notification_logs.provider_ref`
 * is `text`. Returns `null` if the shape is unexpected (defensive
 * — we still write `SENT` because the HTTP 2xx is the source of
 * truth).
 */
function extractProviderRef(body: unknown): string | null {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        const obj = body as Record<string, unknown>;
        const result = obj.result;
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            const inner = result as Record<string, unknown>;
            const id = inner.message_id;
            if (typeof id === 'number' && Number.isFinite(id)) {
                return String(id);
            }
            if (typeof id === 'string' && id.length > 0) {
                return id;
            }
        }
    }
    return null;
}

function descriptionOf(body: unknown): string {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        const obj = body as Record<string, unknown>;
        if (typeof obj.description === 'string') return obj.description;
    }
    if (typeof body === 'string') return body;
    return '';
}

function stringifyBody(body: unknown): string {
    if (body === null || body === undefined) return '';
    if (typeof body === 'string') return body;
    try {
        return JSON.stringify(body);
    } catch {
        return String(body);
    }
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
