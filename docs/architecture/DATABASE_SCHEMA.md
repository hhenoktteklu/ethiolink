# Database Schema

PostgreSQL 15 on Amazon RDS. All schema changes go through versioned SQL migrations in `backend/db/migrations/`. Do not modify production schema outside of migrations.

## Conventions

- `id` columns are `uuid` (generated with `gen_random_uuid()`, requires `pgcrypto`).
- All tables include `created_at` and `updated_at` (`timestamptz`, default `now()`).
- Soft-delete via `deleted_at timestamptz NULL` only where retention is required (`appointments`, `reviews`, `media_assets`). Most tables use hard delete.
- Foreign keys are always `ON DELETE` declared explicitly — no defaults.
- Monetary values are `numeric(12, 2)` representing ETB.
- Multilingual text fields are JSONB keyed by language code: `{"en": "...", "am": "..."}`. MVP writes only `en`.
- Enum-like fields use Postgres `CHECK` constraints, not `ENUM` types, to keep migrations cheap.

## Tables

### `users`

Mirror of Cognito identities. One row per authenticated principal across all roles.

| column            | type           | notes                                                       |
| ----------------- | -------------- | ----------------------------------------------------------- |
| id                | uuid PK        |                                                             |
| cognito_sub       | text UNIQUE    | Cognito user `sub`                                          |
| email             | citext         | nullable if user signed up with phone                       |
| phone             | text           | E.164                                                       |
| role              | text NOT NULL  | CHECK in ('CUSTOMER','BUSINESS_OWNER','ADMIN')              |
| status            | text NOT NULL  | CHECK in ('ACTIVE','SUSPENDED','DELETED'), default 'ACTIVE' |
| display_name      | text           |                                                             |
| telegram_chat_id  | text           | nullable; set via the Telegram linking flow (Phase 9 Track 2, migration 0014). Partial index on `id WHERE telegram_chat_id IS NOT NULL` |
| locale            | text NOT NULL  | CHECK in ('en','am'), default `'en'`. Phase 9 Track 5 (migration 0016). Mutable through `PATCH /v1/me`. Drives the Flutter UI locale + the notification template registry's per-locale renderer lookup (English fallback when an Amharic renderer isn't registered yet). |
| created_at        | timestamptz    |                                                             |
| updated_at        | timestamptz    |                                                             |

### `users_telegram_link_codes`

Short-lived single-use codes for the Telegram bot linking flow (Phase 9 Track 2, migration 0015). Created by `POST /v1/me/link-telegram/start`, deleted by the bot webhook on `/start <code>` redemption or by a daily sweep job after expiry.

| column      | type        | notes                                                |
| ----------- | ----------- | ---------------------------------------------------- |
| code        | text PK     | opaque random base32 token (32 chars by default)     |
| user_id     | uuid FK     | -> users.id ON DELETE CASCADE                        |
| expires_at  | timestamptz | NOT NULL; default TTL 10 minutes (env-configurable)  |
| created_at  | timestamptz |                                                      |

Indexes: `(user_id)` for the per-user invalidate path; `(expires_at)` for the sweep predicate.

### `customer_profiles`

| column           | type        | notes                                  |
| ---------------- | ----------- | -------------------------------------- |
| id               | uuid PK     |                                        |
| user_id          | uuid FK     | -> users.id ON DELETE CASCADE, UNIQUE  |
| preferred_city   | text        |                                        |
| created_at       | timestamptz |                                        |
| updated_at       | timestamptz |                                        |

### `business_categories`

Marketplace categories. Beauty-related entries only in MVP.

| column      | type        | notes                                       |
| ----------- | ----------- | ------------------------------------------- |
| id          | uuid PK     |                                             |
| slug        | text UNIQUE | machine-friendly key, e.g. `salon`          |
| name        | jsonb       | localized                                   |
| sort_order  | int         |                                             |
| is_active   | bool        | default true                                |
| created_at  | timestamptz |                                             |
| updated_at  | timestamptz |                                             |

### `business_profiles`

