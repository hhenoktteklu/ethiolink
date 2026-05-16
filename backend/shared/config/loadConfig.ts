// EthioLink — environment configuration loader.
//
// `loadConfig` reads process.env (or an injected map for tests), validates
// that every required variable is present, parses typed values, and returns
// a single immutable `AppConfig` object.
//
// Design notes:
//   * Pure function, no caching, no top-level side effects. Lambdas decide
//     when to call this (typically once per cold start).
//   * Required variables: if any are missing or blank, the function throws
//     `MissingConfigError` with the full list — never one-at-a-time. This
//     keeps deployment misconfiguration loud and easy to fix.
//   * Optional variables: documented in `backend/.env.example` with defaults.
//   * No external dependencies (no zod). Hand-written validation is small
//     enough here and avoids pulling in a dep we do not otherwise need.

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Resolved value of `NOTIFICATIONS_PROVIDER`. Controls which
 * notification gateway the factory wires alongside the always-on
 * `MockNotificationGateway`:
 *
 *   * `'mock'`        — default. Only `MockNotificationGateway` is
 *                       wired. Real providers stay dormant even
 *                       when their config is present.
 *   * `'sms'`         — when `config.smsProvider` is non-null, the
 *                       `GenericSmsGateway` is wired under the
 *                       `SMS` channel. Other channels still fall
 *                       through to mock.
 *   * `'telegram'`    — when `config.telegramProvider` is
 *                       non-null, the `GenericTelegramGateway` is
 *                       wired under the `TELEGRAM` channel.
 *                       SMS remains dormant unless co-set via
 *                       `'production'`. Useful for operators who
 *                       want to roll out Telegram before SMS.
 *   * `'production'`  — wires both SMS and Telegram when their
 *                       per-vendor config blocks are present. The
 *                       "everything that's configured goes live"
 *                       umbrella flag.
 *
 * Unknown values throw `InvalidConfigError` at config-load time
 * (same posture as `NODE_ENV` / `LOG_LEVEL`) — a typo in the env
 * stack fails the cold start loudly rather than silently routing
 * traffic through the mock.
 */
export type NotificationsProvider =
    | 'mock'
    | 'sms'
    | 'telegram'
    | 'production';

export interface PgConfig {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly ssl: boolean;
}

export interface CognitoConfig {
    readonly userPoolId: string;
    readonly appClientIdMobile: string;
    readonly appClientIdAdmin: string;
    readonly region: string;
}

/**
 * S3 configuration for the storage adapter. Bucket names are intentionally
 * optional at config load — loadConfig must succeed even on Lambdas that
 * never construct `S3StorageGateway` (e.g. the auth handlers). Validation
 * that the buckets are non-empty happens at gateway construction time,
 * where it can throw a descriptive `StorageError`.
 */
export interface S3Config {
    /** Bucket for public-readable media. Empty when unset; gateway validates. */
    readonly publicBucket: string;
    /** Bucket for private media served via presigned GETs. Empty when unset. */
    readonly privateBucket: string;
    /** Lifetime of issued upload (PUT) URLs. Defaults to 900 seconds. */
    readonly uploadUrlExpiresSeconds: number;
    /** Lifetime of issued read (GET) URLs. Defaults to 3600 seconds. */
    readonly readUrlExpiresSeconds: number;
}

/**
 * Booking-side configuration. Used by slot computation (Phase 3) and
 * appointment-state guards (Phase 4+). Defaults come from
 * `backend/.env.example`.
 */
export interface BookingConfig {
    /** Granularity at which bookable slot starts are emitted. Positive integer. */
    readonly slotStepMinutes: number;
    /** Minimum gap between adjacent appointments. Non-negative integer. */
    readonly bufferMinutes: number;
    /**
     * Customer-side cancellation cutoff: how many minutes before
     * `starts_at` a customer may still cancel without admin
     * intervention. Non-negative integer; `0` disables the cutoff
     * (allow cancel up to the second the appointment starts). MVP
     * default is 240 minutes (4 hours) — see
     * `docs/tasks/PHASE_4_BOOKING.md`.
     */
    readonly cancelCutoffMinutes: number;
    /** IANA timezone for the marketplace (e.g. `Africa/Addis_Ababa`). */
    readonly defaultTimezone: string;
}

