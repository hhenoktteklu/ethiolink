// EthioLink — Lambda handler for one-shot database migration + seed.
//
// Manually invoked. NOT triggered by EventBridge, NOT wired to
// API Gateway. The operator runs:
//
//   # Migrations only (default — backwards compatible).
//   aws lambda invoke \
//       --function-name ethiolink-${env}-maintenance-db-migrate \
//       /tmp/response.json
//
//   # Migrations then seeds, in one shot.
//   aws lambda invoke \
//       --function-name ethiolink-${env}-maintenance-db-migrate \
//       --cli-binary-format raw-in-base64-out \
//       --payload '{"seed":true}' \
//       /tmp/response.json
//
//   # Seeds only (when the schema is already current and you just
//   # want to add the categories / fixtures into a freshly-reset
//   # dev database).
//   aws lambda invoke \
//       --function-name ethiolink-${env}-maintenance-db-migrate \
//       --cli-binary-format raw-in-base64-out \
//       --payload '{"mode":"seed"}' \
//       /tmp/response.json
//
// after every Terraform apply that lands a new migration OR seed
// file. The function:
//
//   1. Resolves the RDS master credentials via `loadSecretsThenConfig`.
//   2. Opens a single `pg.Client` against the DIRECT RDS endpoint
//      (`PG_HOST` is overridden by the Terraform Lambda module to
//      bypass the proxy — proxy prepared-statement caching
//      interferes with DDL).
//   3. Calls `runMigrations` and/or `runSeeds` from
//      `backend/db/migrate.mjs` + `backend/db/seed.mjs`. Same code
//      paths back the local `npm run db:migrate` / `npm run db:seed`
//      CLIs, so laptop + Lambda apply the exact same files in the
//      exact same order.
//   4. Returns a `{ migrations, seeds, status, target, mode }`
//      summary as the Lambda response.
//
// Why a Lambda instead of an ECS task or a manual `psql` from a
// bastion:
//   * The Lambda already has VPC + SG + Secrets Manager access
//     wired by the existing infra; no separate IAM role / task
//     definition / ECS cluster work.
//   * Cold-start + apply for the 13 MVP migrations + the 1 seed
//     file is ~10 seconds — well inside the configured 5-minute
//     timeout.
//   * Migrations + seeds are both idempotent (the `schema_migrations`
//     and `schema_seeds` ledgers skip already-applied files), so
//     accidental re-invocation is safe.
//
// Migration + seed file locations in the deployment zip:
//   `backend/scripts/package.sh` copies `backend/db/` into
//   `dist/db/` so the zip layout becomes:
//     /var/task/
//       lambdas/maintenance/dbMigrate.js
//       db/
//         migrate.mjs
//         seed.mjs
//         migrations/0001_...sql .. 0017_...sql
//         seeds/0001_categories.sql
//   Each runner's default directory resolves relative to its own
//   location, so they find `/var/task/db/migrations/` and
//   `/var/task/db/seeds/` automatically.

import { Client } from 'pg';

import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { createLogger } from '../../shared/logging/logger.js';

import { runMigrations, type MigrationRunResult } from '../../db/migrate.mjs';
import { runSeeds, type SeedRunResult } from '../../db/seed.mjs';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });

/**
 * Lambda event shape. Both fields are optional. Default behavior
 * (empty payload) runs migrations only — preserves the pre-Phase-10
 * contract.
 */
export interface MigrationLambdaEvent {
    /**
     * When `true`, run migrations FIRST, then run seeds. Equivalent
     * to `mode: "migrate-and-seed"`. Ignored if `mode` is set.
     */
    readonly seed?: boolean;
    /**
     * Explicit run mode.
     *   * `"migrate"` (default) — migrations only, no seeds.
     *   * `"seed"` — seeds only, no migrations.
     *   * `"migrate-and-seed"` — both, in order.
     */
    readonly mode?: 'migrate' | 'seed' | 'migrate-and-seed';
}

export interface MigrationLambdaResponse {
    /** Echo of the resolved run mode (after applying the `seed` shortcut). */
    readonly mode: 'migrate' | 'seed' | 'migrate-and-seed';
    /** `"success"` iff every section the operator asked for finished without a failure. */
    readonly status: 'success' | 'partial_failure';
    /** Stable `user@host:port/database` string for log correlation. */
    readonly target: string;
    /**
     * Migration section result. `null` when `mode === "seed"` because
     * the runner was not asked to touch the migrations ledger.
     */
    readonly migrations: SectionSummary | null;
    /**
     * Seed section result. `null` when `mode === "migrate"`.
     */
    readonly seeds: SectionSummary | null;
}