| column          | type        | notes                                                                                  |
| --------------- | ----------- | -------------------------------------------------------------------------------------- |
| id              | uuid PK     |                                                                                        |
| owner_user_id   | uuid FK     | -> users.id ON DELETE RESTRICT                                                         |
| category_id     | uuid FK     | -> business_categories.id ON DELETE RESTRICT                                           |
| name            | text        |                                                                                        |
| description     | jsonb       | localized                                                                              |
| city            | text        |                                                                                        |
| address_line    | text        |                                                                                        |
| latitude        | double precision |                                                                                   |
| longitude       | double precision |                                                                                   |
| phone           | text        |                                                                                        |
| telegram_handle | text        |                                                                                        |
| whatsapp_phone  | text        |                                                                                        |
| status          | text        | CHECK in ('DRAFT','PENDING_REVIEW','APPROVED','REJECTED','SUSPENDED'), default 'DRAFT' |
| featured_until  | timestamptz | nullable; admin-set                                                                    |
| rating_avg      | numeric(3,2)| denormalized                                                                           |
| rating_count    | int         | denormalized                                                                           |
| created_at      | timestamptz |                                                                                        |
| updated_at      | timestamptz |                                                                                        |

Indexes: `(status)`, `(category_id, status)`, `(city, status)`. Phase 9 Track 6 (migration 0017) adds a generated `search_tsv tsvector` column populated from `setweight(to_tsvector('simple', unaccent(name)), 'A') || setweight(to_tsvector('simple', unaccent(description->>'en')), 'B') || setweight(to_tsvector('simple', unaccent(description->>'am')), 'B')` with a GIN index `business_profiles_search_tsv_gin` for `GET /v1/businesses?q=...`, plus a trigram-indexed `gin_trgm_ops` index on `lower(name)` (`business_profiles_name_trgm`) used as a fallback for short-prefix matches the tsvector path won't catch. Both `pg_trgm` and `unaccent` extensions enabled by the same migration; an `ethiolink_unaccent_immutable` SQL wrapper makes `unaccent` usable inside a generated column expression. The wider-shape full-text search is documented in `API_SPEC.md` under `GET /v1/businesses`.

### `services`

| column            | type        | notes                                              |
| ----------------- | ----------- | -------------------------------------------------- |
| id                | uuid PK     |                                                    |
| business_id       | uuid FK     | -> business_profiles.id ON DELETE CASCADE          |
| name              | jsonb       | localized                                          |
| description       | jsonb       | localized                                          |
| duration_minutes  | int         | CHECK > 0                                          |
| price_etb         | numeric(12,2)|                                                   |
| is_active         | bool        | default true                                       |
| created_at        | timestamptz |                                                    |
| updated_at        | timestamptz |                                                    |

### `staff_members`

| column        | type        | notes                                              |
| ------------- | ----------- | -------------------------------------------------- |
| id            | uuid PK     |                                                    |
| business_id   | uuid FK     | -> business_profiles.id ON DELETE CASCADE          |
| display_name  | text        |                                                    |
| role          | text        | free-text role title (e.g., "Stylist")             |
| is_active     | bool        | default true                                       |
| created_at    | timestamptz |                                                    |
| updated_at    | timestamptz |                                                    |

### `staff_availability`

Weekly recurring availability plus date-specific overrides.

| column        | type        | notes                                                                                |
| ------------- | ----------- | ------------------------------------------------------------------------------------ |
| id            | uuid PK     |                                                                                      |
| staff_id      | uuid FK     | -> staff_members.id ON DELETE CASCADE                                                |
| kind          | text        | CHECK in ('WEEKLY','OVERRIDE')                                                       |
| weekday       | int         | 0..6, NULL for OVERRIDE                                                              |
| specific_date | date        | NULL for WEEKLY                                                                      |
| start_time    | time        |                                                                                      |
| end_time      | time        | CHECK end_time > start_time                                                          |
| is_closed     | bool        | true means staff is unavailable in this window (used for OVERRIDE blackouts)         |
| created_at    | timestamptz |                                                                                      |

### `appointments`

