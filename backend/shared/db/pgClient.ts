// EthioLink — PostgreSQL client.
//
// Wraps `node-postgres` with the project's own surface area:
//   * `getPool(config)` — lazily creates and returns a process-wide `Pool`.
//     Lambda containers reuse the pool across warm invocations, so we keep
//     a single instance keyed on the pg connection params.
//   * `withClient` / `withTransaction` — acquire-and-release helpers that
//     guarantee the client returns to the pool even on error.
//   * `closePool` — for graceful shutdown in tests and local scripts.
//
// The service layer never imports this file directly; it goes through
// `BaseRepository`, which is given a `Pool` or `PoolClient`. Keeping pg
// behind a small surface lets us swap it (RDS Proxy, neon-serverless) later
// without rewriting every caller.

import { Pool, type PoolClient, type PoolConfig } from 'pg';

import type { AppConfig, PgConfig } from '../config/loadConfig.js';

// Module-scoped singletons. Keyed by the serialized pg config so that
// loadConfig() called twice with different env still gets independent pools
// (mainly useful in test fixtures).
const POOLS = new Map<string, Pool>();

/** Return (or lazily create) a connection pool for the given app config. */
export function getPool(config: AppConfig): Pool {
    const key = poolKey(config.pg);
    const existing = POOLS.get(key);
    if (existing) {
        return existing;
    }
    const pool = new Pool(toPoolConfig(config.pg));
    POOLS.set(key, pool);
    return pool;
}

/**
 * Acquire a client from the pool, run `fn`, and release the client whether
 * `fn` succeeds or throws.
 */
export async function withClient<T>(
    config: AppConfig,
    fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
    const client = await getPool(config).connect();
    try {
        return await fn(client);
    } finally {
        client.release();
    }
}

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back on
 * thrown error. The error is rethrown so the caller can handle or log it.
 */
export async function withTransaction<T>(
    config: AppConfig,
    fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
    return withClient(config, async (client) => {
        await client.query('BEGIN');
        try {
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // Swallow rollback errors so the original error surfaces.
            }
            throw err;
        }
    });
}

/**
 * Close every pool created by this module. Call from test teardown or local
 * shutdown handlers — never from inside Lambda handlers.
 */
export async function closePools(): Promise<void> {
    const pools = Array.from(POOLS.values());
    POOLS.clear();
    await Promise.all(pools.map((p) => p.end()));
}

function toPoolConfig(pg: PgConfig): PoolConfig {
    return {
        host: pg.host,
        port: pg.port,
        database: pg.database,
        user: pg.user,
        password: pg.password,
        // RDS requires TLS in production; local docker-compose Postgres does
        // not. We trust the server certificate in dev — production should
        // either bundle the RDS CA bundle or terminate TLS at RDS Proxy.
        ssl: pg.ssl ? { rejectUnauthorized: false } : false,
        // Conservative defaults sized for Lambda concurrency. Tune in Phase 7.
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
    };
}

function poolKey(pg: PgConfig): string {
    return [pg.host, pg.port, pg.database, pg.user, pg.ssl ? 'ssl' : 'nossl'].join('|');
}
