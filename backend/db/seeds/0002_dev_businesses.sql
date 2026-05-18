-- EthioLink — seed: dev/test businesses for mobile browsing + booking.
--
-- WARNING — DEV ONLY.
--   This seed creates eight APPROVED business listings spread across
--   the four MVP categories (salon, barber, spa, beauty_professional)
--   plus a synthetic BUSINESS_OWNER user per business, two services
--   each, one staff member each, and a Mon-Sat 09:00-18:00 weekly
--   availability window for each staff member.
--
--   The data is mock — fake phone numbers, addresses, owner emails on
--   the `ethiolink.test` domain. Do NOT invoke `seed` mode of the
--   `ethiolink-prod-maintenance-db-migrate` Lambda. The dev workflow
--   is:
--
--     aws lambda invoke \
--         --function-name ethiolink-dev-maintenance-db-migrate \
--         --cli-binary-format raw-in-base64-out \
--         --payload '{"mode":"seed"}' \
--         /tmp/seed.json
--
--   The schema_seeds ledger (managed by `runSeeds` in seed.mjs) prevents
--   accidental double-application within an environment, but does NOT
--   prevent an operator from invoking seed mode against prod. The
--   operator runbook (docs/operations/runbooks/dev-migrations.md and
--   PHASE_7 onward) calls this out explicitly.
--
-- Idempotency:
--   Every row uses a deterministic primary key (`md5(stable_string)::uuid`)
--   so re-running the file (after wiping `schema_seeds` or against a
--   freshly-restored snapshot) produces the same rows with the same
--   IDs. INSERT ... ON CONFLICT (id) DO UPDATE makes the SQL fully
--   re-runnable from the data side; the seed ledger makes the runner
--   side a fast no-op on the common path.
--
--   The `users` rows use `ON CONFLICT (cognito_sub) DO UPDATE` instead
--   because `cognito_sub` is the natural unique key on that table
--   (id is a generated UUID with no other constraint).
--
-- Why deterministic UUIDs:
--   business_profiles, services, staff_members, and staff_availability
--   have no application-level natural unique key, so ON CONFLICT (id)
--   is the only viable conflict target. md5 yields 32 hex chars which
--   Postgres casts directly to its UUID type. The seed strings encode
--   role + slug ("seed:biz:salon-sunset", "seed:service:salon-sunset:haircut",
--   etc.) so a stray Postgres uuid collision against gen_random_uuid()
--   real-data IDs has odds on the order of 1/2^128 — effectively zero.
--
-- Category resolution:
--   category_id is looked up by slug, NOT hardcoded. The categories seed
--   (0001_categories.sql) inserts rows with random UUIDs, so we must
--   resolve at insert time. (SELECT id FROM business_categories WHERE
--   slug = '<slug>') is the pattern used throughout.
--
-- Geo:
--   All eight businesses sit in Addis Ababa with small lat/lon offsets
--   off the 9.0,38.75 anchor — enough to render distinct pins on a
--   map view when the design pass adds one.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Owner users — one BUSINESS_OWNER per seeded business.
-- ---------------------------------------------------------------------------
--
-- The cognito_sub uses a `seed:owner:<slug>` shape so it can't collide
-- with a real Cognito-issued sub (which is always a UUID). Email lives
-- on the `ethiolink.test` reserved-by-RFC-2606 domain so it can never
-- match a real user's mailbox.

