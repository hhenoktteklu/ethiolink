-- EthioLink — migration 0018: featuring_subscriptions + payment_intents widening.
--
-- Phase 9 Track 6 — paid featuring foundation. Adds the
-- `featuring_subscriptions` table that records each owner-purchase
-- or admin-comp featuring slot for a business, plus a widening of
-- the existing `payment_intents` table so a single intent can
-- attach to either an appointment OR a featuring subscription
-- (exactly one, never both).
--
-- Design notes:
--
--   * **`featuring_subscriptions` is the lifecycle authority.**
--     The customer-side discovery surface already reads
--     `business_profiles.featured_until` as the single derived
--     field; the daily / 15-minute sweep Lambda (next commit)
--     projects from this table into that column. So nothing on
--     the customer surface needs to change when this migration
--     applies — `featured_until` stays `null` until the first
--     subscription is ACTIVE.
--
--   * **One ACTIVE row per business.** A partial unique index
--     enforces it at the DB level — the service layer adds the
--     friendly error, but the DB is the binding guard.
--
--   * **Status enum** (`PENDING_PAYMENT` / `ACTIVE` / `EXPIRED` /
--     `CANCELLED` / `REFUNDED`). The 10-minute `PENDING_PAYMENT`
--     TTL is application-side (sweep Lambda deletes); the DB
--     doesn't carry a TTL constraint because the sweep's logic
--     bounds it cleanly.
--
--   * **`source`** distinguishes paid (`OWNER_PURCHASE`) from
--     editorial (`ADMIN_COMP`) so the admin SPA's history panel
--     can render different badges and analytics can split revenue
--     from comp dilution.
--
--   * **`payment_intents` widening.** The original migration 0011
--     pinned `appointment_id NOT NULL`. We relax that to nullable
--     and add a nullable `featuring_subscription_id` FK; a CHECK
--     constraint enforces exactly-one-is-set so a row can't
--     accidentally orphan or double-attach. The existing
--     `(appointment_id, created_at DESC)` index keeps working —
--     it just naturally excludes rows where `appointment_id IS
--     NULL`, which is exactly what the booking-side read path
--     wants. A parallel `(featuring_subscription_id, created_at
--     DESC)` index supports the featuring-side read.
--
--   * **No backfill.** No existing `payment_intents` rows in dev
--     today; the production env will get this migration before any
--     featuring subscription is created, so the CHECK is safe to
--     apply against the empty table.
--
--   * **`payment_intents.provider` CHECK list unchanged.** New
--     providers (e.g. a future `TELEBIRR_FEATURING`) reuse the
--     existing `TELEBIRR` value; the discriminator is the FK
--     target (appointment vs. featuring), not the provider name.

BEGIN;

-- ---------------------------------------------------------------------------
-- featuring_subscriptions
-- ---------------------------------------------------------------------------

CREATE TABLE featuring_subscriptions (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id          uuid          NOT NULL
        REFERENCES business_profiles (id) ON DELETE CASCADE,
    package_code         text          NOT NULL
        CHECK (package_code IN ('FEATURING_7D', 'FEATURING_30D')),
    price_etb            numeric(12,2) NOT NULL CHECK (price_etb >= 0),
    starts_at            timestamptz   NOT NULL,
    ends_at              timestamptz   NOT NULL,
    status               text          NOT NULL DEFAULT 'PENDING_PAYMENT'
        CHECK (status IN ('PENDING_PAYMENT', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'REFUNDED')),
    source               text          NOT NULL DEFAULT 'OWNER_PURCHASE'
        CHECK (source IN ('OWNER_PURCHASE', 'ADMIN_COMP')),
    cancelled_at         timestamptz,
    cancelled_reason     text,
    created_by_user_id   uuid          NOT NULL
        REFERENCES users (id) ON DELETE RESTRICT,
    created_at           timestamptz   NOT NULL DEFAULT now(),
    updated_at           timestamptz   NOT NULL DEFAULT now(),

    -- `ends_at` must be strictly after `starts_at` — a zero-
    -- duration subscription is meaningless and would break the
    -- sweep's `ends_at < now()` check on the boundary instant.
    CHECK (ends_at > starts_at)
);

-- Partial unique index — only one ACTIVE row per business.
-- Historical EXPIRED / CANCELLED / REFUNDED rows are allowed to
-- multiply freely under the same business.
CREATE UNIQUE INDEX featuring_subscriptions_one_active_per_business
    ON featuring_subscriptions (business_id)
    WHERE status = 'ACTIVE';

-- Sweep paths walk by (status, ends_at) — covers both "expire
-- ACTIVE rows past ends_at" and "delete PENDING_PAYMENT rows
-- past their 10-minute TTL".
CREATE INDEX featuring_subscriptions_status_ends_at
    ON featuring_subscriptions (status, ends_at);

-- Per-business history reads (owner audit panel + admin detail
-- page) hit this index in `created_at DESC` order.
CREATE INDEX featuring_subscriptions_business_created
    ON featuring_subscriptions (business_id, created_at DESC);

-- Standard `updated_at` trigger; the function was defined in
-- migration 0002 and is reused across every table.
CREATE TRIGGER featuring_subscriptions_set_updated_at
BEFORE UPDATE ON featuring_subscriptions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- payment_intents widening
-- ---------------------------------------------------------------------------

-- Relax the appointment FK to nullable. Existing booking-side
-- writes pass an `appointment_id` so they're unaffected by this
-- change.
ALTER TABLE payment_intents
    ALTER COLUMN appointment_id DROP NOT NULL;

-- Add the new featuring FK. Nullable; the CHECK below requires
-- exactly one of the two FKs to be set per row.
ALTER TABLE payment_intents
    ADD COLUMN featuring_subscription_id uuid
        REFERENCES featuring_subscriptions (id) ON DELETE CASCADE;

-- Exactly one of the two FKs must be non-null. Postgres SQL
-- doesn't have a literal `XOR`; the two-clause comparison below
-- is the standard pattern.
ALTER TABLE payment_intents
    ADD CONSTRAINT payment_intents_target_xor
        CHECK (
            (appointment_id IS NULL) <> (featuring_subscription_id IS NULL)
        );

-- Read path for "give me the latest intent for featuring
-- subscription X". Mirrors the existing
-- `(appointment_id, created_at DESC)` index. The two indexes are
-- naturally disjoint because each row only sets one FK.
CREATE INDEX payment_intents_featuring_created_idx
    ON payment_intents (featuring_subscription_id, created_at DESC);

COMMIT;