/**
 * Generic SMS provider configuration. Populated when every
 * required env var is present (`SMS_PROVIDER_API_BASE_URL` +
 * `SMS_PROVIDER_API_KEY` + `SMS_PROVIDER_SENDER_ID`); `null`
 * when any one is absent. The dispatcher (future commit) checks
 * the slot before constructing a `GenericSmsGateway` and falls
 * back to `MockNotificationGateway` when it's null.
 *
 * Production credential resolution:
 *   * `SMS_PROVIDER_API_KEY` may be supplied directly via the
 *     Lambda env in dev / docker-compose.
 *   * In production, `SMS_PROVIDER_API_KEY_SECRET_ARN` points at
 *     a Secrets Manager secret holding the key. A future
 *     `loadSecretsThenConfig` extension resolves the ARN and
 *     writes the value into `SMS_PROVIDER_API_KEY` before
 *     delegating to `loadConfig`. The extension is not in this
 *     commit — `loadConfig` only reads the env var directly,
 *     mirroring the `PG_PASSWORD` pattern.
 *
 * The `apiKeySecretArn` field is preserved here so operators can
 * see at a glance whether a Lambda has the production secret
 * wiring vs. the dev plain-env wiring. The future Secrets Manager
 * resolution path uses the same field as its trigger.
 */
export interface SmsProviderConfig {
    /** Provider base URL (e.g. `https://api.afromessage.com`). No trailing slash required. */
    readonly apiBaseUrl: string;
    /** Resolved API key. Comes from `SMS_PROVIDER_API_KEY` directly in dev; resolved from `SMS_PROVIDER_API_KEY_SECRET_ARN` via the future Secrets Manager seam in prod. */
    readonly apiKey: string;
    /** ARN of the Secrets Manager secret holding the API key, when set. Empty string in dev where the key comes from `SMS_PROVIDER_API_KEY` directly. */
    readonly apiKeySecretArn: string;
    /** Sender display name registered with the vendor (e.g. `EthioLink`). */
    readonly senderId: string;
    /** Provider identifier written to `notification_logs.provider`. Defaults to `'GENERIC_SMS'`. */
    readonly providerName: string;
    /** HTTP request timeout in milliseconds. Default 10000 (10 s). */
    readonly timeoutMs: number;
}

/**
 * Phase 9 Track 2 — Telegram provider configuration. Populated
 * when `TELEGRAM_BOT_USERNAME` is present AND both
 * `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are resolved
 * (directly via env or via Secrets Manager through
 * `loadSecretsThenConfig`); `null` otherwise. The future
 * notification-service factory checks this slot before
 * constructing the real gateway.
 *
 * Production credential resolution mirrors the SMS pattern:
 *   * `TELEGRAM_BOT_TOKEN` env var holds the plain token in dev /
 *     docker-compose.
 *   * `TELEGRAM_BOT_TOKEN_SECRET_ARN` points at a Secrets Manager
 *     secret for prod; `loadSecretsThenConfig` resolves the ARN
 *     and writes the value into `TELEGRAM_BOT_TOKEN` before
 *     delegating here.
 *   * Same pattern for `TELEGRAM_WEBHOOK_SECRET` /
 *     `TELEGRAM_WEBHOOK_SECRET_ARN`.
 *
 * `botUsername` is non-sensitive and lives in the plain env stack
 * (it's the public `@<username>` everyone can see when they tap
 * the deep link). The two secret ARN fields are passthrough
 * metadata — the gateway does not consume them; they're recorded
 * so an operator can verify at a glance whether a Lambda is on the
 * production secret wiring vs. the dev plain-env wiring.
 */
