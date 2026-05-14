-- EthioLink — migration 0010: reviews table.
--
-- Customer-authored ratings + free-text comments on a completed
-- appointment. One review per appointment, enforced at the DB level
-- by a UNIQUE on `appointment_id`.
--
-- See docs/architecture/DATABASE_SCHEMA.md "reviews" for the canonical
-- column spec.
--
-- Design notes:
--   * **One review per appointment** is enforced by the UNIQUE
--     constraint on `appointment_id`. A second `POST
--     /v1/appointments/:id/review` from the same customer hits a
--     `unique_violation` (SQLSTATE 23505) which the application layer
--     translates to a `CONFLICT`. The service layer still does a
--     pre-check for a nicer error path; the UNIQUE is the
--     belt-and-braces guarantee against races.
--
--   * **`appointment_id` ON DELETE RESTRICT** matches the appointments
--     side (`appointments` is itself soft-deleted, never hard-deleted
--     in normal flows). A future compensating migration that drops
--     `appointments` must drop `reviews` first — documented in
--     PHASE_4_BOOKING.md rollback notes.
--
--   * **`customer_id` and `business_id`** are denormalized from the
--     parent appointment. Strictly redundant — both are reachable
--     through `appointment_id` — but the denormalization lets
--     `GET /v1/businesses/:id/reviews` and "my reviews" listings index
--     directly without joining to `appointments`. The booking service
--     copies these from the appointment at review-insertion time;
--     they cannot drift because appointments are immutable in those
--     two columns once created.
--
--   * **`rating` is a small int with a CHECK 1..5**. Storing as `int`
--     (not `numeric`) keeps the column 4 bytes wide and the CHECK
--     keeps bad payloads out of the table. Half-stars are intentionally
--     not supported.
--
--   * **`comment` is nullable** — a rating without a comment is a
--     valid review. The application layer trims and length-limits the
--     comment before insert; that policy is not encoded at the DB
--     level (consistent with how `notes` on appointments is handled).
--
--   * **Denormalized `rating_avg` / `rating_count` on
--     `business_profiles`** are updated in the application layer, not
--     by a database trigger. The booking service recomputes
--     `(SUM(rating)::numeric / COUNT(*), COUNT(*))` for the affected
--     business inside the same transaction as the review insert.
--     Keeping the recompute in app code keeps the migration
--     trigger-free and makes the rebuild path easy (a one-shot
--     re-aggregation job rather than a database function to maintain).
--
--   * **Soft-delete via `deleted_at`** per the project convention for
--     retention-required tables (see DATABASE_SCHEMA.md "Conventions").
--     Listing endpoints filter `WHERE deleted_at IS NULL`. Admin
--     moderation flows flip `deleted_at` to hide an abusive review
--     without losing the underlying row.
--
--   * **Indexes**: the schema doc does not enumerate review indexes
--     beyond the implicit UNIQUE on `appointment_id`. Two are added
--     here to back the documented read paths:
--     - `(business_id, created_at DESC)` for
--       `GET /v1/businesses/:id/reviews`, which returns newest-first.
--     - `(customer_id, created_at DESC)` for a future "my reviews"
--       listing and for admin lookups by customer.
--
--   * Reuses the `set_updated_at()` trigger function defined in
--     migration 0002.

BEGIN;

CREATE TABLE reviews (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id  uuid          NOT NULL UNIQUE
        REFERENCES appointments (id) ON DELETE RESTRICT,
    customer_id     uuid          NOT NULL
        REFERENCES users (id) ON DELETE RESTRICT,
    business_id     uuid          NOT NULL
        REFERENCES business_profiles (id) ON DELETE RESTRICT,
    rating          int           NOT NULL
        CHECK (rating BETWEEN 1 AND 5),
    comment         text,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

CREATE INDEX reviews_business_created_idx
    ON reviews (business_id, created_at DESC);

CREATE INDEX reviews_customer_created_idx
    ON reviews (customer_id, created_at DESC);

CREATE TRIGGER reviews_set_updated_at
BEFORE UPDATE ON reviews
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