INSERT INTO users (id, cognito_sub, email, phone, role, status, display_name)
VALUES
    (md5('seed:owner:salon-sunset')::uuid,        'seed:owner:salon-sunset',        'sunset@ethiolink.test',        '+251911000101', 'BUSINESS_OWNER', 'ACTIVE', 'Sunset Salon Owner'),
    (md5('seed:owner:salon-habesha')::uuid,       'seed:owner:salon-habesha',       'habesha@ethiolink.test',       '+251911000102', 'BUSINESS_OWNER', 'ACTIVE', 'Habesha Beauty Owner'),
    (md5('seed:owner:barber-sheger')::uuid,       'seed:owner:barber-sheger',       'sheger@ethiolink.test',        '+251911000103', 'BUSINESS_OWNER', 'ACTIVE', 'Sheger Barbers Owner'),
    (md5('seed:owner:barber-lions-mane')::uuid,   'seed:owner:barber-lions-mane',   'lionsmane@ethiolink.test',     '+251911000104', 'BUSINESS_OWNER', 'ACTIVE', E'Lion\'s Mane Barbershop Owner'),
    (md5('seed:owner:spa-tana')::uuid,            'seed:owner:spa-tana',            'tana@ethiolink.test',          '+251911000105', 'BUSINESS_OWNER', 'ACTIVE', 'Tana Wellness Spa Owner'),
    (md5('seed:owner:spa-entoto')::uuid,          'seed:owner:spa-entoto',          'entoto@ethiolink.test',        '+251911000106', 'BUSINESS_OWNER', 'ACTIVE', 'Entoto Spa Retreat Owner'),
    (md5('seed:owner:beauty-henna')::uuid,        'seed:owner:beauty-henna',        'henna@ethiolink.test',         '+251911000107', 'BUSINESS_OWNER', 'ACTIVE', 'Hana Henna Studio Owner'),
    (md5('seed:owner:beauty-brows')::uuid,        'seed:owner:beauty-brows',        'brows@ethiolink.test',         '+251911000108', 'BUSINESS_OWNER', 'ACTIVE', 'Selam Brows & Lashes Owner')
ON CONFLICT (cognito_sub) DO UPDATE
    SET email        = EXCLUDED.email,
        phone        = EXCLUDED.phone,
        role         = EXCLUDED.role,
        status       = EXCLUDED.status,
        display_name = EXCLUDED.display_name;

-- ---------------------------------------------------------------------------
-- 2. business_profiles — APPROVED so they appear in the public listing.
-- ---------------------------------------------------------------------------
--
-- description is JSONB ({"en": "...", "am": "..."}) per the schema
-- convention; we ship `en` only here because the customer-facing
-- localization track only emits English copy today (Track 5 ARB
-- bundles aren't customer-data, they're UI strings).

