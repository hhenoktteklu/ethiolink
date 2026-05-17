// EthioLink — seed runner.
//
// Two call sites share this file:
//
//   1. **Local CLI** (`npm run db:seed` on the developer's laptop).
//      Reads `PG_*` env vars, defaults to docker-compose, logs to
//      stdout, exits non-zero on failure.
//   2. **Maintenance Lambda** (`backend/lambdas/maintenance/dbMigrate.ts`).
//      Imports `runSeeds` directly, supplies its own pre-configured
//      `pg.Client` (built from Secrets Manager resolution) and a
//      logger that writes to the Lambda's CloudWatch log stream.
//      Triggered by `event.seed === true` or `event.mode === "seed"`.
//
// The CLI behavior is gated on running as the main module so the
// Lambda's `import` of this file does NOT re-trigger the CLI path.
//
// Seeds vs migrations — why two tools?
//   * Migrations are schema changes. They must be applied in order,
//     never re-applied, and are immutable once committed.
//   * Seeds are *data*. They are typically written to be re-runnable
//     anyway (`ON CONFLICT DO UPDATE`-style), but tracking applied
//     seeds in `schema_seeds` keeps the re-run a fast no-op and
//     decouples production data state from schema state.
//
// Scope:
//   * Developer laptops (`npm run db:seed`).
//   * The maintenance Lambda for dev RDS reseeding when the database
//     lives behind private subnets.
//
// Failure model:
//   * Each seed file owns its own BEGIN/COMMIT and is expected to be
//     idempotent (`INSERT ... ON CONFLICT`). The runner does NOT wrap
//     files in an extra transaction.
//   * If a seed fails, the file's own ROLLBACK runs; the runner
//     records the failure in the returned summary and stops so a
//     partial-apply doesn't cascade.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SEEDS_DIR = join(__dirname, 'seeds');

const DEFAULTS = {
    host: 'localhost',
    port: 5432,
    database: 'ethiolink',
    user: 'ethiolink',
    password: 'ethiolink',
    ssl: false,
};

// ---------------------------------------------------------------------------
// Exported runner — consumed by the Lambda + the CLI below.
// ---------------------------------------------------------------------------

/**
 * Apply every pending seed in order.
 *
 * @param {object}   options
 * @param {import('pg').Client} options.client     Connected client.
 * @param {string}  [options.seedsDir]             Directory holding the `.sql` files. Defaults to the runner's sibling `seeds/`.
 * @param {(line: string) => void} [options.log]   Logger. Defaults to `console.log`.
 *
 * @returns {Promise<{ applied: string[]; skipped: string[]; failed: { filename: string; error: string }[] }>}
 *
 * Behavior:
 *   * Stops applying after the first failed file. The failed file is
 *     appended to `failed[]`; remaining (unattempted) files do NOT
 *     appear in any of the three buckets — the caller knows the data
 *     state is in an unknown shape and a re-run is needed.
 *   * Per-file BEGIN/COMMIT is the file's responsibility.
 */
export async function runSeeds({
    client,
    seedsDir = DEFAULT_SEEDS_DIR,
    log = (line) => console.log(line),
} = {}) {
    if (!client) {
        throw new Error('runSeeds: `client` is required.');
    }

    const applied = [];
    const skipped = [];
    const failed = [];

    await ensureSeedsTable(client);
    const files = await listSeedFiles(seedsDir);
    if (files.length === 0) {
        log('No seed files found.');
        return { applied, skipped, failed };
    }

    const alreadyApplied = await listAppliedFilenames(client);

    for (const file of files) {
        if (alreadyApplied.has(file)) {
            log(`[skip]  ${file}`);
            skipped.push(file);
            continue;
        }
        try {
            log(`[seed]  ${file}`);
            await applySeed(client, file, seedsDir);
            applied.push(file);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(`[fail]  ${file}: ${message}`);
            failed.push({ filename: file, error: message });
            // Stop on first failure. Re-run after fixing the file.
            break;
        }
    }

    return { applied, skipped, failed };
}

// ---------------------------------------------------------------------------
// Internals — used by both the CLI and the exported runner.
// ---------------------------------------------------------------------------

async function ensureSeedsTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_seeds (
            filename    text        PRIMARY KEY,
            applied_at  timestamptz NOT NULL DEFAULT now()
        );
    `);
}

async function listSeedFiles(seedsDir) {
    const entries = await readdir(seedsDir, { withFileTypes: true });
    return entries
        .filter((e) => e.isFile() && e.name.endsWith('.sql'))
        .map((e) => e.name)
        .sort();
}

async function listAppliedFilenames(client) {
    const { rows } = await client.query(
        'SELECT filename FROM schema_seeds ORDER BY filename',
    );
    return new Set(rows.map((r) => r.filename));
}

async function applySeed(client, filename, seedsDir) {
    const sql = await readFile(join(seedsDir, filename), 'utf8');
    // Seed files own their own BEGIN/COMMIT.
    await client.query(sql);
    // Record only after the seed's own transaction has committed.
    await client.query(
        'INSERT INTO schema_seeds (filename) VALUES ($1)',
        [filename],
    );
}

function readConfig() {
    const sslRaw = (process.env.PG_SSL ?? '').trim().toLowerCase();
    const sslOn = sslRaw === 'true' || sslRaw === '1' || sslRaw === 'yes' || sslRaw === 'on';
    return {
        host: nonEmpty(process.env.PG_HOST) ?? DEFAULTS.host,
        port: parsePort(process.env.PG_PORT) ?? DEFAULTS.port,
        database: nonEmpty(process.env.PG_DATABASE) ?? DEFAULTS.database,
        user: nonEmpty(process.env.PG_USER) ?? DEFAULTS.user,
        password: process.env.PG_PASSWORD ?? DEFAULTS.password,
        ssl: sslRaw === '' ? DEFAULTS.ssl : sslOn,
    };
}

function nonEmpty(value) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

function parsePort(raw) {
    if (raw === undefined || raw === null || `${raw}`.trim() === '') return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        throw new Error(`Invalid PG_PORT: ${raw}`);
    }
    return parsed;
}

// ---------------------------------------------------------------------------
// CLI entry — only fires when this file is invoked directly via
// `node db/seed.mjs`. The Lambda's `import` does NOT trigger it.
// ---------------------------------------------------------------------------

async function main() {
    const config = readConfig();
    const client = new Client({
        ...config,
        ssl: config.ssl ? { rejectUnauthorized: false } : false,
    });

    const target = `${config.user}@${config.host}:${config.port}/${config.database}`;
    console.log(`Connecting to ${target} ...`);
    await client.connect();

    let summary;
    try {
        summary = await runSeeds({ client });
    } finally {
        await client.end();
    }

    if (summary.failed.length > 0) {
        console.error(`Seed failed on ${summary.failed[0].filename}: ${summary.failed[0].error}`);
        process.exitCode = 1;
        return;
    }

    if (summary.applied.length === 0) {
        console.log('Seed data is up to date.');
    } else {
        console.log(`Applied ${summary.applied.length} seed(s).`);
    }
}

// Only run the CLI when this module is invoked directly.
const invokedDirectly =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    main().catch((err) => {
        console.error('Seeding failed:');
        console.error(err instanceof Error ? err.stack ?? err.message : err);
        process.exitCode = 1;
    });
}
