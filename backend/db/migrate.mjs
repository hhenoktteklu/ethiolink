// EthioLink — migration runner.
//
// Two call sites share this file:
//
//   1. **Local CLI** (`npm run db:migrate` on the developer's
//      laptop). Reads `PG_*` env vars, defaults to docker-compose,
//      logs to stdout, exits non-zero on failure.
//   2. **Maintenance Lambda** (`backend/lambdas/maintenance/dbMigrate.ts`).
//      Imports `runMigrations` directly, supplies its own
//      pre-configured `pg.Client` (built from Secrets Manager
//      resolution) and a logger that writes to the Lambda's
//      CloudWatch log stream.
//
// The CLI behavior is gated on running as the main module so the
// Lambda's `import` of this file does NOT re-trigger the CLI path.
//
// Scope: applies every `.sql` file in `backend/db/migrations/` in
// lexicographic order, exactly once, tracking which have already
// been applied in a `schema_migrations` table the runner owns.
// Files are immutable once applied — change schema with a new
// migration, never by editing an old one.
//
// Failure model:
//   * Each migration file is expected to manage its own transaction
//     with BEGIN/COMMIT (see existing 0001/0002 for the pattern).
//   * If a migration fails, the file's transaction rolls back; the
//     runner records the failure in the returned summary and stops
//     so a partial-apply doesn't cascade.
//   * The local CLI exits non-zero on failure; the Lambda returns
//     the summary so the operator sees which file failed.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'migrations');

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
 * Apply every pending migration in order.
 *
 * @param {object}   options
 * @param {import('pg').Client} options.client     Connected client.
 * @param {string}  [options.migrationsDir]        Directory holding the `.sql` files. Defaults to the runner's sibling `migrations/`.
 * @param {(line: string) => void} [options.log]   Logger. Defaults to `console.log`.
 *
 * @returns {Promise<{ applied: string[]; skipped: string[]; failed: { filename: string; error: string }[] }>}
 *
 * Behavior:
 *   * Stops applying after the first failed file. The failed file
 *     is appended to `failed[]`; remaining (unattempted) files do
 *     NOT appear in any of the three buckets — the caller knows
 *     the schema is in an unknown state and a re-run is needed.
 *   * Per-file BEGIN/COMMIT is the file's responsibility.
 */
export async function runMigrations({
    client,
    migrationsDir = DEFAULT_MIGRATIONS_DIR,
    log = (line) => console.log(line),
} = {}) {
    if (!client) {
        throw new Error('runMigrations: `client` is required.');
    }

    const applied = [];
    const skipped = [];
    const failed = [];

    await ensureMigrationsTable(client);
    const files = await listMigrationFiles(migrationsDir);
    if (files.length === 0) {
        log('No migration files found.');
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
            log(`[apply] ${file}`);
            await applyMigration(client, file, migrationsDir);
            applied.push(file);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(`[fail]  ${file}: ${message}`);
            failed.push({ filename: file, error: message });
            // Stop on first failure — partial application is the
            // worst state for a schema-evolution flow. Re-run after
            // fixing the migration.
            break;
        }
    }

    return { applied, skipped, failed };
}

// ---------------------------------------------------------------------------
// Internals — used by both the CLI and the exported runner.
// ---------------------------------------------------------------------------

async function ensureMigrationsTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename    text        PRIMARY KEY,
            applied_at  timestamptz NOT NULL DEFAULT now()
        );
    `);
}

async function listMigrationFiles(migrationsDir) {
    const entries = await readdir(migrationsDir, { withFileTypes: true });
    return entries
        .filter((e) => e.isFile() && e.name.endsWith('.sql'))
        .map((e) => e.name)
        .sort();
}

async function listAppliedFilenames(client) {
    const { rows } = await client.query(
        'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    return new Set(rows.map((r) => r.filename));
}

async function applyMigration(client, filename, migrationsDir) {
    const sql = await readFile(join(migrationsDir, filename), 'utf8');
    // Each migration owns its own BEGIN/COMMIT.
    await client.query(sql);
    // Record only after the migration's own transaction has committed.
    await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
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
// `node db/migrate.mjs`. The Lambda's `import` does NOT trigger it.
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
        summary = await runMigrations({ client });
    } finally {
        await client.end();
    }

    if (summary.failed.length > 0) {
        console.error(`Migration failed on ${summary.failed[0].filename}: ${summary.failed[0].error}`);
        process.exitCode = 1;
        return;
    }

    if (summary.applied.length === 0) {
        console.log('Schema is up to date.');
    } else {
        console.log(`Applied ${summary.applied.length} migration(s).`);
    }
}

// Only run the CLI when this module is invoked directly.
const invokedDirectly =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    main().catch((err) => {
        console.error('Migration failed:');
        console.error(err instanceof Error ? err.stack ?? err.message : err);
        process.exitCode = 1;
    });
}
