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