export interface TelegramProviderConfig {
    /** Bot username without leading `@`. Used by the link-code service for the deep link. */
    readonly botUsername: string;
    /** Bot token from BotFather. Plain in dev; resolved from Secrets Manager in prod. */
    readonly botToken: string;
    /** ARN of the Secrets Manager secret holding the bot token, when set. Empty string in dev. */
    readonly botTokenSecretArn: string;
    /** Webhook secret token passed via `X-Telegram-Bot-Api-Secret-Token` on inbound webhook calls. */
    readonly webhookSecret: string;
    /** ARN of the Secrets Manager secret holding the webhook secret, when set. */
    readonly webhookSecretArn: string;
    /** Provider identifier written to `notification_logs.provider`. Defaults to `'TELEGRAM_BOT'`. */
    readonly providerName: string;
    /** TTL for issued linking codes, in seconds. Defaults to 600 (10 minutes). */
    readonly linkCodeTtlSeconds: number;
    /** HTTP request timeout in milliseconds. Default 10000 (10 s). */
    readonly timeoutMs: number;
}

export interface AppConfig {
    readonly nodeEnv: NodeEnv;
    readonly logLevel: LogLevel;
    readonly region: string;
    readonly pg: PgConfig;
    readonly cognito: CognitoConfig;
    readonly s3: S3Config;
    readonly booking: BookingConfig;
    /** SMS provider config when wired; `null` when the operator hasn't opted in. */
    readonly smsProvider: SmsProviderConfig | null;
    /** Telegram provider config when wired; `null` when the operator hasn't opted in. */
    readonly telegramProvider: TelegramProviderConfig | null;
    /**
     * Provider-selector flag. The notification-service factory
     * reads this alongside `smsProvider` to decide whether to wire
     * `GenericSmsGateway` for the `SMS` channel. `'mock'` is the
     * safe default and keeps the gateway dormant even when SMS
     * config is present.
     */
    readonly notificationsProvider: NotificationsProvider;
}

/** Raised when required config is missing. Carries the full list of names. */
export class MissingConfigError extends Error {
    public readonly missing: readonly string[];

    constructor(missing: readonly string[]) {
        super(
            `Missing required environment variables: ${missing.join(', ')}. ` +
                `See backend/.env.example for the full list.`,
        );
        this.name = 'MissingConfigError';
        this.missing = missing;
    }
}

/** Raised when a variable is present but cannot be parsed (e.g. non-numeric PG_PORT). */
export class InvalidConfigError extends Error {
    public readonly variable: string;

    constructor(variable: string, reason: string) {
        super(`Invalid value for ${variable}: ${reason}`);
        this.name = 'InvalidConfigError';
        this.variable = variable;
    }
}

const REQUIRED_VARS = [
    'PG_HOST',
    'PG_DATABASE',
    'PG_USER',
    'PG_PASSWORD',
    'COGNITO_USER_POOL_ID',
    'COGNITO_APP_CLIENT_ID_MOBILE',
    'COGNITO_APP_CLIENT_ID_ADMIN',
    'COGNITO_REGION',
] as const;

const VALID_NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const VALID_NOTIFICATIONS_PROVIDERS: readonly NotificationsProvider[] = [
    'mock',
    'sms',
    'telegram',
    'production',
];