interface SectionSummary {
    readonly applied: readonly string[];
    readonly skipped: readonly string[];
    readonly failed: readonly { filename: string; error: string }[];
}

/**
 * Resolve the requested run mode from the event. `mode` wins over
 * `seed` when both are set; `seed: true` is shorthand for
 * `"migrate-and-seed"`; everything else falls back to
 * `"migrate"` (the pre-Phase-10 default).
 */
function resolveMode(event: MigrationLambdaEvent): MigrationLambdaResponse['mode'] {
    if (event.mode === 'migrate' || event.mode === 'seed' || event.mode === 'migrate-and-seed') {
        return event.mode;
    }
    if (event.seed === true) {
        return 'migrate-and-seed';
    }
    return 'migrate';
}

/**
 * Lambda entry. Returns the migration + seed summary directly —
 * no HTTP envelope because this function isn't reachable via API
 * Gateway.
 */
export const handler = async (
    event: MigrationLambdaEvent = {},
): Promise<MigrationLambdaResponse> => {
    const logger = baseLogger.child({
        handler: 'maintenance.dbMigrate',
    });

    const mode = resolveMode(event);

    const client = new Client({
        host: config.pg.host,
        port: config.pg.port,
        database: config.pg.database,
        user: config.pg.user,
        password: config.pg.password,
        // RDS requires TLS; `loadConfig` already coerces `PG_SSL = "true"`.
        // Use `rejectUnauthorized: false` because AWS's default RDS
        // certificate is signed by an AWS CA the `pg` driver doesn't
        // bundle. A future hardening step is to load the AWS RDS CA
        // bundle explicitly — Phase 8 concern.
        ssl: config.pg.ssl ? { rejectUnauthorized: false } : false,
    });

    const target = `${config.pg.user}@${config.pg.host}:${config.pg.port}/${config.pg.database}`;
    logger.info('Connecting to database.', { target, mode });
    await client.connect();

    let migrationsResult: MigrationRunResult | null = null;
    let seedsResult: SeedRunResult | null = null;

    try {
        if (mode === 'migrate' || mode === 'migrate-and-seed') {
            migrationsResult = await runMigrations({
                client,
                log: (line) => logger.info('migration', { line }),
            });
        }

        // Run seeds only when:
        //   * the operator asked for them (mode includes seeds), AND
        //   * the migrations section had no failures (when
        //     applicable). Applying seed data on top of a partially-
        //     migrated schema would compound the failure surface;
        //     better to fix the migration, re-run, and let the seeds
        //     follow on the green retry.
        const skipSeedsAfterMigrationFailure =
            mode === 'migrate-and-seed' &&
            migrationsResult !== null &&
            migrationsResult.failed.length > 0;

        if (
            (mode === 'seed' || mode === 'migrate-and-seed') &&
            !skipSeedsAfterMigrationFailure
        ) {
            seedsResult = await runSeeds({
                client,
                log: (line) => logger.info('seed', { line }),
            });
        }
    } finally {
        await client.end();
    }

    const migrationFailedCount = migrationsResult?.failed.length ?? 0;
    const seedFailedCount = seedsResult?.failed.length ?? 0;
    const status: MigrationLambdaResponse['status'] =
        migrationFailedCount + seedFailedCount > 0 ? 'partial_failure' : 'success';

    logger.info('Run complete.', {
        mode,
        status,
        migrations_applied: migrationsResult?.applied.length ?? null,
        migrations_skipped: migrationsResult?.skipped.length ?? null,
        migrations_failed: migrationFailedCount,
        seeds_applied: seedsResult?.applied.length ?? null,
        seeds_skipped: seedsResult?.skipped.length ?? null,
        seeds_failed: seedFailedCount,
    });

    return Object.freeze<MigrationLambdaResponse>({
        mode,
        status,
        target,
        migrations: migrationsResult === null
            ? null
            : Object.freeze({
                applied: migrationsResult.applied,
                skipped: migrationsResult.skipped,
                failed: migrationsResult.failed,
            }),
        seeds: seedsResult === null
            ? null
            : Object.freeze({
                applied: seedsResult.applied,
                skipped: seedsResult.skipped,
                failed: seedsResult.failed,
            }),
    });
};
