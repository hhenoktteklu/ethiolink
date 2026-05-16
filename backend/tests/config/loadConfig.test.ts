// EthioLink — loadConfig() unit tests.
//
// Phase 1 test plan: "loadConfig() errors loudly on missing required env vars."
// Beyond that, we exercise:
//   * Defaults applied when optional vars are absent.
//   * Blank strings are treated as missing.
//   * InvalidConfigError fires for non-numeric PG_PORT and unknown enums.
//   * PG_SSL accepts the common boolean spellings.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    InvalidConfigError,
    MissingConfigError,
    loadConfig,
} from '../../shared/config/loadConfig.js';

const VALID_ENV: NodeJS.ProcessEnv = Object.freeze({
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    APP_REGION: 'eu-west-1',
    PG_HOST: 'localhost',
    PG_PORT: '5432',
    PG_DATABASE: 'ethiolink',
    PG_USER: 'ethiolink',
    PG_PASSWORD: 'ethiolink',
    PG_SSL: 'false',
    COGNITO_USER_POOL_ID: 'eu-west-1_xxxx',
    COGNITO_APP_CLIENT_ID_MOBILE: 'mobile-client',
    COGNITO_APP_CLIENT_ID_ADMIN: 'admin-client',
    COGNITO_REGION: 'eu-west-1',
});

const REQUIRED = [
    'COGNITO_APP_CLIENT_ID_ADMIN',
    'COGNITO_APP_CLIENT_ID_MOBILE',
    'COGNITO_REGION',
    'COGNITO_USER_POOL_ID',
    'PG_DATABASE',
    'PG_HOST',
    'PG_PASSWORD',
    'PG_USER',
];

describe('loadConfig — happy path', () => {
    it('returns a typed config from a fully populated env', () => {
        const config = loadConfig({ ...VALID_ENV });

        assert.strictEqual(config.nodeEnv, 'test');
        assert.strictEqual(config.logLevel, 'info');
        assert.strictEqual(config.region, 'eu-west-1');
        assert.deepStrictEqual(config.pg, {
            host: 'localhost',
            port: 5432,
            database: 'ethiolink',
            user: 'ethiolink',
            password: 'ethiolink',
            ssl: false,
        });
        assert.deepStrictEqual(config.cognito, {
            userPoolId: 'eu-west-1_xxxx',
            appClientIdMobile: 'mobile-client',
            appClientIdAdmin: 'admin-client',
            region: 'eu-west-1',
        });
    });

    it('applies defaults when optional vars are absent', () => {
        const env: NodeJS.ProcessEnv = { ...VALID_ENV };
        delete env.NODE_ENV;
        delete env.LOG_LEVEL;
        delete env.APP_REGION;
        delete env.PG_PORT;
        delete env.PG_SSL;

        const config = loadConfig(env);

        assert.strictEqual(config.nodeEnv, 'development');
        assert.strictEqual(config.logLevel, 'info');
        assert.strictEqual(config.region, 'eu-west-1');
        assert.strictEqual(config.pg.port, 5432);
        assert.strictEqual(config.pg.ssl, false);
    });
});

describe('loadConfig — missing required vars', () => {
    it('throws MissingConfigError listing every absent required var', () => {
        try {
            loadConfig({});
            assert.fail('expected MissingConfigError');
        } catch (err) {
            assert.ok(err instanceof MissingConfigError, `got ${err}`);
            assert.deepStrictEqual([...err.missing].sort(), REQUIRED);
        }
    });

    it('treats whitespace-only strings as missing', () => {
        const env: NodeJS.ProcessEnv = { ...VALID_ENV, PG_HOST: '   ' };
        assert.throws(() => loadConfig(env), MissingConfigError);
    });

    it('reports just the missing subset when most vars are present', () => {
        const env: NodeJS.ProcessEnv = { ...VALID_ENV };
        delete env.PG_HOST;
        delete env.COGNITO_REGION;

        try {
            loadConfig(env);
            assert.fail('expected MissingConfigError');
        } catch (err) {
            assert.ok(err instanceof MissingConfigError);
            assert.deepStrictEqual(
                [...err.missing].sort(),
                ['COGNITO_REGION', 'PG_HOST'],
            );
        }
    });
});

describe('loadConfig — invalid values', () => {
    it('throws InvalidConfigError for a non-numeric PG_PORT', () => {
        assert.throws(
            () => loadConfig({ ...VALID_ENV, PG_PORT: 'not-a-number' }),
            InvalidConfigError,
        );
    });

    it('throws InvalidConfigError for an out-of-range PG_PORT', () => {
        assert.throws(
            () => loadConfig({ ...VALID_ENV, PG_PORT: '0' }),
            InvalidConfigError,
        );
        assert.throws(
            () => loadConfig({ ...VALID_ENV, PG_PORT: '70000' }),
            InvalidConfigError,
        );
    });

    it('throws InvalidConfigError for an unknown NODE_ENV', () => {
        assert.throws(
            () => loadConfig({ ...VALID_ENV, NODE_ENV: 'staging' }),
            InvalidConfigError,
        );
    });

    it('throws InvalidConfigError for an unknown LOG_LEVEL', () => {
        assert.throws(
            () => loadConfig({ ...VALID_ENV, LOG_LEVEL: 'trace' }),
            InvalidConfigError,
        );
    });

    it('throws InvalidConfigError for an unparseable PG_SSL', () => {
        assert.throws(
            () => loadConfig({ ...VALID_ENV, PG_SSL: 'maybe' }),
            InvalidConfigError,
        );
    });
});