/**
 * Read and validate configuration from the given env-like map.
 *
 * @param env  Source of values. Defaults to `process.env`. Tests pass a
 *             literal record so they do not have to mutate global state.
 * @returns    An immutable {@link AppConfig}.
 * @throws     {@link MissingConfigError} if any required variable is absent
 *             or blank. {@link InvalidConfigError} if a parseable variable
 *             has an unusable value (e.g., non-numeric port).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const missing = REQUIRED_VARS.filter((name) => !isPresent(env[name]));
    if (missing.length > 0) {
        throw new MissingConfigError(missing);
    }

    const nodeEnv = parseEnum<NodeEnv>('NODE_ENV', env.NODE_ENV, VALID_NODE_ENVS, 'development');
    const logLevel = parseEnum<LogLevel>('LOG_LEVEL', env.LOG_LEVEL, VALID_LOG_LEVELS, 'info');

    return Object.freeze<AppConfig>({
        nodeEnv,
        logLevel,
        region: env.APP_REGION?.trim() || 'eu-west-1',
        pg: Object.freeze<PgConfig>({
            host: env.PG_HOST!.trim(),
            port: parseInt32('PG_PORT', env.PG_PORT, 5432),
            database: env.PG_DATABASE!.trim(),
            user: env.PG_USER!.trim(),
            password: env.PG_PASSWORD!,
            ssl: parseBool('PG_SSL', env.PG_SSL, false),
        }),
        cognito: Object.freeze<CognitoConfig>({
            userPoolId: env.COGNITO_USER_POOL_ID!.trim(),
            appClientIdMobile: env.COGNITO_APP_CLIENT_ID_MOBILE!.trim(),
            appClientIdAdmin: env.COGNITO_APP_CLIENT_ID_ADMIN!.trim(),
            region: env.COGNITO_REGION!.trim(),
        }),
        s3: Object.freeze<S3Config>({
            publicBucket: env.S3_BUCKET_MEDIA_PUBLIC?.trim() ?? '',
            privateBucket: env.S3_BUCKET_MEDIA_PRIVATE?.trim() ?? '',
            uploadUrlExpiresSeconds: parsePositiveInteger(
                'S3_UPLOAD_URL_EXPIRES_SECONDS',
                env.S3_UPLOAD_URL_EXPIRES_SECONDS,
                900,
            ),
            readUrlExpiresSeconds: parsePositiveInteger(
                'S3_READ_URL_EXPIRES_SECONDS',
                env.S3_READ_URL_EXPIRES_SECONDS,
                3600,
            ),
        }),
        booking: Object.freeze<BookingConfig>({
            slotStepMinutes: parsePositiveInteger(
                'BOOKING_SLOT_STEP_MINUTES',
                env.BOOKING_SLOT_STEP_MINUTES,
                15,
            ),
            bufferMinutes: parseNonNegativeInteger(
                'BOOKING_BUFFER_MINUTES',
                env.BOOKING_BUFFER_MINUTES,
                5,
            ),
            cancelCutoffMinutes: parseNonNegativeInteger(
                'BOOKING_CANCEL_CUTOFF_MINUTES',
                env.BOOKING_CANCEL_CUTOFF_MINUTES,
                240,
            ),
            defaultTimezone:
                env.DEFAULT_TIMEZONE?.trim() || 'Africa/Addis_Ababa',
        }),
        smsProvider: buildSmsProviderConfig(env),
        telegramProvider: buildTelegramProviderConfig(env),
        notificationsProvider: parseEnum<NotificationsProvider>(
            'NOTIFICATIONS_PROVIDER',
            env.NOTIFICATIONS_PROVIDER,
            VALID_NOTIFICATIONS_PROVIDERS,
            'mock',
        ),
    });
}

/**
 * Build the optional SMS provider config from env vars. Returns
 * `null` when any one of the three required env vars is missing —
 * the dispatcher checks the slot before constructing a real
 * gateway and falls back to `MockNotificationGateway` otherwise.
 *
 * The Secrets Manager wiring (`SMS_PROVIDER_API_KEY_SECRET_ARN`)
 * is recorded on the config object for visibility but its
 * resolution lives in a future `loadSecretsThenConfig` extension —
 * `loadConfig` only reads the (already-resolved or dev-plain)
 * `SMS_PROVIDER_API_KEY` env var directly.
 */
