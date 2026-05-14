-- EthioLink — migration 0004: business_profiles table.
--
-- The core marketplace entity. One row per business listed on EthioLink.
-- Owned by exactly one user (BUSINESS_OWNER role) and classified by
-- exactly one category. Moves through a five-state status machine:
--
--     DRAFT → PENDING_REVIEW → APPROVED → SUSPENDED
--                            ↘ REJECTED
--
-- See docs/architecture/DATABASE_SCHEMA.md "business_profiles" for the
-- canonical column spec.
--
-- Design notes:
--   * `name` is plain text (not JSONB). Business names are proper nouns
--     and do not localize. `description` is JSONB keyed by language
--     ({"en": "..."}) for the same reason `business_categories.name` is.
--   * Only `owner_user_id`, `category_id`, and `status` are NOT NULL at
--     the schema level. The other "required-before-submit" fields (name,
--     description, city, ...) are enforced by `businessService` when an
--     owner transitions DRAFT → PENDING_REVIEW. This lets owners persist
--     a half-filled DRAFT without the database getting in their way.
--   * `rating_avg` / `rating_count` are denormalized counters maintained
--     by the review service (Phase 4). They default to 0/0 so `ratingMin`
--     filter queries don't need NULL handling on fresh businesses.
--   * Foreign keys use ON DELETE RESTRICT — a category or owning user
--     cannot be hard-deleted while a business still references them.
--     The app suspends or transfers first.
--   * Indexes mirror the schema doc exactly: (status), (category_id,
--     status), (city, status). A GIN index on `description` for
--     full-text search is explicitly deferred. An index on
--     `owner_user_id` may be useful for `GET /v1/me/business`; defer
--     until measurements warrant it (no `SELECT *` heavy queries
--     planned for Phase 2's owner lookups).
--   * Reuses the `set_updated_at()` trigger function defined in 0002.

BEGIN;

CREATE TABLE business_profiles (
    id              uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id   uuid             NOT NULL
        REFERENCES users (id) ON DELETE RESTRICT,
    category_id     uuid             NOT NULL
        REFERENCES business_categories (id) ON DELETE RESTRICT,
    name            text,
    description     jsonb,
    city            text,
    address_line    text,
    latitude        double precision,
    longitude       double precision,
    phone           text,
    telegram_handle text,
    whatsapp_phone  text,
    status          text             NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED')),
    featured_until  timestamptz,
    rating_avg      numeric(3,2)     NOT NULL DEFAULT 0,
    rating_count    int              NOT NULL DEFAULT 0,
    created_at      timestamptz      NOT NULL DEFAULT now(),
    updated_at      timestamptz      NOT NULL DEFAULT now()
);

CREATE INDEX business_profiles_status_idx
    ON business_profiles (status);

CREATE INDEX business_profiles_category_status_idx
    ON business_profiles (category_id, status);

CREATE INDEX business_profiles_city_status_idx
    ON business_profiles (city, status);

CREATE TRIGGER business_profiles_set_updated_at
BEFORE UPDATE ON business_profiles
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