describe('loadConfig — PG_SSL parsing', () => {
    for (const truthy of ['true', '1', 'YES', 'on']) {
        it(`parses "${truthy}" as ssl=true`, () => {
            assert.strictEqual(loadConfig({ ...VALID_ENV, PG_SSL: truthy }).pg.ssl, true);
        });
    }
    for (const falsy of ['false', '0', 'no', 'OFF']) {
        it(`parses "${falsy}" as ssl=false`, () => {
            assert.strictEqual(loadConfig({ ...VALID_ENV, PG_SSL: falsy }).pg.ssl, false);
        });
    }
});

describe('loadConfig — telegramProvider', () => {
    it('returns null when no Telegram env vars are set', () => {
        const config = loadConfig({ ...VALID_ENV });
        assert.strictEqual(config.telegramProvider, null);
    });

    it('returns null when only some Telegram vars are set', () => {
        const config = loadConfig({
            ...VALID_ENV,
            TELEGRAM_BOT_USERNAME: 'EthioLinkBot',
            // Missing TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET
        });
        assert.strictEqual(config.telegramProvider, null);
    });

    it('builds the config when all three required vars are present', () => {
        const config = loadConfig({
            ...VALID_ENV,
            TELEGRAM_BOT_USERNAME: 'EthioLinkBot',
            TELEGRAM_BOT_TOKEN: '123:abc',
            TELEGRAM_WEBHOOK_SECRET: 'whsec',
        });
        assert.deepStrictEqual(config.telegramProvider, {
            botUsername: 'EthioLinkBot',
            botToken: '123:abc',
            botTokenSecretArn: '',
            webhookSecret: 'whsec',
            webhookSecretArn: '',
            providerName: 'TELEGRAM_BOT',
            linkCodeTtlSeconds: 600,
            timeoutMs: 10000,
        });
    });

    it('passes through optional fields when supplied', () => {
        const config = loadConfig({
            ...VALID_ENV,
            TELEGRAM_BOT_USERNAME: 'EthioLinkBot',
            TELEGRAM_BOT_TOKEN: '123:abc',
            TELEGRAM_BOT_TOKEN_SECRET_ARN: 'arn:bot',
            TELEGRAM_WEBHOOK_SECRET: 'whsec',
            TELEGRAM_WEBHOOK_SECRET_ARN: 'arn:wh',
            TELEGRAM_PROVIDER_NAME: 'TELEGRAM_BOT_PROD',
            TELEGRAM_LINK_CODE_TTL_SECONDS: '300',
            TELEGRAM_TIMEOUT_MS: '7500',
        });
        assert.deepStrictEqual(config.telegramProvider, {
            botUsername: 'EthioLinkBot',
            botToken: '123:abc',
            botTokenSecretArn: 'arn:bot',
            webhookSecret: 'whsec',
            webhookSecretArn: 'arn:wh',
            providerName: 'TELEGRAM_BOT_PROD',
            linkCodeTtlSeconds: 300,
            timeoutMs: 7500,
        });
    });
});

describe('loadConfig — paymentsProvider / chapaProvider (Phase 10)', () => {
    it('defaults paymentsProvider to mock when unset', () => {
        const config = loadConfig({ ...VALID_ENV });
        assert.strictEqual(config.paymentsProvider, 'mock');
    });

    it('accepts paymentsProvider = chapa', () => {
        const config = loadConfig({
            ...VALID_ENV,
            PAYMENTS_PROVIDER: 'chapa',
        });
        assert.strictEqual(config.paymentsProvider, 'chapa');
    });

    it('rejects unknown paymentsProvider values', () => {
        assert.throws(
            () =>
                loadConfig({ ...VALID_ENV, PAYMENTS_PROVIDER: 'telebirr' }),
            InvalidConfigError,
        );
    });

    it('returns chapaProvider = null when no Chapa env vars are set', () => {
        const config = loadConfig({ ...VALID_ENV });
        assert.strictEqual(config.chapaProvider, null);
    });

    it('returns chapaProvider = null when CHAPA_RETURN_URL is missing', () => {
        const config = loadConfig({
            ...VALID_ENV,
            CHAPA_SECRET_KEY: 'CHASECK_TEST-x',
            CHAPA_WEBHOOK_SECRET: 'whsec',
            // No CHAPA_RETURN_URL
        });
        assert.strictEqual(config.chapaProvider, null);
    });

    it('builds chapaProvider when all required vars are present', () => {
        const config = loadConfig({
            ...VALID_ENV,
            PAYMENTS_PROVIDER: 'chapa',
            CHAPA_SECRET_KEY: 'CHASECK_TEST-x',
            CHAPA_WEBHOOK_SECRET: 'whsec',
            CHAPA_RETURN_URL: 'ethiolink://payments/return',
            CHAPA_API_BASE_URL: 'https://api.chapa.test',
            PAYMENTS_TIMEOUT_MS: '15000',
            CHAPA_SECRET_KEY_SECRET_ARN: 'arn:sk',
            CHAPA_WEBHOOK_SECRET_SECRET_ARN: 'arn:wh',
        });
        assert.deepStrictEqual(config.chapaProvider, {
            apiBaseUrl: 'https://api.chapa.test',
            secretKey: 'CHASECK_TEST-x',
            secretKeySecretArn: 'arn:sk',
            webhookSecret: 'whsec',
            webhookSecretSecretArn: 'arn:wh',
            returnUrl: 'ethiolink://payments/return',
            timeoutMs: 15000,
            providerName: 'CHAPA',
        });
    });

    it('defaults CHAPA_API_BASE_URL to the production host', () => {
        const config = loadConfig({
            ...VALID_ENV,
            CHAPA_SECRET_KEY: 'k',
            CHAPA_WEBHOOK_SECRET: 'w',
            CHAPA_RETURN_URL: 'ethiolink://payments/return',
        });
        assert.strictEqual(
            config.chapaProvider?.apiBaseUrl,
            'https://api.chapa.co',
        );
    });
});
