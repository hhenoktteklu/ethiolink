// EthioLink — loadSecretsThenConfig() unit tests.
//
// Coverage:
//   * Fallback: when `PG_SECRET_ARN` is absent, output equals
//     `loadConfig(env)` byte-for-byte.
//   * Happy path: secret JSON is parsed; `PG_PASSWORD` is set from
//     the secret value; remaining DB-side keys defer to the input
//     env when present and fall back to the secret otherwise.
//   * Cache: second call with the same ARN does not re-call the
//     resolver.
//   * Malformed secret: non-JSON, non-object, missing `password`
//     / `username` all throw `SecretResolutionError`.
//   * Optional derivation: missing `PG_HOST` etc. in the input env
//     pick up the secret's values.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    SecretResolutionError,
    loadSecretsThenConfig,
    type ResolvedRdsSecret,
    type SecretsResolver,
} from '../../shared/config/loadSecretsThenConfig.js';

// SMS provider env shape used by the Phase 9 tests below. Note:
// `SMS_PROVIDER_API_KEY` is intentionally absent so the secret
// resolution path runs; SMS_PROVIDER_API_BASE_URL + SENDER_ID are
// present so `config.smsProvider` builds non-null.
const SMS_ARN =
    'arn:aws:secretsmanager:eu-west-1:123:secret:ethiolink/dev/sms-provider/api-key';

const ENV_WITH_SMS_SECRET: NodeJS.ProcessEnv = Object.freeze({
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    APP_REGION: 'eu-west-1',
    PG_HOST: 'localhost',
    PG_DATABASE: 'ethiolink',
    PG_USER: 'ethiolink',
    PG_PASSWORD: 'local-pw',
    COGNITO_USER_POOL_ID: 'pool',
    COGNITO_APP_CLIENT_ID_MOBILE: 'mob',
    COGNITO_APP_CLIENT_ID_ADMIN: 'adm',
    COGNITO_REGION: 'eu-west-1',
    SMS_PROVIDER_API_BASE_URL: 'https://sms.example.com',
    SMS_PROVIDER_SENDER_ID: 'EthioLink',
    SMS_PROVIDER_API_KEY_SECRET_ARN: SMS_ARN,
});

/**
 * Per-ARN scriptable resolver. The base `FakeResolver` returns
 * one value for any ARN; this one looks up by ARN so the same
 * test can resolve both an RDS and an SMS secret without
 * cross-pollination.
 */
