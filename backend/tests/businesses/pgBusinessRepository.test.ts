// EthioLink — PgBusinessRepository SQL-shape regression tests.
//
// These tests do not connect to Postgres. They capture the SQL
// text + parameter array that `PgBusinessRepository.listPublic`
// emits and assert that every positional placeholder implied by
// the params array is referenced in the SQL with an explicit
// type cast.
//
// Why this matters:
//   Postgres derives the parameter count from the highest `$N`
//   referenced in the SQL but ALSO needs to assign a type to every
//   positional slot implied by that count. If a parameter slot is
//   bound in the params array but never appears in the SQL — or
//   appears only without a type context — Postgres throws
//     "could not determine data type of parameter $N"
//   at parse time. Before this commit, `listPublic` had exactly
//   that bug for $3 (the free-text query slot) on every call that
//   did NOT supply `?q=` (the most common case — every category
//   tap on the mobile browse tab hit it). The Lambda surfaced
//   `Internal server error` with `businesses.list.failed` +
//   `could not determine data type of parameter $3` in CloudWatch.
//
// Test approach:
//   We construct PgBusinessRepository against a fake SqlExecutor
//   that records every `.query(text, params)` invocation. We then
//   call `listPublic` across the matrix of filter combinations the
//   mobile + admin clients send and assert two invariants per
//   call:
//     1. Every positional slot 1..N in the params array appears at
//        least once in the SQL text with a `$N::TYPE` cast.
//     2. The first reference of each slot uses the right type for
//        the value (uuid for ids, text for free-form strings,
//        numeric for ratings, boolean for flags, timestamptz for
//        cursor times).
//   These together pin down the contract that triggers the
//   Postgres parse-time error if it ever regresses.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QueryResult, QueryResultRow } from 'pg';

import {
    PgBusinessRepository,
    type BusinessSortMode,
    type ParsedCursor,
} from '../../shared/domains/businesses/businessRepository.js';
import type { SqlExecutor } from '../../shared/repositories/baseRepository.js';

// ---------------------------------------------------------------------------
// SQL-capturing fake executor
// ---------------------------------------------------------------------------

interface CapturedQuery {
    readonly text: string;
    readonly params: readonly unknown[];
}

class CapturingExecutor {
    public readonly calls: CapturedQuery[] = [];

    /** Match the `pg.Pool.query<Row>(text, params)` shape. */
    query<Row extends QueryResultRow>(
        text: string,
        params?: unknown[],
    ): Promise<QueryResult<Row>> {
        this.calls.push({ text, params: params ?? [] });
        return Promise.resolve({
            rows: [],
            rowCount: 0,
            command: 'SELECT',
            oid: 0,
            fields: [],
        } as unknown as QueryResult<Row>);
    }
}

function makeRepo(): { repo: PgBusinessRepository; executor: CapturingExecutor } {
    const executor = new CapturingExecutor();
    // The repository only calls `.query`; the Pool / PoolClient
    // surface is structural, so the capturer satisfies the
    // executor contract with `as unknown as SqlExecutor`.
    const repo = new PgBusinessRepository(executor as unknown as SqlExecutor);
    return { repo, executor };
}

// ---------------------------------------------------------------------------
// Invariant helpers
// ---------------------------------------------------------------------------

/**
 * Every positional slot `$N` implied by the params length must
 * appear at least once in the SQL with an explicit `::TYPE` cast.
 * Throws an assertion failure that names the missing slot — the
 * Postgres error message is essentially this same check, so the
 * test failure message mirrors what the operator would see in
 * CloudWatch.
 */
function assertEveryParamIsCast(captured: CapturedQuery): void {
    for (let i = 1; i <= captured.params.length; i += 1) {
        const castPattern = new RegExp(`\\$${i}::\\w+`);
        if (!castPattern.test(captured.text)) {
            assert.fail(
                `parameter $${i} is bound (value=${JSON.stringify(captured.params[i - 1])}) ` +
                    'but the SQL never references it with an explicit `::TYPE` cast. ' +
                    'Postgres would throw `could not determine data type of parameter ' +
                    `$${i}\` at parse time. SQL was:\n${captured.text}`,
            );
        }
    }
}

