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

export interface AppConfig {
    readonly nodeEnv: NodeEnv;
    readonly logLevel: LogLevel;
    readonly region: string;
    readonly pg: PgConfig;
    readonly cognito: CognitoConfig;
    readonly s3: S3Config;
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

function parseBool(name: string, raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const normalized = raw.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    throw new InvalidConfigError(name, `expected a boolean, got "${raw}"`);
}
