-- EthioLink — seed: review-lifecycle fixtures (PENDING + REJECTED).
--
-- WARNING — DEV ONLY (same disclaimer as 0002_dev_businesses.sql).
--
-- Purpose:
--   The 0002 seed inserts eight APPROVED businesses so customers
--   have things to browse. This seed adds two more — one
--   PENDING_REVIEW and one REJECTED — so the admin SPA's Pending
--   queue + the mobile owner-tab's status-aware banner (DRAFT /
--   PENDING_REVIEW / REJECTED with admin note) have data to
--   exercise without running through a real owner-submit + admin-
--   reject round-trip first.
--
--   The REJECTED business gets a matching `admin_actions` row
--   (action='REJECT_BUSINESS', notes='<reason>') so
--   `GET /v1/me/business` surfaces the reason via the
--   `rejection.reason` field. The mobile owner_tab's
--   `_RejectedBanner` renders that note inline.
--
-- Idempotency:
--   * Deterministic UUIDs via md5(stable_string)::uuid — same
--     pattern as 0002. Re-running this seed (or a fresh DB
--     after a snapshot restore) produces the same rows.
--   * ON CONFLICT (cognito_sub) DO UPDATE on the synthetic admin
--     user (cognito_sub is the natural unique key).
--   * ON CONFLICT (id) DO UPDATE on business_profiles and the
--     business_owner users.
--   * admin_actions is append-only at the application layer (no
--     UPDATE / DELETE per the table doc-comment) so we DON'T use
--     ON CONFLICT (id) DO NOTHING — instead the seed uses a
--     deterministic id and `WHERE NOT EXISTS` to insert exactly
--     once per re-run. A re-applied seed leaves the original
--     audit row intact, which is the correct semantic for an
--     append-only audit table.
--
-- Lifecycle this seed exercises end-to-end:
--   * Admin signs in → opens BusinessesPage → default filter is
--     PENDING_REVIEW → the new Habesha Tej House row appears.
--   * Admin opens the row → taps Approve (writes
--     admin_actions(action='APPROVE_BUSINESS')) → row moves to
--     APPROVED, customer browse picks it up.
--   * Owner of the REJECTED row signs in (Sami's Cuts owner) →
--     owner_tab renders the REJECTED banner with the admin note
--     ("Photo of license is unreadable.") inline.
--   * Owner edits + tap "Submit for review" → status flips back
--     to PENDING_REVIEW → admin queue picks it up.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Synthetic admin user — only used as the `admin_user_id` on
--    the seeded REJECT_BUSINESS row. Real ADMIN sessions (per the
--    Cognito seed script) get their own users row via auth/sync.
-- ---------------------------------------------------------------------------

INSERT INTO users (id, cognito_sub, email, phone, role, status, display_name)
VALUES
    (
        md5('seed:admin:reviewer')::uuid,
        'seed:admin:reviewer',
        'reviewer@ethiolink.test',
        '+251911000999',
        'ADMIN',
        'ACTIVE',
        'Seed Reviewer'
    )
ON CONFLICT (cognito_sub) DO UPDATE
    SET email        = EXCLUDED.email,
        phone        = EXCLUDED.phone,
        role         = EXCLUDED.role,
        status       = EXCLUDED.status,
        display_name = EXCLUDED.display_name;

-- ---------------------------------------------------------------------------
-- 2. Two new BUSINESS_OWNER users — one per new business.
-- ---------------------------------------------------------------------------

INSERT INTO users (id, cognito_sub, email, phone, role, status, display_name)
VALUES
    (
        md5('seed:owner:tej-house')::uuid,
        'seed:owner:tej-house',
        'tejhouse@ethiolink.test',
        '+251911000301',
        'BUSINESS_OWNER',
        'ACTIVE',
        'Habesha Tej House Owner'
    ),
    (
        md5('seed:owner:samis-cuts')::uuid,
        'seed:owner:samis-cuts',
        'samiscuts@ethiolink.test',
        '+251911000302',
        'BUSINESS_OWNER',
        'ACTIVE',
        E'Sami\'s Cuts Owner'
    )
ON CONFLICT (cognito_sub) DO UPDATE
    SET email        = EXCLUDED.email,
        phone        = EXCLUDED.phone,
        role         = EXCLUDED.role,
        status       = EXCLUDED.status,
        display_name = EXCLUDED.display_name;

-- ---------------------------------------------------------------------------
-- 3. Two new business_profiles — one PENDING_REVIEW, one REJECTED.
-- ---------------------------------------------------------------------------
--
-- Habesha Tej House (PENDING_REVIEW) — drops the admin queue
-- straight into a usable state. Description fields are populated
-- so the admin has something realistic to read before approving.
--
-- Sami's Cuts (REJECTED) — owner-side fixture for the rejection
-- banner. The accompanying admin_actions row carries the reason.

INSERT INTO business_profiles (
    id, owner_user_id, category_id,
    name, description, city, address_line,
    latitude, longitude, phone, telegram_handle, whatsapp_phone,
    status, rating_avg, rating_count
)
VALUES
    (
        md5('seed:biz:tej-house')::uuid,
        md5('seed:owner:tej-house')::uuid,
        (SELECT id FROM business_categories WHERE slug = 'beauty_professional'),
        'Habesha Tej House',
        '{"en":"Traditional Ethiopian beauty and pre-wedding henna studio. Awaiting approval."}'::jsonb,
        'Addis Ababa', 'Bole Medhanealem, near Friendship Mall',
        8.9886, 38.7892, '+251911000401', NULL, NULL,
        'PENDING_REVIEW', 0, 0
    ),
    (
        md5('seed:biz:samis-cuts')::uuid,
        md5('seed:owner:samis-cuts')::uuid,
        (SELECT id FROM business_categories WHERE slug = 'barber'),
        E'Sami\'s Cuts',
        '{"en":"Single-chair barbershop near Mexico Square. Submitted with incomplete documentation."}'::jsonb,
        'Addis Ababa', 'Mexico Square, second floor',
        9.0089, 38.7510, '+251911000402', NULL, NULL,
        'REJECTED', 0, 0
    )
ON CONFLICT (id) DO UPDATE
    SET owner_user_id   = EXCLUDED.owner_user_id,
        category_id     = EXCLUDED.category_id,
        name            = EXCLUDED.name,
        description     = EXCLUDED.description,
        city            = EXCLUDED.city,
        address_line    = EXCLUDED.address_line,
        latitude        = EXCLUDED.latitude,
        longitude       = EXCLUDED.longitude,
        phone           = EXCLUDED.phone,
        telegram_handle = EXCLUDED.telegram_handle,
        whatsapp_phone  = EXCLUDED.whatsapp_phone,
        status          = EXCLUDED.status,
        rating_avg      = EXCLUDED.rating_avg,
        rating_count    = EXCLUDED.rating_count;

-- ---------------------------------------------------------------------------
-- 4. admin_actions row — the canonical rejection-reason store for
--    Sami's Cuts. `GET /v1/me/business` reads the most-recent
--    REJECT_BUSINESS row for the business and surfaces its
--    `notes` as `rejection.reason` (see businessView.ts).
-- ---------------------------------------------------------------------------
--
-- admin_actions is append-only — ON CONFLICT DO NOTHING is the
-- correct shape so a re-applied seed leaves the original audit
-- row untouched.

INSERT INTO admin_actions (
    id, admin_user_id, action, target_type, target_id, notes
)
SELECT
    md5('seed:adminaction:samis-cuts:reject')::uuid,
    md5('seed:admin:reviewer')::uuid,
    'REJECT_BUSINESS',
    'business_profile',
    md5('seed:biz:samis-cuts')::uuid,
    'Business license photo is unreadable. Please re-upload a clear scan ' ||
    'or photo of the trade license, then submit for review again.'
WHERE NOT EXISTS (
    SELECT 1 FROM admin_actions
     WHERE id = md5('seed:adminaction:samis-cuts:reject')::uuid
);

COMMIT;
