// EthioLink — Lambda cold-start config loader with Secrets Manager resolution.
//
// The Lambda execution environment carries every non-sensitive
// configuration value as a plain environment variable (set by the
// Terraform Lambda module's `environment` block). The Postgres
// master password is the one value we deliberately keep OUT of
// Lambda env vars — env vars are visible in plaintext in the AWS
// console and in the Terraform state file, which defeats the
// purpose of storing the password in Secrets Manager.
//
// `loadSecretsThenConfig` is the async wrapper every Lambda's
// cold-start init should call instead of `loadConfig`. The flow:
//
//   1. If `env.PG_SECRET_ARN` is absent, delegate directly to
//      `loadConfig(env)`. This preserves local-dev / docker-compose
//      behavior where `PG_PASSWORD` is already in `process.env`
//      from `backend/.env`. No SDK import, no network call.
//   2. If `PG_SECRET_ARN` is present, look up the cached
//      previously-resolved value for that ARN. On hit (warm
//      invocation), skip the network call.
//   3. On miss (cold start), call `secretsResolver.resolve(arn)`
//      — the default resolver uses `@aws-sdk/client-secrets-manager`;
//      tests inject a fake that doesn't touch the network.
//      Parse the JSON shape produced by the Terraform RDS module:
//      `{ username, password, engine, host, port, dbname,
//      dbInstanceIdentifier }`.
//   4. Build a derived env: secret-derived values fill in only
//      the keys the input env doesn't already specify. The
//      password ALWAYS comes from the secret (never the input
//      env, even if `PG_PASSWORD` is present there — explicit
//      `PG_SECRET_ARN` wins). `PG_HOST` / `PG_PORT` / `PG_DATABASE`
//      / `PG_USER` defer to the input env when present and fall
//      back to the secret's value when not. This lets the
//      Terraform Lambda env set explicit `PG_HOST` (e.g. the
//      RDS Proxy endpoint, which is different from the secret's
//      `host` value that points at the direct DB endpoint) and
//      the secret's host value never overrides it.
//   5. Delegate to `loadConfig(derivedEnv)` and return.
//
// Caching:
//   The cache lives at module scope keyed by secret ARN. Lambda
//   warm invocations reuse the resolved value without re-calling
//   Secrets Manager. Tests inject a fresh `Map` to avoid leaking
//   state across test cases.
//
// Why a `secretsResolver` seam:
//   Real Lambdas call the AWS SDK; tests inject a synchronous
//   in-memory resolver. The default `defaultSecretsManagerResolver()`
//   lazy-imports `@aws-sdk/client-secrets-manager` so tests that
//   never invoke it don't pay the import cost (and tests that run
//   on machines without that SDK installed don't crash).

import type { AppConfig } from './loadConfig.js';
import { loadConfig } from './loadConfig.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Shape of the value parsed from the Secrets Manager `SecretString`.
 * Matches the JSON the Terraform RDS module writes (and the shape
 * the AWS-managed RDS rotation Lambdas produce — so a future
 * rotation drop-in doesn't change the parse target).
 *
 * `username` and `password` are required; the rest are optional
 * because callers may have explicit `PG_HOST` / `PG_DATABASE` /
 * etc. set in the Lambda env (RDS Proxy endpoint vs. the secret's
 * direct-DB host, for example).
 */
export interface ResolvedRdsSecret {
    readonly username: string;
    readonly password: string;
    readonly engine?: string;
    readonly host?: string;
    readonly port?: number;
    readonly dbname?: string;
    readonly dbInstanceIdentifier?: string;
}

/**
 * Indirection over Secrets Manager. Production passes
 * `defaultSecretsManagerResolver()`; tests pass an in-memory fake.
 */
export interface SecretsResolver {
    resolve(secretArn: string): Promise<string>;
}

export interface LoadSecretsThenConfigOptions {
    /** Source of values. Defaults to `process.env`. */
    readonly env?: NodeJS.ProcessEnv;

    /**
     * How to fetch the secret. Defaults to the lazy-imported AWS
     * SDK resolver. Tests inject a fake to avoid the network call.
     */
    readonly secretsResolver?: SecretsResolver;

    /**
     * Cache of resolved secrets keyed by ARN. Defaults to the
     * module-scope cache so warm Lambda invocations reuse the
     * value. Tests pass a fresh `Map` to isolate state.
     */
    readonly cache?: Map<string, ResolvedRdsSecret>;
}

/**
 * Raised when the secret's JSON shape is wrong (missing fields,
 * non-string password, malformed JSON). Distinct from
 * `MissingConfigError` / `InvalidConfigError` so the caller can
 * tell a secret-resolution problem apart from a regular config
 * miss.
 */
export class SecretResolutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecretResolutionError';
    }
}

// ---------------------------------------------------------------------------
// Module-scope cache
// ---------------------------------------------------------------------------

/**
 * Default cache shared across all `loadSecretsThenConfig` calls
 * that don't pass a `cache` override. In Lambda this is the
 * warm-invocation cache — populated on cold start, reused for
 * the lifetime of the execution environment.
 */
