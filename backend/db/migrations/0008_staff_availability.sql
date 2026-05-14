-- EthioLink — migration 0008: staff_availability table.
--
-- Per-staff availability windows. Each row is either:
--
--   * a WEEKLY entry — describes a recurring open window on a particular
--     weekday (`weekday` populated, `specific_date` NULL); or
--   * an OVERRIDE entry — applies to a single calendar date
--     (`specific_date` populated, `weekday` NULL). Overrides can either
--     add a special open window or, with `is_closed = true`, blank out
--     a range that the weekly schedule would otherwise cover.
--
-- The Phase 3 slot computation in `availabilityService` reads both kinds
-- together, lays the overrides on top of the weekly pattern, and emits
-- bookable slots for a date range.
--
-- See docs/architecture/DATABASE_SCHEMA.md "staff_availability" for the
-- canonical column spec.
--
-- Design notes:
--   * No `updated_at` column. The schema doc deliberately omits it: rows
--     are either inserted (overrides) or replaced wholesale (weekly is
--     overwritten via a transaction that DELETEs the staff's WEEKLY rows
--     and INSERTs the new set). A row, once stored, is immutable.
--   * `is_closed = true` is the "blackout" pattern. Used almost
--     exclusively for OVERRIDE rows ("closed for a public holiday",
--     "closed for personal time"). A WEEKLY row with `is_closed = true`
--     is allowed by the schema but semantically a no-op — it would just
--     hide a portion of the recurring schedule and clients should simply
--     omit that window from the WEEKLY entries.
--   * Two table-level CHECKs:
--     - `weekday` must be NULL or in [0,6] (Sunday through Saturday).
--     - WEEKLY rows require `weekday` and forbid `specific_date`;
--       OVERRIDE rows require `specific_date` and forbid `weekday`.
--     The polymorphic shape is enforced at the DB so a misbehaving
--     service-layer caller cannot persist a row that the slot computer
--     would silently ignore.
--   * `end_time > start_time` is enforced — empty or inverted windows
--     would break the slot computer's interval arithmetic.
--   * `staff_id` has `ON DELETE CASCADE`: deleting a staff member (rare;
--     normally a deactivation) takes their availability with them.
--   * Indexes per the schema doc:
--     - `(staff_id, kind)` for "give me all weekly rows for staff X"
--       (the dominant slot-computation read).
--     - `(staff_id, specific_date)` for override lookups on a target date.

BEGIN;

CREATE TABLE staff_availability (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id       uuid        NOT NULL
        REFERENCES staff_members (id) ON DELETE CASCADE,
    kind           text        NOT NULL
        CHECK (kind IN ('WEEKLY', 'OVERRIDE')),
    weekday        int
        CHECK (weekday IS NULL OR (weekday >= 0 AND weekday <= 6)),
    specific_date  date,
    start_time     time        NOT NULL,
    end_time       time        NOT NULL,
    is_closed      bool        NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT staff_availability_end_after_start_check
        CHECK (end_time > start_time),

    CONSTRAINT staff_availability_kind_columns_check CHECK (
        (kind = 'WEEKLY'   AND weekday       IS NOT NULL AND specific_date IS NULL) OR
        (kind = 'OVERRIDE' AND specific_date IS NOT NULL AND weekday       IS NULL)
    )
);

CREATE INDEX staff_availability_staff_kind_idx
    ON staff_availability (staff_id, kind);

CREATE INDEX staff_availability_staff_date_idx
    ON staff_availability (staff_id, specific_date);

COMMIT;