INSERT INTO business_profiles (
    id, owner_user_id, category_id,
    name, description, city, address_line,
    latitude, longitude, phone, telegram_handle, whatsapp_phone,
    status, rating_avg, rating_count
)
VALUES
    -- Salons -----------------------------------------------------------------
    (
        md5('seed:biz:salon-sunset')::uuid,
        md5('seed:owner:salon-sunset')::uuid,
        (SELECT id FROM business_categories WHERE slug = 'salon'),
        'Sunset Salon',
        '{"en":"Family-run salon in Bole offering cuts, color, and styling. Walk-ins welcome."}'::jsonb,
        'Addis Ababa', 'Bole, Wello Sefer, near Edna Mall',
        8.9925, 38.7896, '+251911000201', 'sunsetsalon', NULL,
        'APPROVED', 4.7, 28
    ),
    (
        md5('seed:biz:salon-habesha')::uuid,
        md5('seed:owner:salon-habesha')::uuid,
        (SELECT id FROM business_categories WHERE slug = 'salon'),
        'Habesha Beauty',
        '{"en":"Specialists in protective styles, braiding, and traditional Ethiopian hair care, in the heart of Piazza."}'::jsonb,
        'Addis Ababa', 'Piazza, behind Taitu Hotel',
        9.0345, 38.7515, '+251911000202', 'habeshabeauty', '+251911000202',
        'APPROVED', 4.5, 14
    ),
    -- Barbers ----------------------------------------------------------------
    (
        md5('seed:biz:barber-sheger')::uuid,
        md5('seed:owner:barber-sheger')::uuid,
        (SELECT id FROM business_categories WHERE slug = 'barber'),
        'Sheger Barbers',
        '{"en":"Classic and modern cuts, beard sculpting, and hot-towel shaves. Kazanchis flagship."}'::jsonb,
        'Addis Ababa', 'Kazanchis, opposite the German embassy',
        9.0123, 38.7728, '+251911000203', NULL, NULL,
        'APPROVED', 4.8, 41
    ),
    (
        md5('seed:biz:barber-lions-mane')::uuid,
        md5('seed:owner:barber-lions-mane')::uuid,
        (SELECT id FROM business_categories WHERE slug = 'barber'),
        E'Lion\'s Mane Barbershop',
        '{"en":"Megenagna walk-in barbershop. Sports cuts, fades, line-ups, and beard care, seven days a week."}'::jsonb,
        'Addis Ababa', 'Megenagna roundabout, west side',
        9.0210, 38.8013, '+251911000204', 'lionsmane_abebebars', NULL,
        'APPROVED', 4.6, 22
    ),
    -- Spas -------------------------------------------------------------------
    (
        md5('seed:biz:spa-tana')::uuid,
        md5('seed:owner:spa-tana')::uuid,
        (SELECT id FROM business_categories WHERE slug = 'spa'),
        'Tana Wellness Spa',
        '{"en":"Full-service day spa: Swedish and deep-tissue massage, hot-stone, body scrubs, and facials. Bole location with parking."}'::jsonb,
        'Addis Ababa', 'Bole, off Cameroon St., Kebede Tessema Bldg.',
        8.9962, 38.7950, '+251911000205', 'tanaspa', '+251911000205',
        'APPROVED', 4.9, 63
    ),
    (
        md5('seed:biz:spa-entoto')::uuid,
        md5('seed:owner:spa-entoto')::uuid,
        (SELECT id FROM business_categories WHERE slug = 'spa'),
        'Entoto Spa Retreat',
        '{"en":"Quiet adults-only retreat near Old Airport offering signature massages, aromatherapy, and steam rooms."}'::jsonb,
        'Addis Ababa', 'Old Airport, Africa Avenue',
        9.0017, 38.7585, '+251911000206', NULL, NULL,
        'APPROVED', 4.4, 19
    ),
    -- Beauty Professionals --------------------------------------------------
    (
        md5('seed:biz:beauty-henna')::uuid,
        md5('seed:owner:beauty-henna')::uuid,
        (SELECT id FROM business_categories WHERE slug = 'beauty_professional'),
        'Hana Henna Studio',
        '{"en":"Mobile and studio henna artist for brides, parties, and Mehndi nights. Bole Rwanda studio appointments by booking."}'::jsonb,
        'Addis Ababa', 'Bole Rwanda, off Africa Avenue',
        8.9954, 38.7878, '+251911000207', 'hanahenna', '+251911000207',
        'APPROVED', 4.8, 35
    ),
    (
        md5('seed:biz:beauty-brows')::uuid,
        md5('seed:owner:beauty-brows')::uuid,
        (SELECT id FROM business_categories WHERE slug = 'beauty_professional'),
        'Selam Brows & Lashes',
        '{"en":"Brow lamination, microblading, lash extensions, and threading. CMC studio with single-treatment rooms."}'::jsonb,
        'Addis Ababa', 'CMC, near St. Michael Church',
        9.0334, 38.8120, '+251911000208', 'selambrows', NULL,
        'APPROVED', 4.7, 27
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
-- 3. services — two per business, name + duration + price.
-- ---------------------------------------------------------------------------
--
-- price_etb is `numeric(12,2)` — we omit the column for one service
-- per category on purpose to exercise the "Price on request" code path
-- the mobile detail screen renders.

INSERT INTO services (
    id, business_id, name, description,
    duration_minutes, price_etb, is_active
)
VALUES
    -- Sunset Salon
    (md5('seed:service:salon-sunset:haircut')::uuid, md5('seed:biz:salon-sunset')::uuid,
     '{"en":"Haircut + style"}'::jsonb,
     '{"en":"Consultation, wash, cut, and blowdry."}'::jsonb,
     45, 600, true),
    (md5('seed:service:salon-sunset:color')::uuid, md5('seed:biz:salon-sunset')::uuid,
     '{"en":"Full color"}'::jsonb,
     '{"en":"Single-process or all-over color. Price on consultation."}'::jsonb,
     120, NULL, true),
    -- Habesha Beauty
    (md5('seed:service:salon-habesha:braiding')::uuid, md5('seed:biz:salon-habesha')::uuid,
     '{"en":"Box braids"}'::jsonb,
     '{"en":"Protective box-braid install, sized to preference."}'::jsonb,
     180, 1500, true),
    (md5('seed:service:salon-habesha:henna')::uuid, md5('seed:biz:salon-habesha')::uuid,
     '{"en":"Natural henna hair treatment"}'::jsonb,
     '{"en":"Conditioning henna treatment for length and shine."}'::jsonb,
     90, 700, true),
    -- Sheger Barbers
    (md5('seed:service:barber-sheger:cut')::uuid, md5('seed:biz:barber-sheger')::uuid,
     '{"en":"Classic haircut"}'::jsonb,
     '{"en":"Scissors-and-clipper cut, wash included."}'::jsonb,
     30, 250, true),
    (md5('seed:service:barber-sheger:hot-shave')::uuid, md5('seed:biz:barber-sheger')::uuid,
     '{"en":"Hot-towel shave"}'::jsonb,
     '{"en":"Pre-shave oil, hot towel, straight razor, after-shave balm."}'::jsonb,
     30, 300, true),
    -- Lion's Mane
    (md5('seed:service:barber-lions-mane:fade')::uuid, md5('seed:biz:barber-lions-mane')::uuid,
     '{"en":"Skin fade"}'::jsonb,
     '{"en":"Bald or skin fade with clean line-up."}'::jsonb,
     30, 280, true),
    (md5('seed:service:barber-lions-mane:beard')::uuid, md5('seed:biz:barber-lions-mane')::uuid,
     '{"en":"Beard sculpt"}'::jsonb,
     NULL,
     20, 180, true),
    -- Tana Wellness
    (md5('seed:service:spa-tana:swedish')::uuid, md5('seed:biz:spa-tana')::uuid,
     '{"en":"Swedish massage (60 min)"}'::jsonb,
     '{"en":"Classic relaxation massage focusing on neck, shoulders, back, and legs."}'::jsonb,
     60, 1800, true),
    (md5('seed:service:spa-tana:hot-stone')::uuid, md5('seed:biz:spa-tana')::uuid,
     '{"en":"Hot-stone therapy (90 min)"}'::jsonb,
     '{"en":"Volcanic-stone heat treatment combined with deep-tissue massage."}'::jsonb,
     90, 2600, true),
    -- Entoto Retreat
    (md5('seed:service:spa-entoto:aroma')::uuid, md5('seed:biz:spa-entoto')::uuid,
     '{"en":"Aromatherapy massage"}'::jsonb,
     '{"en":"Lavender-or-eucalyptus essential-oil massage in a private suite."}'::jsonb,
     75, 2000, true),
    (md5('seed:service:spa-entoto:facial')::uuid, md5('seed:biz:spa-entoto')::uuid,
     '{"en":"Signature facial"}'::jsonb,
     '{"en":"Cleanse, exfoliate, mask, and moisturize for all skin types."}'::jsonb,
     60, 1400, true),
    -- Hana Henna Studio
    (md5('seed:service:beauty-henna:bridal')::uuid, md5('seed:biz:beauty-henna')::uuid,
     '{"en":"Bridal henna (hands + forearms)"}'::jsonb,
     '{"en":"Custom bridal henna design. Price scales with detail; quote at consultation."}'::jsonb,
     150, NULL, true),
    (md5('seed:service:beauty-henna:party')::uuid, md5('seed:biz:beauty-henna')::uuid,
     '{"en":"Party henna (one hand)"}'::jsonb,
     '{"en":"Twenty-minute single-hand design for parties and events."}'::jsonb,
     30, 350, true),
    -- Selam Brows & Lashes
    (md5('seed:service:beauty-brows:lamination')::uuid, md5('seed:biz:beauty-brows')::uuid,
     '{"en":"Brow lamination + tint"}'::jsonb,
     '{"en":"Brow shaping with lamination and complementary tint."}'::jsonb,
     45, 900, true),
    (md5('seed:service:beauty-brows:lashes')::uuid, md5('seed:biz:beauty-brows')::uuid,
     '{"en":"Classic lash extensions"}'::jsonb,
     '{"en":"One-to-one classic-set extensions."}'::jsonb,
     120, 2000, true)
ON CONFLICT (id) DO UPDATE
    SET business_id      = EXCLUDED.business_id,
        name             = EXCLUDED.name,
        description      = EXCLUDED.description,
        duration_minutes = EXCLUDED.duration_minutes,
        price_etb        = EXCLUDED.price_etb,
        is_active        = EXCLUDED.is_active;

-- ---------------------------------------------------------------------------
-- 4. staff_members — one per business, active.
-- ---------------------------------------------------------------------------

INSERT INTO staff_members (id, business_id, display_name, role, is_active)
VALUES
    (md5('seed:staff:salon-sunset:hana')::uuid,        md5('seed:biz:salon-sunset')::uuid,        'Hana Bekele',     'Senior Stylist',  true),
    (md5('seed:staff:salon-habesha:marta')::uuid,      md5('seed:biz:salon-habesha')::uuid,       'Marta Tesfaye',   'Braiding Artist', true),
    (md5('seed:staff:barber-sheger:abebe')::uuid,      md5('seed:biz:barber-sheger')::uuid,       'Abebe Kebede',    'Master Barber',   true),
    (md5('seed:staff:barber-lions-mane:dawit')::uuid,  md5('seed:biz:barber-lions-mane')::uuid,   'Dawit Mengistu',  'Barber',          true),
    (md5('seed:staff:spa-tana:meron')::uuid,           md5('seed:biz:spa-tana')::uuid,            'Meron Alemu',     'Massage Therapist', true),
    (md5('seed:staff:spa-entoto:samuel')::uuid,        md5('seed:biz:spa-entoto')::uuid,          'Samuel Tilahun',  'Spa Therapist',   true),
    (md5('seed:staff:beauty-henna:hana')::uuid,        md5('seed:biz:beauty-henna')::uuid,        'Hana Solomon',    'Henna Artist',    true),
    (md5('seed:staff:beauty-brows:selam')::uuid,       md5('seed:biz:beauty-brows')::uuid,        'Selam Girma',     'Brow & Lash Artist', true)
ON CONFLICT (id) DO UPDATE
    SET business_id  = EXCLUDED.business_id,
        display_name = EXCLUDED.display_name,
        role         = EXCLUDED.role,
        is_active    = EXCLUDED.is_active;

-- ---------------------------------------------------------------------------
-- 5. staff_availability — Mon–Sat 09:00-18:00 per staff member.
-- ---------------------------------------------------------------------------
--
-- weekday convention: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
-- (matches the table CHECK + the Phase 3 slot computer in
-- availabilityService). Sundays are deliberately closed for the
-- seed shape — bookable Sundays land as overrides in a later test
-- if needed.
--
-- We use a CROSS JOIN against generate_series(1,6) to keep the file
-- compact: six rows per staff, eight staff = 48 inserted rows.

INSERT INTO staff_availability (id, staff_id, kind, weekday, specific_date, start_time, end_time, is_closed)
SELECT
    md5('seed:avail:' || s.staff_id::text || ':' || wd::text)::uuid,
    s.staff_id,
    'WEEKLY',
    wd,
    NULL,
    '09:00'::time,
    '18:00'::time,
    false
FROM (
    VALUES
        (md5('seed:staff:salon-sunset:hana')::uuid),
        (md5('seed:staff:salon-habesha:marta')::uuid),
        (md5('seed:staff:barber-sheger:abebe')::uuid),
        (md5('seed:staff:barber-lions-mane:dawit')::uuid),
        (md5('seed:staff:spa-tana:meron')::uuid),
        (md5('seed:staff:spa-entoto:samuel')::uuid),
        (md5('seed:staff:beauty-henna:hana')::uuid),
        (md5('seed:staff:beauty-brows:selam')::uuid)
) AS s(staff_id)
CROSS JOIN generate_series(1, 6) AS wd
ON CONFLICT (id) DO UPDATE
    SET staff_id      = EXCLUDED.staff_id,
        kind          = EXCLUDED.kind,
        weekday       = EXCLUDED.weekday,
        specific_date = EXCLUDED.specific_date,
        start_time    = EXCLUDED.start_time,
        end_time      = EXCLUDED.end_time,
        is_closed     = EXCLUDED.is_closed;

COMMIT;
