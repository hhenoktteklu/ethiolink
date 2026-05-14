// EthioLink — base repository.
//
// All domain repositories (`UserRepository`, `BusinessRepository`, ...)
// extend this class. It hides the small bits of pg ceremony — typed
// `QueryResult`, the difference between zero/one/many rows, parameterized
// queries — so the subclasses can stay narrow and SQL-focused.
//
// A repository is constructed with an `Executor`, which is either a `Pool`
// (one query per call) or a `PoolClient` (multiple queries in a single
// transaction). Callers that need a transaction use `withTransaction` from
// `pgClient.ts` and pass the bound client into a fresh repository instance.

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Anything that can execute a parameterized SQL query. */
export type SqlExecutor = Pool | PoolClient;

/** Raised when `one()` finds zero rows or `oneOrNone()` finds more than one. */
export class RepositoryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RepositoryError';
    }
}

export abstract class BaseRepository {
    constructor(protected readonly db: SqlExecutor) {}

    /** Run a parameterized query and return the raw pg `QueryResult`. */
    protected async query<Row extends QueryResultRow>(
        text: string,
        params?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
        return this.db.query<Row>(text, params ? [...params] : undefined);
    }

    /**
     * Run a query that is expected to return exactly one row. Throws
     * `RepositoryError` if it returns zero rows. Multiple rows are tolerated
     * (first row wins) so that an aggregate-with-LIMIT-1 query can use this
     * helper too.
     */
    protected async one<Row extends QueryResultRow>(
        text: string,
        params?: readonly unknown[],
    ): Promise<Row> {
        const { rows } = await this.query<Row>(text, params);
        const row = rows[0];
        if (row === undefined) {
            throw new RepositoryError('Expected one row, got zero.');
        }
        return row;
    }

    /**
     * Run a query that is expected to return zero or one row. Throws
     * `RepositoryError` if it returns more than one.
     */
    protected async oneOrNone<Row extends QueryResultRow>(
        text: string,
        params?: readonly unknown[],
    ): Promise<Row | null> {
        const { rows } = await this.query<Row>(text, params);
        if (rows.length > 1) {
            throw new RepositoryError(`Expected at most one row, got ${rows.length}.`);
        }
        return rows[0] ?? null;
    }

    /** Run a query and return all rows (possibly empty). */
    protected async many<Row extends QueryResultRow>(
        text: string,
        params?: readonly unknown[],
    ): Promise<Row[]> {
        const { rows } = await this.query<Row>(text, params);
        return rows;
    }

    /** Run a statement and discard the result set. Returns rows affected. */
    protected async execute(
        text: string,
        params?: readonly unknown[],
    ): Promise<number> {
        const result = await this.query(text, params);
        return result.rowCount ?? 0;
    }
}
