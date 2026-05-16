-- Phase 10 — webhook reverse-lookup index on payment_intents.provider_ref.
--
-- The Chapa webhook handler (Phase 10 commit 3) receives a callback
-- carrying the upstream `tx_ref` and needs to find the matching
-- `payment_intents` row in order to flip its `status` and dispatch
-- to the appointment / featuring activation path. Without this index
-- the lookup falls back to a sequential scan over every row in the
-- table.
--
-- The index is:
--   * Partial — `WHERE provider_ref IS NOT NULL` — because cash
--     bookings never write a `payment_intents` row but other writes
--     could populate the table without an upstream reference. The
--     partial scope keeps the index tight and means the uniqueness
--     constraint doesn't accidentally reject legitimate NULL rows.
--   * Unique — every upstream provider issues a globally-unique
--     reference per transaction (Chapa's `tx_ref`, future Telebirr
--     transaction id). A `provider_ref` collision would mean either
--     a webhook replay against a brand-new transaction (data
--     integrity bug worth blocking) OR two services emitting the
--     same string (also a bug). The uniqueness constraint catches
--     both.
--
-- Forward-compat: the column is `text` and the namespace (`apt-…`
-- vs `feat-…` vs raw upstream-issued strings) is application-level,
-- not schema-level. Adding `TELEBIRR` as a second provider doesn't
-- require an index change as long as Telebirr's transaction ids
-- remain globally unique within the provider — and they are.

CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_provider_ref_uniq
    ON payment_intents (provider_ref)
    WHERE provider_ref IS NOT NULL;
