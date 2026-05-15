// EthioLink — TypeScript declarations for `migrate.mjs`.
//
// The runner itself is JavaScript (it's also imported by the
// local `node db/migrate.mjs` CLI which has no TS step); this
// `.d.mts` lets the Lambda consume it from `dbMigrate.ts` with
// proper type safety.

import type { Client } from 'pg';

export interface MigrationFailure {
    readonly filename: string;
    readonly error: string;
}

export interface MigrationRunResult {
    /** Filenames the runner successfully applied during this run. */
    readonly applied: readonly string[];
    /** Filenames the runner skipped because they were already
     *  recorded in `schema_migrations`. */
    readonly skipped: readonly string[];
    /** Filenames whose application threw, plus the error message.
     *  The runner stops on the first failure, so this array has
     *  length 0 or 1 in practice. */
    readonly failed: readonly MigrationFailure[];
}

export interface RunMigrationsOptions {
    /** Connected `pg.Client`. The runner does NOT close it; the
     *  caller is responsible for the lifecycle. */
    readonly client: Client;
    /** Directory holding the `.sql` files. Defaults to the
     *  runner's sibling `migrations/` directory. */
    readonly migrationsDir?: string;
    /** Per-line logger. Defaults to `console.log`. The Lambda
     *  injects its structured logger. */
    readonly log?: (line: string) => void;
}

/**
 * Apply every pending migration in `migrationsDir` in lexicographic
 * order against `client`. Returns a summary of applied / skipped /
 * failed filenames.
 *
 * Per-file BEGIN/COMMIT is the migration file's responsibility.
 * The runner stops on the first failure so a partial-apply doesn't
 * cascade.
 */
export function runMigrations(
    options: RunMigrationsOptions,
): Promise<MigrationRunResult>;
