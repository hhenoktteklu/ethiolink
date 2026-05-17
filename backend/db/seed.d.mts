// EthioLink — TypeScript declarations for `seed.mjs`.
//
// The runner itself is JavaScript (it's also imported by the
// local `node db/seed.mjs` CLI which has no TS step); this
// `.d.mts` lets the maintenance Lambda consume it from
// `dbMigrate.ts` with proper type safety.

import type { Client } from 'pg';

export interface SeedFailure {
    readonly filename: string;
    readonly error: string;
}

export interface SeedRunResult {
    /** Filenames the runner successfully applied during this run. */
    readonly applied: readonly string[];
    /** Filenames the runner skipped because they were already
     *  recorded in `schema_seeds`. */
    readonly skipped: readonly string[];
    /** Filenames whose application threw, plus the error message.
     *  The runner stops on the first failure, so this array has
     *  length 0 or 1 in practice. */
    readonly failed: readonly SeedFailure[];
}

export interface RunSeedsOptions {
    /** Connected `pg.Client`. The runner does NOT close it; the
     *  caller is responsible for the lifecycle. */
    readonly client: Client;
    /** Directory holding the `.sql` files. Defaults to the
     *  runner's sibling `seeds/` directory. */
    readonly seedsDir?: string;
    /** Per-line logger. Defaults to `console.log`. The Lambda
     *  injects its structured logger. */
    readonly log?: (line: string) => void;
}

/**
 * Apply every pending seed in `seedsDir` in lexicographic order
 * against `client`. Returns a summary of applied / skipped /
 * failed filenames.
 *
 * Per-file BEGIN/COMMIT is the seed file's responsibility. The
 * runner stops on the first failure so a partial-apply doesn't
 * cascade.
 */
export function runSeeds(
    options: RunSeedsOptions,
): Promise<SeedRunResult>;
