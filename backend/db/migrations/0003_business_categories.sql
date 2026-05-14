-- EthioLink — migration 0003: business_categories table.
--
-- Marketplace categories. Beauty-only in MVP; the four canonical entries
-- live in backend/db/seeds/0001_categories.sql (Salon, Barber, Spa,
-- Beauty Professional). See docs/architecture/DATABASE_SCHEMA.md
-- "business_categories" for the canonical column spec.
--
-- Design notes:
--   * `slug` is the stable machine-friendly key (e.g. 'salon') used by
--     filters, deep links, and admin tooling. It is the only externally
--     visible identifier callers must memorize; `id` stays internal.
--   * `name` is JSONB keyed by language ({"en": "..."}). MVP writes only
--     `en`; the column is JSONB so we can add Amharic later without a
--     schema change.
--   * `is_active = false` hides the category from public listings without
--     deleting it — preserving historical relationships if any business
--     ever references this category.
--   * `set_updated_at()` was defined in migration 0002. Re-used here for
--     the standard `updated_at` bump on UPDATE.

BEGIN;

CREATE TABLE business_categories (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text        NOT NULL UNIQUE,
    name        jsonb       NOT NULL,
    sort_order  int         NOT NULL DEFAULT 0,
    is_active   bool        NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER business_categories_set_updated_at
BEFORE UPDATE ON business_categories
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