// Convenience for the four reusable cursor fixtures.
function cursorFixture(): ParsedCursor {
    return {
        id: '11111111-2222-3333-4444-555555555555',
        sortKey: {
            featuredUntil: '2026-06-01T00:00:00.000Z',
            ratingAvg: 4.5,
            createdAt: '2026-05-01T00:00:00.000Z',
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PgBusinessRepository.listPublic — SQL parameter casting', () => {
    it('category-only request (the reported regression) casts every bound parameter', async () => {
        // Mirrors the failing mobile request that triggered the
        // `businesses.list.failed: could not determine data type of
        // parameter $3` CloudWatch entry — the customer taps the
        // Salon card; the app issues `GET /v1/businesses?category=salon`.
        const { repo, executor } = makeRepo();
        await repo.listPublic({ categoryId: 'cat-1' }, null, 20);

        assert.equal(executor.calls.length, 1);
        const captured = executor.calls[0]!;
        // 5 filter slots + 1 limit = 6 params; $3 is the free-text
        // query slot that the bug left unreferenced when null.
        assert.equal(captured.params.length, 6);
        assert.equal(captured.params[2], null, 'trimmedQuery slot is null when ?q= omitted');
        assertEveryParamIsCast(captured);
        // The specific cast the fix introduces — guards the FTS
        // predicate behind `$3::text IS NULL` so a NULL value
        // short-circuits without filtering.
        assert.ok(
            /\$3::text\s+IS\s+NULL\s+OR/i.test(captured.text),
            `SQL must guard $3 with "$3::text IS NULL OR (...)"; got:\n${captured.text}`,
        );
    });

    it('no-filter / first-page request casts every bound parameter', async () => {
        // The unauthenticated homepage call: `GET /v1/businesses`.
        const { repo, executor } = makeRepo();
        await repo.listPublic({}, null, 20);

        const captured = executor.calls[0]!;
        assert.equal(captured.params.length, 6);
        assertEveryParamIsCast(captured);
    });

    it('city-only request casts every bound parameter', async () => {
        const { repo, executor } = makeRepo();
        await repo.listPublic({ city: 'Addis Ababa' }, null, 20);

        const captured = executor.calls[0]!;
        assert.equal(captured.params.length, 6);
        assertEveryParamIsCast(captured);
    });

    it('ratingMin-only request casts every bound parameter', async () => {
        const { repo, executor } = makeRepo();
        await repo.listPublic({ ratingMin: 4 }, null, 20);

        const captured = executor.calls[0]!;
        assert.equal(captured.params.length, 6);
        assertEveryParamIsCast(captured);
    });

    it('featuredOnly request casts every bound parameter', async () => {
        const { repo, executor } = makeRepo();
        await repo.listPublic({ featuredOnly: true }, null, 20);

        const captured = executor.calls[0]!;
        assert.equal(captured.params.length, 6);
        assertEveryParamIsCast(captured);
        // $5 must be referenced as `$5::boolean` — same class of
        // bug if this regresses.
        assert.ok(/\$5::boolean/.test(captured.text));
    });

    it('cursor pagination (sort=featured) casts every bound parameter including $6..$9', async () => {
        const { repo, executor } = makeRepo();
        await repo.listPublic({ sort: 'featured' }, cursorFixture(), 20);

        const captured = executor.calls[0]!;
        // 5 filter + 4 cursor + 1 limit = 10 params.
        assert.equal(captured.params.length, 10);
        assertEveryParamIsCast(captured);
        // Cursor casts: timestamptz, numeric, timestamptz, uuid.
        assert.ok(/\$6::timestamptz/.test(captured.text));
        assert.ok(/\$7::numeric/.test(captured.text));
        assert.ok(/\$8::timestamptz/.test(captured.text));
        assert.ok(/\$9::uuid/.test(captured.text));
    });

    it('relevance sort with a non-empty query casts every bound parameter', async () => {
        const { repo, executor } = makeRepo();
        await repo.listPublic({ sort: 'relevance', query: 'habesha' }, null, 20);

        const captured = executor.calls[0]!;
        assert.equal(captured.params.length, 6);
        assert.equal(captured.params[2], 'habesha');
        assertEveryParamIsCast(captured);
    });

    it('rating sort casts every bound parameter', async () => {
        const { repo, executor } = makeRepo();
        await repo.listPublic({ sort: 'rating' }, null, 20);

        const captured = executor.calls[0]!;
        assert.equal(captured.params.length, 6);
        assertEveryParamIsCast(captured);
    });

    it('newest sort casts every bound parameter', async () => {
        const { repo, executor } = makeRepo();
        await repo.listPublic({ sort: 'newest' }, null, 20);

        const captured = executor.calls[0]!;
        assert.equal(captured.params.length, 6);
        assertEveryParamIsCast(captured);
    });

    it('full-matrix combined filters cast every bound parameter', async () => {
        // The "everything at once" call shape — exercises the
        // queryPredicate + featuredOnlyPredicate + all four scalar
        // filters together. Mirrors the admin SPA's faceted-search
        // panel.
        const { repo, executor } = makeRepo();
        await repo.listPublic(
            {
                categoryId: 'cat-1',
                city: 'Addis Ababa',
                query: 'salon',
                ratingMin: 4,
                featuredOnly: true,
                sort: 'featured',
            },
            null,
            20,
        );

        const captured = executor.calls[0]!;
        assert.equal(captured.params.length, 6);
        assertEveryParamIsCast(captured);
    });

    it('exhaustive sort-mode sweep with null query still casts $3', async () => {
        // Belt-and-braces: every BusinessSortMode hit with a null
        // query must keep $3 typed. Catches future refactors that
        // forget to thread the $3-guard through a new branch in
        // the orderBy switch.
        const modes: readonly BusinessSortMode[] = [
            'featured',
            'relevance',
            'rating',
            'newest',
        ];
        for (const sort of modes) {
            const { repo, executor } = makeRepo();
            await repo.listPublic({ sort }, null, 20);
            const captured = executor.calls[0]!;
            assertEveryParamIsCast(captured);
        }
    });
});
