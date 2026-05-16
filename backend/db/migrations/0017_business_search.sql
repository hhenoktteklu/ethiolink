-- EthioLink — migration 0017: business_profiles full-text search.
--
-- Phase 9 Track 6 — backend full-text search foundation for the
-- customer-side discovery surface. Adds a generated tsvector
-- column to `business_profiles` plus two GIN indexes:
--
--   * `business_profiles_search_tsv_gin` — primary full-text path
--     keyed off the generated `search_tsv` column. Used by the
--     widened `GET /v1/businesses?q=...` filter.
--   * `business_profiles_name_trgm` — trigram index on
--     `lower(name)`, used as a complement when the user types a
--     short prefix that the tsvector path won't index (e.g. "habe"
--     for "Habesha Beauty Lounge"). The repository falls back to
--     `lower(name) ILIKE '%' || q || '%'` against this index when
--     the tsvector query returns zero rows.
--
-- Design notes:
--
--   * `pg_trgm` + `unaccent` ship with stock Postgres 15 — no
--     additional install needed on RDS. The CREATE EXTENSION IF NOT
--     EXISTS statements are idempotent.
--   * The tsvector uses the `simple` dictionary, not `english`. The
--     `english` config stems aggressively (`barber` → `barb`) which
--     hurts brand-name matches. `simple` is just-lowercase +
--     word-split, which fits a marketplace-name corpus better. A
--     custom config (or a switch to `english`) is a future commit
--     after we have real query data.
--   * `unaccent()` so "café" matches "cafe" and Amharic diacritics
--     normalize. `unaccent` is also a Postgres extension; the
--     migration enables it before the column references it.
--   * `setweight()` assigns weight `'A'` to the name and `'B'` to
--     each description field — `ts_rank()` orders name matches
--     above description matches when the user's query hits both.
--   * `STORED` generated column (not `VIRTUAL`) so the GIN index
--     materializes once per row update, not per query. Postgres
--     12+ supports this; the existing schema is on 15.6 (see
--     `AWS_DEPLOYMENT.md` § RDS).
--   * The migration populates the generated column for every
--     existing row automatically as part of the apply transaction
--     — no backfill step required, no temporary disk impact at
--     MVP scale (<100 rows).
--   * No `description.am` fallback to `description.en` when am is
--     missing — the tsvector concatenates both, and a missing key
--     resolves to the empty string via `coalesce(... ->> 'am',
--     '')`. So a row with only `{en: "Hair braiding"}` indexes
--     "Hair braiding" once under weight B; a bilingual row indexes
--     both branches.

BEGIN;

-- Extensions. `IF NOT EXISTS` keeps this idempotent for operators
-- who pre-installed either extension in a different env.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- The `unaccent` function is not IMMUTABLE by default (it loads
-- its dictionary at runtime), which prevents using it inside a
-- generated column expression. The standard workaround is a
-- wrapper function marked IMMUTABLE so Postgres can persist the
-- generated value. The wrapper is owned by the same migration so
-- future env restores from snapshot get it for free.
CREATE OR REPLACE FUNCTION ethiolink_unaccent_immutable(text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    STRICT
AS $$
    SELECT public.unaccent('public.unaccent', $1);
$$;

ALTER TABLE business_profiles
    ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (
        setweight(
            to_tsvector(
                'simple',
                ethiolink_unaccent_immutable(coalesce(name, ''))
            ),
            'A'
        )
        ||
        setweight(
            to_tsvector(
                'simple',
                ethiolink_unaccent_immutable(coalesce(description ->> 'en', ''))
            ),
            'B'
        )
        ||
        setweight(
            to_tsvector(
                'simple',
                ethiolink_unaccent_immutable(coalesce(description ->> 'am', ''))
            ),
            'B'
        )
    ) STORED;

-- Primary full-text index. The GIN index supports
-- `search_tsv @@ websearch_to_tsquery(...)` lookups and
-- `ts_rank()` ordering.
CREATE INDEX business_profiles_search_tsv_gin
    ON business_profiles USING gin (search_tsv);

-- Trigram fallback index on `lower(name)`. Used for prefix-style
-- matches the tsvector path won't catch (short prefixes like
-- "habe"). The repository's SQL uses both paths: tsvector first
-- (high-quality matches), trgm fallback when tsvector returns
-- zero rows.
CREATE INDEX business_profiles_name_trgm
    ON business_profiles USING gin (lower(name) gin_trgm_ops);

COMMIT;