function buildSmsProviderConfig(
    env: NodeJS.ProcessEnv,
): SmsProviderConfig | null {
    const apiBaseUrl = env.SMS_PROVIDER_API_BASE_URL?.trim() ?? '';
    const apiKey = env.SMS_PROVIDER_API_KEY?.trim() ?? '';
    const senderId = env.SMS_PROVIDER_SENDER_ID?.trim() ?? '';

    if (!apiBaseUrl || !apiKey || !senderId) {
        return null;
    }

    return Object.freeze<SmsProviderConfig>({
        apiBaseUrl,
        apiKey,
        apiKeySecretArn: env.SMS_PROVIDER_API_KEY_SECRET_ARN?.trim() ?? '',
        senderId,
        providerName:
            env.SMS_PROVIDER_NAME?.trim() || 'GENERIC_SMS',
        timeoutMs: parsePositiveInteger(
            'SMS_PROVIDER_TIMEOUT_MS',
            env.SMS_PROVIDER_TIMEOUT_MS,
            10000,
        ),
    });
}

/**
 * Build the optional Telegram provider config. Returns `null`
 * when any of the three required values (`TELEGRAM_BOT_USERNAME`,
 * `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`) is missing —
 * the future factory checks the slot before constructing a real
 * gateway and falls back to `MockNotificationGateway` /
 * `GenericSmsGateway` otherwise.
 *
 * Secrets Manager resolution (`TELEGRAM_BOT_TOKEN_SECRET_ARN` +
 * `TELEGRAM_WEBHOOK_SECRET_ARN`) lives in `loadSecretsThenConfig`;
 * this function only reads the already-resolved env vars.
 */
function buildTelegramProviderConfig(
    env: NodeJS.ProcessEnv,
): TelegramProviderConfig | null {
    const botUsername = env.TELEGRAM_BOT_USERNAME?.trim() ?? '';
    const botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
    const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';

    if (!botUsername || !botToken || !webhookSecret) {
        return null;
    }

    return Object.freeze<TelegramProviderConfig>({
        botUsername,
        botToken,
        botTokenSecretArn:
            env.TELEGRAM_BOT_TOKEN_SECRET_ARN?.trim() ?? '',
        webhookSecret,
        webhookSecretArn:
            env.TELEGRAM_WEBHOOK_SECRET_ARN?.trim() ?? '',
        providerName:
            env.TELEGRAM_PROVIDER_NAME?.trim() || 'TELEGRAM_BOT',
        linkCodeTtlSeconds: parsePositiveInteger(
            'TELEGRAM_LINK_CODE_TTL_SECONDS',
            env.TELEGRAM_LINK_CODE_TTL_SECONDS,
            600,
        ),
        timeoutMs: parsePositiveInteger(
            'TELEGRAM_TIMEOUT_MS',
            env.TELEGRAM_TIMEOUT_MS,
            10000,
        ),
    });
}

function isPresent(value: string | undefined): boolean {
    return value !== undefined && value.trim() !== '';
}

function parseEnum<T extends string>(
    name: string,
    raw: string | undefined,
    valid: readonly T[],
    fallback: T,
): T {
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const candidate = raw.trim().toLowerCase() as T;
    if (!valid.includes(candidate)) {
        throw new InvalidConfigError(name, `expected one of ${valid.join('|')}, got "${raw}"`);
    }
    return candidate;
}

function parseInt32(name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        throw new InvalidConfigError(name, `expected a positive integer port, got "${raw}"`);
    }
    return parsed;
}

function parsePositiveInteger(
    name: string,
    raw: string | undefined,
    fallback: number,
): number {
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new InvalidConfigError(name, `expected a positive integer, got "${raw}"`);
    }
    return parsed;
}

function parseNonNegativeInteger(
    name: string,
    raw: string | undefined,
    fallback: number,
): number {
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new InvalidConfigError(
            name,
            `expected a non-negative integer, got "${raw}"`,
        );
    }
    return parsed;
}

function parseBool(name: string, raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const normalized = raw.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    throw new InvalidConfigError(name, `expected a boolean, got "${raw}"`);
}
