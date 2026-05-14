-- EthioLink — seed: MVP beauty marketplace categories.
--
-- The four entries listed in docs/product/MVP_SCOPE.md "in scope - customer":
-- salons, barbers, spas, beauty professionals.
--
-- Idempotent: re-running keeps slugs unique and refreshes `name` and
-- `sort_order` to the values declared here. `is_active` is intentionally
-- NOT overwritten on conflict, because an admin may have deactivated a
-- category from the dashboard and a re-seed should not silently re-enable
-- it. New rows still get the column default of `true`.
--
-- This file is NOT yet auto-applied by `npm run db:migrate` — the runner
-- in backend/db/migrate.mjs only processes migrations/. Apply manually
-- for now:
--
--     docker-compose exec -T db psql -U ethiolink -d ethiolink \
--       < backend/db/seeds/0001_categories.sql
--
-- A dedicated seed runner is queued for a follow-up Phase 2 commit.

BEGIN;

INSERT INTO business_categories (slug, name, sort_order, is_active)
VALUES
    ('salon',               '{"en":"Salon"}'::jsonb,                10, true),
    ('barber',              '{"en":"Barber"}'::jsonb,               20, true),
    ('spa',                 '{"en":"Spa"}'::jsonb,                  30, true),
    ('beauty_professional', '{"en":"Beauty Professional"}'::jsonb,  40, true)
ON CONFLICT (slug) DO UPDATE
    SET name       = EXCLUDED.name,
        sort_order = EXCLUDED.sort_order;

COMMIT;
