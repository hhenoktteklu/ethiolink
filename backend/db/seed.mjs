// EthioLink — local seed runner.
//
// Sibling to `migrate.mjs`. Applies every `.sql` file in
// `backend/db/seeds/` exactly once, tracking which have already been
// applied in a `schema_seeds` table the runner owns.
//
// Seeds vs migrations — why two tools?
//   * Migrations are schema changes. They must be applied in order, never
//     re-applied, and are immutable once committed.
//   * Seeds are *data*. They are typically written to be re-runnable
//     anyway (`ON CONFLICT DO UPDATE`-style), but tracking applied seeds
//     in `schema_seeds` keeps the re-run a fast no-op and decouples
//     production data state from schema state.
//
// Scope: developer laptops and CI. Production data seeding will be
// handled by a deploy-time step alongside Lambda + RDS provisioning;
// this script is strictly the local-dev `npm run db:seed` path.
//
// Defaults match docker-compose.yml, so a fresh `docker-compose up -d`
// followed by `npm run db:migrate && npm run db:seed` works with no env
// configuration. Override any connection parameter by exporting the
// matching `PG_*` variable.
//
// Failure model:
//   * Each seed file is expected to manage its own transaction with
//     BEGIN/COMMIT and to be idempotent (e.g. `INSERT ... ON CONFLICT`).
//     The runner does not wrap files in an extra transaction.
//   * If a seed fails, the file's own ROLLBACK runs; the runner skips
//     the `schema_seeds` INSERT and exits non-zero. Re-running picks up
//     where it left off.
//   * If the file succeeds but the post-INSERT fails (e.g. network blip),
//     the next run will see the seed as un-applied and re-run it. Seed
//     files are expected to be idempotent, so this is safe by design.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = join(__dirname, 'seeds');

const DEFAULTS = {
    host: 'localhost',
    port: 5432,
    database: 'ethiolink',
    user: 'ethiolink',
    password: 'ethiolink',
    ssl: false,
};

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

async function ensureSeedsTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_seeds (
            filename    text        PRIMARY KEY,
            applied_at  timestamptz NOT NULL DEFAULT now()
        );
    `);
}

async function listSeedFiles() {
    const entries = await readdir(SEEDS_DIR, { withFileTypes: true });
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

async function applySeed(client, filename) {
    const sql = await readFile(join(SEEDS_DIR, filename), 'utf8');
    // Seed files own their own BEGIN/COMMIT.
    await client.query(sql);
    // Record only after the seed's own transaction has committed.
    await client.query(
        'INSERT INTO schema_seeds (filename) VALUES ($1)',
        [filename],
    );
}

async function main() {
    const config = readConfig();
    const client = new Client({
        ...config,
        ssl: config.ssl ? { rejectUnauthorized: false } : false,
    });

    const target = `${config.user}@${config.host}:${config.port}/${config.database}`;
    console.log(`Connecting to ${target} ...`);
    await client.connect();

    let appliedCount = 0;
    try {
        await ensureSeedsTable(client);
        const files = await listSeedFiles();
        if (files.length === 0) {
            console.log('No seed files found.');
            return;
        }
        const applied = await listAppliedFilenames(client);

        for (const file of files) {
            if (applied.has(file)) {
                console.log(`[skip] ${file}`);
                continue;
            }
            process.stdout.write(`[seed] ${file} ... `);
            await applySeed(client, file);
            console.log('ok');
            appliedCount += 1;
        }
    } finally {
        await client.end();
    }

    if (appliedCount === 0) {
        console.log('Seed data is up to date.');
    } else {
        console.log(`Applied ${appliedCount} seed(s).`);
    }
}

main().catch((err) => {
    console.error('Seeding failed:');
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
});
