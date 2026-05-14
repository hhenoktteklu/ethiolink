-- EthioLink — migration 0006: services table.
--
-- A business publishes its bookable inventory as `services`. Each row
-- captures one offering — name, optional description, duration, optional
-- price. Bookings in Phase 4 reference a service to snapshot duration and
-- price at booking time.
--
-- See docs/architecture/DATABASE_SCHEMA.md "services" for the canonical
-- column spec.
--
-- Design notes:
--   * `name` is JSONB keyed by language ({"en": "..."}). MVP writes only
--     `en`; the column is JSONB so we can add Amharic later without a
--     schema change. Required (a service without a name is meaningless).
--   * `description` is JSONB nullable. Owners may publish a service
--     without a description; the API surfaces null cleanly.
--   * `duration_minutes` is required and must be positive — booking math
--     in Phase 4 divides by it, and zero or negative durations would
--     poison slot computation.
--   * `price_etb` is nullable: owners may publish a service whose price is
--     "ask for a quote" / set at the chair. Service-layer code in Phase 4
--     can decide how to surface that to customers.
--   * `is_active` is the soft-delete flag. DELETE in the API spec is a
--     deactivation, not a row removal — historical bookings still
--     reference the service via `appointments.service_id ON DELETE
--     RESTRICT`, so hard delete would orphan them.
--   * `business_id` has `ON DELETE CASCADE`: when a business is hard
--     deleted, all its services go with it. This is consistent with
--     `business_profiles` retention model — admin SUSPEND, not delete,
--     for ongoing businesses.
--   * Reuses the `set_updated_at()` trigger function defined in migration
--     0002.
--   * Index on `(business_id, is_active)` powers the dominant query path
--     for the public `GET /v1/businesses/:businessId/services` listing,
--     which always filters by both columns.

BEGIN;

CREATE TABLE services (
    id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid          NOT NULL
        REFERENCES business_profiles (id) ON DELETE CASCADE,
    name             jsonb         NOT NULL,
    description      jsonb,
    duration_minutes int           NOT NULL
        CHECK (duration_minutes > 0),
    price_etb        numeric(12,2),
    is_active        bool          NOT NULL DEFAULT true,
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX services_business_active_idx
    ON services (business_id, is_active);

CREATE TRIGGER services_set_updated_at
BEFORE UPDATE ON services
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