const defaultCache = new Map<string, ResolvedRdsSecret>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the RDS master secret (when `PG_SECRET_ARN` is set) and
 * return a validated `AppConfig`. Always call this instead of
 * `loadConfig` at Lambda cold-start.
 *
 * @returns A frozen `AppConfig`.
 * @throws  `SecretResolutionError` when the secret JSON is
 *          missing required fields or malformed.
 * @throws  `MissingConfigError` / `InvalidConfigError` from the
 *          delegated `loadConfig` call when the resulting env is
 *          incomplete.
 */
export async function loadSecretsThenConfig(
    options: LoadSecretsThenConfigOptions = {},
): Promise<AppConfig> {
    const env = options.env ?? process.env;
    const secretArn = env.PG_SECRET_ARN?.trim();

    // No secret to resolve — preserve local-dev / docker-compose
    // behavior. `PG_PASSWORD` is already in the env from
    // `backend/.env`.
    if (!secretArn) {
        return loadConfig(env);
    }

    const cache = options.cache ?? defaultCache;
    let resolved = cache.get(secretArn);

    if (!resolved) {
        const resolver = options.secretsResolver ?? defaultSecretsManagerResolver();
        const raw = await resolver.resolve(secretArn);
        resolved = parseSecret(raw);
        cache.set(secretArn, resolved);
    }

    // Build the derived env. `PG_PASSWORD` always comes from the
    // secret (explicit `PG_SECRET_ARN` is the operator's signal
    // that they want the secret-resolved value, even if a stale
    // `PG_PASSWORD` is also present). The remaining DB-side keys
    // defer to the input env so the Terraform Lambda env can
    // point `PG_HOST` at the RDS Proxy while the secret's `host`
    // points at the direct DB endpoint.
    const derived: NodeJS.ProcessEnv = {
        ...env,
        PG_PASSWORD: resolved.password,
    };

    if (!isPresent(env.PG_HOST) && resolved.host) {
        derived.PG_HOST = resolved.host;
    }
    if (!isPresent(env.PG_PORT) && resolved.port !== undefined) {
        derived.PG_PORT = String(resolved.port);
    }
    if (!isPresent(env.PG_DATABASE) && resolved.dbname) {
        derived.PG_DATABASE = resolved.dbname;
    }
    if (!isPresent(env.PG_USER) && resolved.username) {
        derived.PG_USER = resolved.username;
    }

    return loadConfig(derived);
}

/**
 * Clear the module-scope cache. Used by tests; production code
 * has no reason to clear cache mid-lifetime.
 */
export function clearSecretsCache(): void {
    defaultCache.clear();
}

// ---------------------------------------------------------------------------
// Default resolver — lazy-imports the AWS SDK so tests don't
// pay the import cost.
// ---------------------------------------------------------------------------

export function defaultSecretsManagerResolver(): SecretsResolver {
    return {
        async resolve(secretArn: string): Promise<string> {
            const { SecretsManagerClient, GetSecretValueCommand } = await import(
                '@aws-sdk/client-secrets-manager'
            );
            const region =
                process.env.APP_REGION?.trim() ||
                process.env.AWS_REGION?.trim() ||
                'eu-west-1';

            const client = new SecretsManagerClient({ region });
            const response = await client.send(
                new GetSecretValueCommand({ SecretId: secretArn }),
            );

            if (typeof response.SecretString !== 'string' || response.SecretString === '') {
                throw new SecretResolutionError(
                    `Secrets Manager returned no SecretString for ${secretArn}. ` +
                        'The secret may be binary-only or empty; the Terraform RDS ' +
                        'module always writes a JSON SecretString, so this indicates ' +
                        'an out-of-band edit.',
                );
            }
            return response.SecretString;
        },
    };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseSecret(raw: string): ResolvedRdsSecret {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new SecretResolutionError(
            `RDS master secret is not valid JSON: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SecretResolutionError(
            'RDS master secret JSON must be a non-array object.',
        );
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.password !== 'string' || obj.password === '') {
        throw new SecretResolutionError(
            'RDS master secret is missing the `password` string field.',
        );
    }
    if (typeof obj.username !== 'string' || obj.username === '') {
        throw new SecretResolutionError(
            'RDS master secret is missing the `username` string field.',
        );
    }

    return Object.freeze<ResolvedRdsSecret>({
        username: obj.username,
        password: obj.password,
        engine: typeof obj.engine === 'string' ? obj.engine : undefined,
        host: typeof obj.host === 'string' ? obj.host : undefined,
        port: typeof obj.port === 'number' && Number.isFinite(obj.port) ? obj.port : undefined,
        dbname: typeof obj.dbname === 'string' ? obj.dbname : undefined,
        dbInstanceIdentifier:
            typeof obj.dbInstanceIdentifier === 'string' ? obj.dbInstanceIdentifier : undefined,
    });
}

function isPresent(value: string | undefined): boolean {
    return value !== undefined && value.trim() !== '';
}
