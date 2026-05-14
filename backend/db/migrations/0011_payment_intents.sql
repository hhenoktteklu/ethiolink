-- EthioLink — migration 0011: payment_intents table.
--
-- Placeholder table for the future online-payment flow. In MVP the
-- only working path is CASH (no row written here); the
-- `MockOnlineGateway` exercises the ONLINE_PENDING code path against a
-- provider that immediately fails, which still produces a row here
-- with `status = 'FAILED'`. Real provider integrations (Telebirr,
-- Chapa, CBE Birr) slot in behind the same `PaymentGateway` interface
-- without schema changes.
--
-- See docs/architecture/DATABASE_SCHEMA.md "payment_intents" for the
-- canonical column spec.
--
-- Design notes:
--   * **`appointment_id` ON DELETE CASCADE** — unlike `reviews`, a
--     payment-intent row is meaningless without its parent appointment.
--     If an appointment is ever hard-deleted (admin purge for a GDPR-
--     style erasure), the intent row should go with it. Cash bookings
--     never write here, so most appointments will have zero intent
--     rows; an online booking flow can write multiple intents (e.g.
--     PENDING → FAILED, then a retry → SUCCEEDED), which is why this
--     column is NOT UNIQUE.
--
--   * **`provider`** is a CHECK-bounded text column rather than a
--     Postgres ENUM (project convention — cheaper migrations).
--     `MOCK` is the only value the application writes in MVP; the
--     three real-provider values are reserved so adding them later is
--     a code-only change. `provider` defaults to `'MOCK'` so the test
--     surface area stays small.
--
--   * **`status`** mirrors a standard payment-intent lifecycle.
--     `PENDING` is the row's birth state; the gateway adapter
--     transitions it to one of the three terminal states. The
--     application layer enforces transition rules; the DB CHECK only
--     constrains the value set.
--
--   * **`amount_etb`** is `numeric(12,2) NOT NULL` — same precision
--     as the rest of the system. The booking service copies it from
--     the parent appointment's `price_etb` at intent-creation time
--     (snapshot, just like the appointment itself snapshots from the
--     service).
--
--   * **`provider_ref`** is the external provider's identifier
--     (e.g. a Telebirr transaction ID). Nullable because PENDING
--     intents may not have one yet, and the `MOCK` provider has no
--     real external system to reference.
--
--   * **`raw_response`** is the verbatim provider payload stored as
--     JSONB. Kept for debugging and reconciliation; the application
--     never queries inside it in MVP, so no GIN index is added yet.
--
--   * **No `deleted_at`**. Payment intents are not retention-
--     required in their own right — when the parent appointment is
--     erased, the CASCADE removes the intent row, and an intent that
--     is simply superseded gets a new row rather than being hidden.
--
--   * **Indexes**: the schema doc does not enumerate payment_intents
--     indexes. Two are added to back the documented read paths:
--     - `(appointment_id, created_at DESC)` — "give me the latest
--       intent for appointment X", which the booking service uses
--       when resuming an online flow or rendering payment status.
--     - `(status)` — admin / reconciliation dashboards filtering
--       stuck PENDING rows or all FAILED rows in a window.
--
--   * Reuses the `set_updated_at()` trigger function defined in
--     migration 0002.

BEGIN;

CREATE TABLE payment_intents (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id  uuid          NOT NULL
        REFERENCES appointments (id) ON DELETE CASCADE,
    provider        text          NOT NULL DEFAULT 'MOCK'
        CHECK (provider IN ('MOCK', 'TELEBIRR', 'CHAPA', 'CBE_BIRR')),
    amount_etb      numeric(12,2) NOT NULL,
    status          text          NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    provider_ref    text,
    raw_response    jsonb,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX payment_intents_appointment_created_idx
    ON payment_intents (appointment_id, created_at DESC);

CREATE INDEX payment_intents_status_idx
    ON payment_intents (status);

CREATE TRIGGER payment_intents_set_updated_at
BEFORE UPDATE ON payment_intents
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
