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
