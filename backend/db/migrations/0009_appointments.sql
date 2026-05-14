-- EthioLink — migration 0009: appointments table.
--
-- The booking record. One row per customer reservation against a
-- specific service + staff + time. Status transitions through the
-- six-state machine documented in PHASE_4_BOOKING.md:
--
--     REQUESTED ─→ ACCEPTED ─→ COMPLETED
--         │           │
--         ├──→ REJECTED (by business)
--         ├──→ CANCELLED (by customer / business / admin)
--         └──→ NO_SHOW   (reserved; no public endpoint in Phase 4)
--
-- See docs/architecture/DATABASE_SCHEMA.md "appointments" for the
-- canonical column spec.
--
-- Design notes:
--   * **Double-booking prevention** is enforced by a Postgres
--     exclusion constraint, not by application-level locking. The
--     constraint refuses an insert / update whose `(staff_id, time
--     range)` overlaps any *active* row (`status IN ('REQUESTED',
--     'ACCEPTED')`). Cancelled / rejected / completed rows do not
--     block new bookings at the same time. Two concurrent customers
--     attempting the same slot get exactly one success and one
--     `exclusion_violation` (SQLSTATE 23P01) — the application
--     layer translates that to `SLOT_UNAVAILABLE`.
--
--     The exclusion needs `btree_gist` for the equality operator on
--     the `staff_id` uuid inside the GiST index. The extension is
--     small (in mainline contrib) and Amazon RDS PostgreSQL ships
--     with it available.
--
--   * `price_etb` is snapshotted from `services.price_etb` at booking
--     time. Service price changes after booking do not affect the
--     existing appointment.
--
--   * `payment_method` is required (every booking declares its
--     intent). MVP supports `CASH` end-to-end and `ONLINE_PENDING`
--     as a planned-but-failing path (`MockOnlineGateway`).
--
--   * Soft-delete via `deleted_at` per the project convention for
--     retention-required tables. The booking flow never hard-deletes.
--     Listing queries filter `WHERE deleted_at IS NULL`.
--
--   * Indexes match the schema doc: three `(_, starts_at)` indexes
--     for the customer / business / staff listing paths, plus a
--     `(status)` index for admin dashboards.
--
--   * Reuses the `set_updated_at()` trigger function defined in
--     migration 0002.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE appointments (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     uuid          NOT NULL
        REFERENCES users (id) ON DELETE RESTRICT,
    business_id     uuid          NOT NULL
        REFERENCES business_profiles (id) ON DELETE RESTRICT,
    service_id      uuid          NOT NULL
        REFERENCES services (id) ON DELETE RESTRICT,
    staff_id        uuid          NOT NULL
        REFERENCES staff_members (id) ON DELETE RESTRICT,
    starts_at       timestamptz   NOT NULL,
    ends_at         timestamptz   NOT NULL,
    status          text          NOT NULL DEFAULT 'REQUESTED'
        CHECK (status IN (
            'REQUESTED',
            'ACCEPTED',
            'REJECTED',
            'CANCELLED',
            'COMPLETED',
            'NO_SHOW'
        )),
    payment_method  text          NOT NULL
        CHECK (payment_method IN ('CASH', 'ONLINE_PENDING')),
    price_etb       numeric(12,2) NOT NULL,
    notes           text,
    cancelled_by    text
        CHECK (cancelled_by IS NULL
               OR cancelled_by IN ('CUSTOMER', 'BUSINESS', 'ADMIN')),
    cancel_reason   text,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    deleted_at      timestamptz,

    CONSTRAINT appointments_end_after_start_check
        CHECK (ends_at > starts_at),

    -- Double-booking guard. Two ACTIVE rows (REQUESTED or ACCEPTED)
    -- for the same staff member cannot have overlapping
    -- [starts_at, ends_at) ranges. The `[)` interval is half-open:
    -- a booking that ends at exactly the second's start is allowed.
    CONSTRAINT appointments_no_overlap_excl
        EXCLUDE USING gist (
            staff_id WITH =,
            tstzrange(starts_at, ends_at, '[)') WITH &&
        ) WHERE (status IN ('REQUESTED', 'ACCEPTED'))
);

CREATE INDEX appointments_business_starts_idx
    ON appointments (business_id, starts_at);

CREATE INDEX appointments_customer_starts_idx
    ON appointments (customer_id, starts_at);

CREATE INDEX appointments_staff_starts_idx
    ON appointments (staff_id, starts_at);

CREATE INDEX appointments_status_idx
    ON appointments (status);

CREATE TRIGGER appointments_set_updated_at
BEFORE UPDATE ON appointments
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
