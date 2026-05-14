-- EthioLink — migration 0007: staff_members table.
--
-- A business's bookable staff — stylists, barbers, therapists, etc. Each
-- staff member belongs to exactly one business and has their own
-- availability schedule (migration 0008). Phase 4 appointments reference
-- staff so customers can pick a specific person.
--
-- See docs/architecture/DATABASE_SCHEMA.md "staff_members" for the
-- canonical column spec.
--
-- Design notes:
--   * `display_name` is plain text (not JSONB). Personal names are proper
--     nouns and do not localize — same reasoning as `business_profiles.name`.
--     Required: a staff entry without a name is meaningless to customers.
--   * `role` is free-text and nullable. Owners may write "Senior Stylist",
--     "Barber", "Therapist (Junior)" — anything. We deliberately do not
--     constrain to an enum; salon role taxonomies vary too much across
--     subcategories to enumerate in MVP.
--   * `is_active` is the soft-delete flag. DELETE in the API spec is a
--     deactivation, not row removal — historical bookings still reference
--     the staff member via `appointments.staff_id ON DELETE RESTRICT`,
--     and hard delete would orphan them.
--   * `business_id` has `ON DELETE CASCADE`: when a business is hard
--     deleted, its staff and (via the next migration's CASCADE)
--     availability rows go with it.
--   * Reuses the `set_updated_at()` trigger function defined in migration
--     0002.
--   * Index on `(business_id, is_active)` powers the dominant query path
--     for the public `GET /v1/businesses/:businessId/staff` listing,
--     which always filters by both columns.

BEGIN;

CREATE TABLE staff_members (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid        NOT NULL
        REFERENCES business_profiles (id) ON DELETE CASCADE,
    display_name text        NOT NULL,
    role         text,
    is_active    bool        NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX staff_members_business_active_idx
    ON staff_members (business_id, is_active);

CREATE TRIGGER staff_members_set_updated_at
BEFORE UPDATE ON staff_members
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
