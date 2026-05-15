// EthioLink — Lambda handler for one-shot database migration.
//
// Manually invoked. NOT triggered by EventBridge, NOT wired to
// API Gateway. The operator runs:
//
//   aws lambda invoke \
//       --function-name ethiolink-${env}-maintenance-db-migrate \
//       /tmp/response.json
//
// after every Terraform apply that lands a new migration file.
// The function:
//
//   1. Resolves the RDS master credentials via `loadSecretsThenConfig`.
//   2. Opens a single `pg.Client` against the DIRECT RDS endpoint
//      (`PG_HOST` is overridden by the Terraform Lambda module to
//      bypass the proxy — proxy prepared-statement caching
//      interferes with DDL).
//   3. Calls `runMigrations` from `backend/db/migrate.mjs`. The
//      same function backs the local `npm run db:migrate` CLI, so
//      laptop + Lambda apply the exact same files in the exact
//      same order.
//   4. Returns the `{ applied, skipped, failed }` summary as the
//      Lambda response.
//
// Why a Lambda instead of an ECS task or a manual `psql` from a
// bastion:
//   * The Lambda already has VPC + SG + Secrets Manager access
//     wired by the existing infra; no separate IAM role / task
//     definition / ECS cluster work.
//   * Cold-start + apply for the 13 MVP migrations is ~10 seconds
//     — well inside the configured 5-minute timeout.
//   * Migrations are idempotent (the `schema_migrations` ledger
//     skips already-applied files), so accidental re-invocation
//     is safe.
//
// Migration files location in the deployment zip:
//   `backend/scripts/package.sh` copies `backend/db/` into
//   `dist/db/` so the zip layout becomes:
//     /var/task/
//       lambdas/maintenance/dbMigrate.js
//       db/
//         migrate.mjs
//         migrations/0001_...sql .. 0013_...sql
//   The runner's default `migrationsDir` resolves relative to its
//   own location, so it finds `/var/task/db/migrations/`
//   automatically.

import { Client } from 'pg';

import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { createLogger } from '../../shared/logging/logger.js';

import { runMigrations, type MigrationRunResult } from '../../db/migrate.mjs';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });

export interface MigrationLambdaResponse {
    readonly applied: readonly string[];
    readonly skipped: readonly string[];
    readonly failed: readonly { filename: string; error: string }[];
    readonly status: 'success' | 'partial_failure';
    readonly target: string;
}

/**
 * Lambda entry. Returns the migration summary directly — no HTTP
 * envelope because this function isn't reachable via API Gateway.
 */
export const handler = async (): Promise<MigrationLambdaResponse> => {
    const logger = baseLogger.child({
        handler: 'maintenance.dbMigrate',
    });

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
    logger.info('Connecting to database.', { target });
    await client.connect();

    let summary: MigrationRunResult;
    try {
        summary = await runMigrations({
            client,
            log: (line) => logger.info('migration', { line }),
        });
    } finally {
        await client.end();
    }

    const status = summary.failed.length > 0 ? 'partial_failure' : 'success';
    logger.info('Migration run complete.', {
        status,
        applied: summary.applied.length,
        skipped: summary.skipped.length,
        failed: summary.failed.length,
    });

    return Object.freeze<MigrationLambdaResponse>({
        applied: summary.applied,
        skipped: summary.skipped,
        failed: summary.failed,
        status,
        target,
    });
};
