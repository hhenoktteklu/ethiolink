// EthioLink — local migration runner.
//
// Scope: developer laptops and CI. Applies every `.sql` file in
// `backend/db/migrations/` in lexicographic order, exactly once, tracking
// which have already been applied in a `schema_migrations` table the runner
// owns. Files are immutable once applied — change schema with a new
// migration, never by editing an old one.
//
// Production NOT in scope. AWS deployments will run migrations through a
// dedicated tool (or a one-shot Lambda) wired up later; this script is
// strictly the local-dev `npm run db:migrate` path.
//
// Defaults match docker-compose.yml, so a fresh `docker-compose up -d`
// followed by `npm run db:migrate` works with no env configuration. Override
// any connection parameter by exporting the matching `PG_*` variable.
//
// Failure model:
//   * Each migration file is expected to manage its own transaction with
//     BEGIN/COMMIT (see existing 0001/0002 for the pattern).
//   * If a migration fails, the file's COMMIT rolls back; the runner skips
//     the schema_migrations INSERT and exits non-zero. Re-running picks up
//     where it left off.
//   * If the file succeeds but the post-INSERT fails (e.g., network blip),
//     the next run will try to re-apply and stop on the migration. Rare in
//     practice; manual recovery: insert the filename into schema_migrations
//     by hand and re-run.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

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

async function ensureMigrationsTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename    text        PRIMARY KEY,
            applied_at  timestamptz NOT NULL DEFAULT now()
        );
    `);
}

async function listMigrationFiles() {
    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
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

async function applyMigration(client, filename) {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    // Each migration owns its own BEGIN/COMMIT.
    await client.query(sql);
    // Record only after the migration's own transaction has committed.
    await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
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
        await ensureMigrationsTable(client);
        const files = await listMigrationFiles();
        if (files.length === 0) {
            console.log('No migration files found.');
            return;
        }
        const applied = await listAppliedFilenames(client);

        for (const file of files) {
            if (applied.has(file)) {
                console.log(`[skip]  ${file}`);
                continue;
            }
            process.stdout.write(`[apply] ${file} ... `);
            await applyMigration(client, file);
            console.log('ok');
            appliedCount += 1;
        }
    } finally {
        await client.end();
    }

    if (appliedCount === 0) {
        console.log('Schema is up to date.');
    } else {
        console.log(`Applied ${appliedCount} migration(s).`);
    }
}

main().catch((err) => {
    console.error('Migration failed:');
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
});