| column          | type        | notes                                                                                       |
| --------------- | ----------- | ------------------------------------------------------------------------------------------- |
| id              | uuid PK     |                                                                                             |
| customer_id     | uuid FK     | -> users.id ON DELETE RESTRICT                                                              |
| business_id     | uuid FK     | -> business_profiles.id ON DELETE RESTRICT                                                  |
| service_id      | uuid FK     | -> services.id ON DELETE RESTRICT                                                           |
| staff_id        | uuid FK     | -> staff_members.id ON DELETE RESTRICT                                                      |
| starts_at       | timestamptz |                                                                                             |
| ends_at         | timestamptz |                                                                                             |
| status          | text        | CHECK in ('REQUESTED','ACCEPTED','REJECTED','CANCELLED','COMPLETED','NO_SHOW')              |
| payment_method  | text        | CHECK in ('CASH','ONLINE_PENDING')                                                          |
| price_etb       | numeric(12,2)| snapshotted at booking time                                                                |
| notes           | text        |                                                                                             |
| cancelled_by    | text        | CHECK in ('CUSTOMER','BUSINESS','ADMIN') nullable                                           |
| cancel_reason   | text        |                                                                                             |
| created_at      | timestamptz |                                                                                             |
| updated_at      | timestamptz |                                                                                             |
| deleted_at      | timestamptz |                                                                                             |

Indexes: `(business_id, starts_at)`, `(customer_id, starts_at)`, `(staff_id, starts_at)`, `(status)`.

### `reviews`

| column         | type        | notes                                                                                |
| -------------- | ----------- | ------------------------------------------------------------------------------------ |
| id             | uuid PK     |                                                                                      |
| appointment_id | uuid FK     | -> appointments.id ON DELETE RESTRICT, UNIQUE — one review per completed appointment |
| customer_id    | uuid FK     | -> users.id ON DELETE RESTRICT                                                       |
| business_id    | uuid FK     | -> business_profiles.id ON DELETE RESTRICT                                           |
| rating         | int         | CHECK 1..5                                                                           |
| comment        | text        |                                                                                      |
| created_at     | timestamptz |                                                                                      |
| updated_at     | timestamptz |                                                                                      |
| deleted_at     | timestamptz |                                                                                      |

### `media_assets`

| column        | type        | notes                                                                                |
| ------------- | ----------- | ------------------------------------------------------------------------------------ |
| id            | uuid PK     |                                                                                      |
| owner_type    | text        | CHECK in ('BUSINESS','STAFF','USER')                                                 |
| owner_id      | uuid        | logical FK, validated in service layer                                               |
| s3_key        | text UNIQUE |                                                                                      |
| content_type  | text        |                                                                                      |
| width         | int         |                                                                                      |
| height        | int         |                                                                                      |
| is_public     | bool        | default false                                                                        |
| created_at    | timestamptz |                                                                                      |
| deleted_at    | timestamptz |                                                                                      |

### `admin_actions`

Audit log for admin operations.

| column         | type        | notes                                                                       |
| -------------- | ----------- | --------------------------------------------------------------------------- |
| id             | uuid PK     |                                                                             |
| admin_user_id  | uuid FK     | -> users.id ON DELETE RESTRICT                                              |
| action         | text        | e.g. 'APPROVE_BUSINESS', 'REJECT_BUSINESS', 'FEATURE_BUSINESS'              |
| target_type    | text        | e.g. 'business_profile', 'user'                                             |
| target_id      | uuid        |                                                                             |
| notes          | text        |                                                                             |
| created_at     | timestamptz |                                                                             |

### `payment_intents`

Placeholder table for the future online-payment flow. Cash bookings do not write here. Phase 9 Track 6 (migration 0018) widens this table so a row can attach to either an appointment OR a paid featuring subscription — see the `target` XOR CHECK below.

| column                       | type          | notes                                                                                |
| ---------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| id                           | uuid PK       |                                                                                      |
| appointment_id               | uuid FK       | -> appointments.id ON DELETE CASCADE; **nullable** (Phase 9 Track 6 — was NOT NULL pre-0018) |
| featuring_subscription_id    | uuid FK       | -> featuring_subscriptions.id ON DELETE CASCADE; nullable. **Phase 9 Track 6 (migration 0018)**. |
| provider                     | text          | CHECK in ('MOCK','TELEBIRR','CHAPA','CBE_BIRR'), default 'MOCK'                       |
| amount_etb                   | numeric(12,2) |                                                                                      |
| status                       | text          | CHECK in ('PENDING','SUCCEEDED','FAILED','CANCELLED'), default 'PENDING'             |
| provider_ref                 | text          | external reference                                                                   |
| raw_response                 | jsonb         |                                                                                      |
| created_at                   | timestamptz   |                                                                                      |
| updated_at                   | timestamptz   |                                                                                      |