class MultiResolver implements SecretsResolver {
    public readonly calls: string[] = [];
    constructor(private readonly map: Record<string, string | Error>) {}
    async resolve(arn: string): Promise<string> {
        this.calls.push(arn);
        const v = this.map[arn];
        if (v === undefined) {
            throw new Error(`MultiResolver: no scripted response for ${arn}`);
        }
        if (v instanceof Error) throw v;
        return v;
    }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Env without `PG_PASSWORD` — the secret has to supply it. */
const ENV_WITH_SECRET_ARN: NodeJS.ProcessEnv = Object.freeze({
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    APP_REGION: 'eu-west-1',
    PG_HOST: 'rds-direct.example.com',
    PG_PORT: '5432',
    PG_DATABASE: 'ethiolink',
    PG_USER: 'ethiolink',
    PG_SSL: 'true',
    PG_SECRET_ARN: 'arn:aws:secretsmanager:eu-west-1:123:secret:ethiolink/dev/rds/master',
    COGNITO_USER_POOL_ID: 'eu-west-1_xxxx',
    COGNITO_APP_CLIENT_ID_MOBILE: 'mobile-client',
    COGNITO_APP_CLIENT_ID_ADMIN: 'admin-client',
    COGNITO_REGION: 'eu-west-1',
});

/** Env without a secret ARN — local-dev shape. Requires `PG_PASSWORD` already. */
const ENV_LOCAL_DEV: NodeJS.ProcessEnv = Object.freeze({
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    APP_REGION: 'eu-west-1',
    PG_HOST: 'localhost',
    PG_PORT: '5432',
    PG_DATABASE: 'ethiolink',
    PG_USER: 'ethiolink',
    PG_PASSWORD: 'local-password',
    PG_SSL: 'false',
    COGNITO_USER_POOL_ID: 'eu-west-1_xxxx',
    COGNITO_APP_CLIENT_ID_MOBILE: 'mobile-client',
    COGNITO_APP_CLIENT_ID_ADMIN: 'admin-client',
    COGNITO_REGION: 'eu-west-1',
});

const VALID_SECRET_JSON = JSON.stringify({
    username: 'ethiolink',
    password: 'secret-pw-from-aws',
    engine: 'postgres',
    host: 'rds-from-secret.example.com',
    port: 5432,
    dbname: 'ethiolink_from_secret',
    dbInstanceIdentifier: 'ethiolink-dev-rds',
});

/**
 * In-memory resolver. Counts calls so cache tests can assert.
 */
class FakeResolver implements SecretsResolver {
    public readonly calls: string[] = [];
    constructor(private readonly response: string | Error) {}
    async resolve(arn: string): Promise<string> {
        this.calls.push(arn);
        if (this.response instanceof Error) throw this.response;
        return this.response;
    }
}

// ---------------------------------------------------------------------------
// Fallback — no secret ARN
// ---------------------------------------------------------------------------

describe('loadSecretsThenConfig — no PG_SECRET_ARN', () => {
    it('delegates straight to loadConfig with the unchanged env', async () => {
        const resolver = new FakeResolver('unused');
        const config = await loadSecretsThenConfig({
            env: { ...ENV_LOCAL_DEV },
            secretsResolver: resolver,
            cache: new Map<string, ResolvedRdsSecret>(),
        });

        assert.strictEqual(config.pg.password, 'local-password');
        assert.strictEqual(config.pg.host, 'localhost');
        assert.strictEqual(resolver.calls.length, 0);
    });

    it('treats blank PG_SECRET_ARN as absent (whitespace only)', async () => {
        const resolver = new FakeResolver('unused');
        const config = await loadSecretsThenConfig({
            env: { ...ENV_LOCAL_DEV, PG_SECRET_ARN: '   ' },
            secretsResolver: resolver,
            cache: new Map<string, ResolvedRdsSecret>(),
        });
        assert.strictEqual(config.pg.password, 'local-password');
        assert.strictEqual(resolver.calls.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('loadSecretsThenConfig — happy path', () => {
    it('resolves the secret and sets PG_PASSWORD from it', async () => {
        const resolver = new FakeResolver(VALID_SECRET_JSON);
        const config = await loadSecretsThenConfig({
            env: { ...ENV_WITH_SECRET_ARN },
            secretsResolver: resolver,
            cache: new Map<string, ResolvedRdsSecret>(),
        });

        assert.strictEqual(config.pg.password, 'secret-pw-from-aws');
        // Input env's PG_HOST wins over the secret's host (RDS Proxy
        // endpoint pattern).
        assert.strictEqual(config.pg.host, 'rds-direct.example.com');
        assert.strictEqual(config.pg.database, 'ethiolink');
        assert.strictEqual(config.pg.user, 'ethiolink');
        assert.strictEqual(resolver.calls.length, 1);
        assert.strictEqual(
            resolver.calls[0],
            'arn:aws:secretsmanager:eu-west-1:123:secret:ethiolink/dev/rds/master',
        );
    });

    it('falls back to the secret values when the input env omits PG_HOST/PORT/DB/USER', async () => {
        const resolver = new FakeResolver(VALID_SECRET_JSON);

        // Strip all DB-side env keys; the secret has to fill them in.
        const lean: NodeJS.ProcessEnv = {
            NODE_ENV: 'test',
            LOG_LEVEL: 'info',
            APP_REGION: 'eu-west-1',
            PG_SSL: 'true',
            PG_SECRET_ARN: ENV_WITH_SECRET_ARN.PG_SECRET_ARN,
            COGNITO_USER_POOL_ID: 'pool',
            COGNITO_APP_CLIENT_ID_MOBILE: 'mob',
            COGNITO_APP_CLIENT_ID_ADMIN: 'adm',
            COGNITO_REGION: 'eu-west-1',
        };

        const config = await loadSecretsThenConfig({
            env: lean,
            secretsResolver: resolver,
            cache: new Map<string, ResolvedRdsSecret>(),
        });

        assert.strictEqual(config.pg.host, 'rds-from-secret.example.com');
        assert.strictEqual(config.pg.port, 5432);
        assert.strictEqual(config.pg.database, 'ethiolink_from_secret');
        assert.strictEqual(config.pg.user, 'ethiolink');
        assert.strictEqual(config.pg.password, 'secret-pw-from-aws');
    });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('loadSecretsThenConfig — cache', () => {
    it('reuses the cached secret across calls with the same ARN', async () => {
        const resolver = new FakeResolver(VALID_SECRET_JSON);
        const cache = new Map<string, ResolvedRdsSecret>();

        await loadSecretsThenConfig({
            env: { ...ENV_WITH_SECRET_ARN },
            secretsResolver: resolver,
            cache,
        });
        await loadSecretsThenConfig({
            env: { ...ENV_WITH_SECRET_ARN },
            secretsResolver: resolver,
            cache,
        });

        assert.strictEqual(resolver.calls.length, 1, 'resolver must be called only once');
        assert.strictEqual(cache.size, 1);
    });

    it('does not cross-pollinate between different ARNs', async () => {
        const resolver = new FakeResolver(VALID_SECRET_JSON);
        const cache = new Map<string, ResolvedRdsSecret>();

        const arnA = ENV_WITH_SECRET_ARN.PG_SECRET_ARN!;
        const arnB = arnA.replace('/dev/', '/prod/');

        await loadSecretsThenConfig({
            env: { ...ENV_WITH_SECRET_ARN, PG_SECRET_ARN: arnA },
            secretsResolver: resolver,
            cache,
        });
        await loadSecretsThenConfig({
            env: { ...ENV_WITH_SECRET_ARN, PG_SECRET_ARN: arnB },
            secretsResolver: resolver,
            cache,
        });

        assert.strictEqual(resolver.calls.length, 2);
        assert.strictEqual(cache.size, 2);
    });
});

// ---------------------------------------------------------------------------
// Malformed secret
// ---------------------------------------------------------------------------

describe('loadSecretsThenConfig — malformed secret', () => {
    it('throws SecretResolutionError on non-JSON', async () => {
        const resolver = new FakeResolver('not-json');
        await assert.rejects(
            () =>
                loadSecretsThenConfig({
                    env: { ...ENV_WITH_SECRET_ARN },
                    secretsResolver: resolver,
                    cache: new Map<string, ResolvedRdsSecret>(),
                }),
            (err: unknown) => err instanceof SecretResolutionError,
        );
    });

    it('throws on a non-object JSON value (e.g. an array)', async () => {
        const resolver = new FakeResolver(JSON.stringify(['username', 'password']));
        await assert.rejects(
            () =>
                loadSecretsThenConfig({
                    env: { ...ENV_WITH_SECRET_ARN },
                    secretsResolver: resolver,
                    cache: new Map<string, ResolvedRdsSecret>(),
                }),
            (err: unknown) => err instanceof SecretResolutionError,
        );
    });

    it('throws when the password field is missing', async () => {
        const resolver = new FakeResolver(
            JSON.stringify({ username: 'ethiolink' /* no password */ }),
        );
        await assert.rejects(
            () =>
                loadSecretsThenConfig({
                    env: { ...ENV_WITH_SECRET_ARN },
                    secretsResolver: resolver,
                    cache: new Map<string, ResolvedRdsSecret>(),
                }),
            (err: unknown) =>
                err instanceof SecretResolutionError &&
                /password/.test(err.message),
        );
    });

    it('throws when the username field is missing', async () => {
        const resolver = new FakeResolver(
            JSON.stringify({ password: 'pw' /* no username */ }),
        );
        await assert.rejects(
            () =>
                loadSecretsThenConfig({
                    env: { ...ENV_WITH_SECRET_ARN },
                    secretsResolver: resolver,
                    cache: new Map<string, ResolvedRdsSecret>(),
                }),
            (err: unknown) =>
                err instanceof SecretResolutionError &&
                /username/.test(err.message),
        );
    });

    it('throws when the password is the empty string', async () => {
        const resolver = new FakeResolver(
            JSON.stringify({ username: 'u', password: '' }),
        );
        await assert.rejects(
            () =>
                loadSecretsThenConfig({
                    env: { ...ENV_WITH_SECRET_ARN },
                    secretsResolver: resolver,
                    cache: new Map<string, ResolvedRdsSecret>(),
                }),
            (err: unknown) => err instanceof SecretResolutionError,
        );
    });
});

// ---------------------------------------------------------------------------
// Surface checks
// ---------------------------------------------------------------------------

describe('loadSecretsThenConfig — surface', () => {
    it('SecretResolutionError carries the expected name', () => {
        const err = new SecretResolutionError('boom');
        assert.strictEqual(err.name, 'SecretResolutionError');
        assert.ok(err instanceof Error);
    });
});

// ---------------------------------------------------------------------------
// Phase 9 — SMS provider API key resolution
// ---------------------------------------------------------------------------

describe('loadSecretsThenConfig — SMS plain-string secret', () => {
    it('writes the secret value into SMS_PROVIDER_API_KEY and builds smsProvider', async () => {
        const resolver = new MultiResolver({
            [SMS_ARN]: 'plain-sms-key-abc',
        });

        const config = await loadSecretsThenConfig({
            env: { ...ENV_WITH_SMS_SECRET },
            secretsResolver: resolver,
            cache: new Map<string, ResolvedRdsSecret>(),
            smsApiKeyCache: new Map<string, string>(),
        });

        assert.ok(config.smsProvider, 'expected smsProvider to be populated');
        assert.strictEqual(config.smsProvider!.apiKey, 'plain-sms-key-abc');
        assert.strictEqual(
            config.smsProvider!.apiBaseUrl,
            'https://sms.example.com',
        );
        assert.strictEqual(config.smsProvider!.senderId, 'EthioLink');
        assert.strictEqual(config.smsProvider!.apiKeySecretArn, SMS_ARN);
        assert.strictEqual(resolver.calls.length, 1);
        assert.strictEqual(resolver.calls[0], SMS_ARN);
    });
});

describe('loadSecretsThenConfig — SMS JSON-wrapped secret', () => {
    it('parses { "apiKey": "..." } from the SecretString', async () => {
        const resolver = new MultiResolver({
            [SMS_ARN]: JSON.stringify({ apiKey: 'json-wrapped-key' }),
        });

        const config = await loadSecretsThenConfig({
            env: { ...ENV_WITH_SMS_SECRET },
            secretsResolver: resolver,
            cache: new Map<string, ResolvedRdsSecret>(),
            smsApiKeyCache: new Map<string, string>(),
        });

        assert.ok(config.smsProvider);
        assert.strictEqual(config.smsProvider!.apiKey, 'json-wrapped-key');
    });
});

describe('loadSecretsThenConfig — SMS explicit env wins over secret', () => {
    it('does not call the resolver when SMS_PROVIDER_API_KEY is already set', async () => {
        const resolver = new MultiResolver({
            [SMS_ARN]: 'never-resolved',
        });

        const config = await loadSecretsThenConfig({
            env: {
                ...ENV_WITH_SMS_SECRET,
                SMS_PROVIDER_API_KEY: 'env-overrides-secret',
            },
            secretsResolver: resolver,
            cache: new Map<string, ResolvedRdsSecret>(),
            smsApiKeyCache: new Map<string, string>(),
        });

        assert.ok(config.smsProvider);
        assert.strictEqual(
            config.smsProvider!.apiKey,
            'env-overrides-secret',
        );
        assert.strictEqual(
            resolver.calls.length,
            0,
            'resolver must not be called when env value is present',
        );
    });
});

describe('loadSecretsThenConfig — SMS cache', () => {
    it('reuses the cached SMS API key across calls', async () => {
        const resolver = new MultiResolver({
            [SMS_ARN]: 'cached-key',
        });
        const smsCache = new Map<string, string>();

        await loadSecretsThenConfig({
            env: { ...ENV_WITH_SMS_SECRET },
            secretsResolver: resolver,
            cache: new Map<string, ResolvedRdsSecret>(),
            smsApiKeyCache: smsCache,
        });
        await loadSecretsThenConfig({
            env: { ...ENV_WITH_SMS_SECRET },
            secretsResolver: resolver,
            cache: new Map<string, ResolvedRdsSecret>(),
            smsApiKeyCache: smsCache,
        });

        assert.strictEqual(resolver.calls.length, 1, 'second call must use cache');
        assert.strictEqual(smsCache.size, 1);
        assert.strictEqual(smsCache.get(SMS_ARN), 'cached-key');
    });
});

describe('loadSecretsThenConfig — SMS malformed secret', () => {
    it('throws SecretResolutionError on empty SecretString', async () => {
        const resolver = new MultiResolver({ [SMS_ARN]: '   ' });
        await assert.rejects(
            () =>
                loadSecretsThenConfig({
                    env: { ...ENV_WITH_SMS_SECRET },
                    secretsResolver: resolver,
                    cache: new Map<string, ResolvedRdsSecret>(),
                    smsApiKeyCache: new Map<string, string>(),
                }),
            (err: unknown) =>
                err instanceof SecretResolutionError &&
                /empty/i.test(err.message),
        );
    });

    it('throws when JSON shape is missing apiKey', async () => {
        const resolver = new MultiResolver({
            [SMS_ARN]: JSON.stringify({ notTheRightField: 'x' }),
        });
        await assert.rejects(
            () =>
                loadSecretsThenConfig({
                    env: { ...ENV_WITH_SMS_SECRET },
                    secretsResolver: resolver,
                    cache: new Map<string, ResolvedRdsSecret>(),
                    smsApiKeyCache: new Map<string, string>(),
                }),
            (err: unknown) =>
                err instanceof SecretResolutionError &&
                /apiKey/.test(err.message),
        );
    });

    it('throws on malformed JSON that looks like an object', async () => {
        const resolver = new MultiResolver({
            [SMS_ARN]: '{ "apiKey": "broken',
        });
        await assert.rejects(
            () =>
                loadSecretsThenConfig({
                    env: { ...ENV_WITH_SMS_SECRET },
                    secretsResolver: resolver,
                    cache: new Map<string, ResolvedRdsSecret>(),
                    smsApiKeyCache: new Map<string, string>(),
                }),
            (err: unknown) => err instanceof SecretResolutionError,
        );
    });
});

describe('loadSecretsThenConfig — both RDS and SMS resolution together', () => {
    it('resolves both secrets via the same resolver in one call', async () => {
        const rdsArn = ENV_WITH_SECRET_ARN.PG_SECRET_ARN!;
        const resolver = new MultiResolver({
            [rdsArn]: VALID_SECRET_JSON,
            [SMS_ARN]: 'combined-test-key',
        });

        const config = await loadSecretsThenConfig({
            env: {
                ...ENV_WITH_SECRET_ARN,
                SMS_PROVIDER_API_BASE_URL: 'https://sms.example.com',
                SMS_PROVIDER_SENDER_ID: 'EthioLink',
                SMS_PROVIDER_API_KEY_SECRET_ARN: SMS_ARN,
            },
            secretsResolver: resolver,
            cache: new Map<string, ResolvedRdsSecret>(),
            smsApiKeyCache: new Map<string, string>(),
        });

        assert.strictEqual(config.pg.password, 'secret-pw-from-aws');
        assert.ok(config.smsProvider);
        assert.strictEqual(config.smsProvider!.apiKey, 'combined-test-key');
        assert.deepStrictEqual([...resolver.calls].sort(), [rdsArn, SMS_ARN].sort());
    });
});
