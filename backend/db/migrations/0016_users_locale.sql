-- EthioLink — migration 0016: users.locale.
--
-- Phase 9 Track 5 foundation. Stores each user's preferred UI +
-- notification locale. MVP supports two values: `'en'` (English,
-- the default) and `'am'` (Amharic). The CHECK constraint keeps
-- the column narrow; adding a new locale is a future migration
-- that widens the CHECK list + ships the matching ARB bundles +
-- notification-template renderers.
--
-- Design notes:
--   * `NOT NULL DEFAULT 'en'`. Every existing row is backfilled
--     to `'en'` automatically as part of the migration's apply
--     transaction — no data is moved, the column default handles
--     it. Existing UI + notification behaviour stays exactly as
--     before until the user opts in via `PATCH /v1/me`.
--   * No index. Cardinality is at most two for MVP and never used
--     as a query predicate worth indexing.
--   * Per-language column rather than a JSONB `preferences`
--     blob. Single locale fits on the row cleanly, joins +
--     conditional updates stay trivial. The `preferences` envelope
--     can be introduced via a later migration if/when the second
--     preference field arrives.

BEGIN;

ALTER TABLE users
    ADD COLUMN locale text NOT NULL DEFAULT 'en'
        CHECK (locale IN ('en', 'am'));

COMMIT;
