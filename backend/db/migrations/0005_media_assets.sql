-- EthioLink — migration 0005: media_assets table.
--
-- Generic media storage. Each row points at exactly one S3 object via
-- `s3_key` and belongs to exactly one logical owner — currently one of
-- BUSINESS, STAFF, or USER. The owner reference is intentionally a
-- *logical* foreign key (not declared at the DB level) because the
-- referenced table varies with `owner_type`. The owning service
-- (business / staff / user) is responsible for asserting the target row
-- exists before inserting a media_assets row.
--
-- See docs/architecture/DATABASE_SCHEMA.md "media_assets" for the
-- canonical column spec.
--
-- Design notes:
--   * No `updated_at` column, and therefore no `set_updated_at` trigger.
--     The schema doc's "media_assets" table deliberately omits
--     `updated_at` — media rows are append-only. Replacing a photo
--     means inserting a new row and soft-deleting the old via
--     `deleted_at`, not mutating the original.
--   * `deleted_at` is the soft-delete column. Production listing queries
--     filter on `deleted_at IS NULL`. The schema doc explicitly lists
--     `media_assets` as one of the tables that uses soft-delete (along
--     with `appointments` and `reviews`) because S3 cleanup runs out of
--     band and we need to retain the row until the object is gone.
--   * `s3_key` is `UNIQUE` so a successful confirm endpoint cannot
--     register the same object twice.
--   * No indexes are declared at this migration because the schema doc
--     does not list any for `media_assets`. The likely dominant access
--     pattern is `(owner_type, owner_id, deleted_at IS NULL)`; add an
--     index in a follow-up migration once measurements show the need.

BEGIN;

CREATE TABLE media_assets (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_type   text        NOT NULL
        CHECK (owner_type IN ('BUSINESS', 'STAFF', 'USER')),
    owner_id     uuid        NOT NULL,
    s3_key       text        NOT NULL UNIQUE,
    content_type text,
    width        int,
    height       int,
    is_public    bool        NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz
);

COMMIT;