Constraint (Phase 9 Track 6): `payment_intents_target_xor` — `(appointment_id IS NULL) <> (featuring_subscription_id IS NULL)` — exactly one of the two FKs must be set per row. Indexes: `(appointment_id, created_at DESC)` (existing) for booking-side reads; `(featuring_subscription_id, created_at DESC)` (new in 0018) for featuring-side reads.

Phase 10 — migration 0019 adds `payment_intents_provider_ref_uniq`, a `UNIQUE` partial index on `provider_ref WHERE provider_ref IS NOT NULL`. The Chapa webhook handler (Phase 10 commit 3) receives a callback carrying the upstream `tx_ref` and looks up the matching row via this index. The uniqueness constraint blocks `provider_ref` collisions across providers (Chapa, future Telebirr) and catches webhook-replay-against-fresh-transaction bugs at the database layer. Cash bookings never write to `payment_intents` and are unaffected; the partial scope avoids rejecting rows with NULL `provider_ref` (PENDING rows pre-upstream-call, or future provider-less rows).

### `featuring_subscriptions`

**Phase 9 Track 6 (migration 0018)**. Tracks each paid or comped featuring slot for a business. The customer-side discovery surface still reads `business_profiles.featured_until` as the single derived signal; the daily sweep Lambda projects `MAX(ends_at) WHERE status='ACTIVE'` into that column.

| column                | type          | notes                                                                                       |
| --------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| id                    | uuid PK       |                                                                                             |
| business_id           | uuid FK       | -> business_profiles.id ON DELETE CASCADE                                                   |
| package_code          | text          | CHECK in ('FEATURING_7D','FEATURING_30D')                                                   |
| price_etb             | numeric(12,2) | CHECK >= 0. 0 for `ADMIN_COMP` rows.                                                         |
| starts_at             | timestamptz   |                                                                                             |
| ends_at               | timestamptz   | CHECK > starts_at                                                                            |
| status                | text          | CHECK in ('PENDING_PAYMENT','ACTIVE','EXPIRED','CANCELLED','REFUNDED'), default 'PENDING_PAYMENT' |
| source                | text          | CHECK in ('OWNER_PURCHASE','ADMIN_COMP'), default 'OWNER_PURCHASE'                            |
| cancelled_at          | timestamptz   | nullable; set on transition to CANCELLED                                                    |
| cancelled_reason      | text          | nullable; admin-supplied free-text                                                          |
| created_by_user_id    | uuid FK       | -> users.id ON DELETE RESTRICT. The owner (for `OWNER_PURCHASE`) or the admin (for `ADMIN_COMP`). |
| created_at            | timestamptz   |                                                                                             |
| updated_at            | timestamptz   |                                                                                             |

Indexes: partial unique `(business_id) WHERE status='ACTIVE'` (one active subscription per business); `(status, ends_at)` for the sweep Lambda; `(business_id, created_at DESC)` for owner / admin history reads. Standard `set_updated_at` trigger.

### `notification_logs`

Persisted record of outbound notifications.

| column          | type        | notes                                                                                       |
| --------------- | ----------- | ------------------------------------------------------------------------------------------- |
| id              | uuid PK     |                                                                                             |
| recipient_user_id| uuid FK    | -> users.id ON DELETE SET NULL                                                              |
| channel         | text        | CHECK in ('SMS','EMAIL','TELEGRAM','PUSH','MOCK')                                           |
| template_key    | text        | logical template name, e.g. 'booking.confirmation.customer'                                  |
| payload         | jsonb       | template variables                                                                          |
| status          | text        | CHECK in ('QUEUED','SENT','DELIVERED','FAILED')                                             |
| provider        | text        | actual provider used                                                                        |
| provider_ref    | text        |                                                                                             |
| error_message   | text        |                                                                                             |
| created_at      | timestamptz |                                                                                             |
| updated_at      | timestamptz |                                                                                             |

## Migrations

Migrations are stored under `backend/db/migrations/` with the naming pattern `NNNN_description.sql`. Each migration is forward-only; rollbacks are handled by writing a new compensating migration.

The first migration (`0001_init.sql`) is created at the start of Phase 1 and creates the `pgcrypto` and `citext` extensions plus the `users` table.
