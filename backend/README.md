# EthioLink Backend

AWS Lambda + API Gateway + RDS PostgreSQL. Node.js 20, TypeScript.

## Layout

```
backend/
  lambdas/    Lambda handlers (entrypoints — thin)
  api/        OpenAPI document
  db/
    migrations/   Forward-only SQL migrations
    seeds/        Seed data (categories, etc.)
  shared/
    config/         loadConfig()
    logging/        structured logger
    db/             pg client + base repository
    adapters/       AWS adapters (auth, storage, payments, notifications)
    domains/        domain services and repositories
  tests/      unit + integration tests
```

## Current state (Phase 6 — backend)

The following are wired up:

- `npm run db:migrate` — applies migrations 0001–0013 via `db/migrate.mjs`. Migrations 0009–0011 (appointments, reviews, payment_intents), 0012 (admin_actions), and 0013 (notification_logs) are authored and applied against local docker-compose Postgres. The same migrations against an AWS-hosted dev RDS instance are gated on Phase 7 (the dev Terraform stack currently provisions only Cognito).
- `npm run db:seed` — applies seeds (currently the four MVP categories) via `db/seed.mjs`.
- `npm test` — Node test runner via `tsx`. Suite covers Phase 1 (`UserService` + `loadConfig`), Phase 2 (`BusinessService` / `MediaService` / `CategoryService`), Phase 3 (`services`, `staff`, `availabilityService`, `slotComputer`, `slotService`), Phase 4 (`appointmentStateMachine`, `appointmentService`, `paymentGateways`, `reviewService`), Phase 5 backend (`adminBusinessService`, `adminUserService`, `adminCategoryService`), and Phase 6 (`notificationGateways`, `templateRegistry`, `notificationService`, `sendReminders`, plus a lifecycle-notification describe block on `appointmentService`). All use in-memory fakes — no Postgres required.

The React admin app under `admin/` is fully wired through Phase 6 — every admin endpoint listed below has a corresponding page, including the new `/notifications` troubleshooting surface.

`npm run build` and `npm run lint` are still Phase 0 placeholders.

### Endpoints implemented

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |
| POST   | `/v1/auth/sync`             | yes | Sync Cognito user → `users`. Idempotent. |
| GET    | `/v1/me`                    | yes | Get caller's user profile. |
| PATCH  | `/v1/me`                    | yes | Update `displayName`. |
| GET    | `/v1/categories`            | no  | Active categories, sorted. |
| GET    | `/v1/businesses`            | no  | APPROVED listing with filters + cursor pagination. |
| GET    | `/v1/businesses/{id}`       | no  | APPROVED detail. |
| POST   | `/v1/businesses`            | yes | Create DRAFT. Requires `BUSINESS_OWNER` role. |
| PATCH  | `/v1/businesses/{id}`       | yes | Owner-only edit (admin path lands in Phase 5). |
| POST   | `/v1/businesses/{id}/submit`| yes | DRAFT → PENDING_REVIEW. |
| GET    | `/v1/me/business`           | yes | Owner-view of own business at any status. |
| POST   | `/v1/media/upload-url`      | yes | Presigned S3 PUT URL. Owner-row-level auth in service. |
| POST   | `/v1/media`                 | yes | Confirm upload, persist `media_assets` row. |
| GET    | `/v1/businesses/{businessId}/services`               | no  | Active services for a business. |
| POST   | `/v1/businesses/{businessId}/services`               | yes | Create service. `BUSINESS_OWNER`, owner-of-business. |
| PATCH  | `/v1/businesses/{businessId}/services/{id}`          | yes | Edit service. Owner-only (admin path in Phase 5). |
| DELETE | `/v1/businesses/{businessId}/services/{id}`          | yes | Soft-delete (`is_active=false`). Owner-only. |
| GET    | `/v1/businesses/{businessId}/staff`                  | no  | Active staff for a business. |
| POST   | `/v1/businesses/{businessId}/staff`                  | yes | Create staff member. Owner-only. |
| PATCH  | `/v1/businesses/{businessId}/staff/{id}`             | yes | Edit staff. Owner-only. |
| DELETE | `/v1/businesses/{businessId}/staff/{id}`             | yes | Soft-delete staff. Owner-only. |
| GET    | `/v1/businesses/{businessId}/staff/{staffId}/availability`           | no  | Weekly schedule + overrides. |
| PUT    | `/v1/businesses/{businessId}/staff/{staffId}/availability`           | yes | Replace weekly schedule (strict 7-day). Owner-only. |
| POST   | `/v1/businesses/{businessId}/staff/{staffId}/availability/override`  | yes | Add a date-specific override. Owner-only. |
| GET    | `/v1/businesses/{businessId}/staff/{staffId}/slots`                  | no  | Computed bookable slots. UTC ISO timestamps. |
| POST   | `/v1/appointments`                                                   | yes | `CUSTOMER`-only. Creates REQUESTED row, snapshots `price_etb`, authorizes payment. Cash succeeds; `ONLINE_PENDING` → 400 `ONLINE_PAYMENTS_UNAVAILABLE`. |
| GET    | `/v1/me/appointments`                                                | yes | Caller's customer-side bookings. Filters: `status`, `from`, `to`. |
| GET    | `/v1/businesses/{businessId}/appointments`                           | yes | Business-side listing. Owner-or-`ADMIN` (enforced by service). |
| POST   | `/v1/appointments/{id}/accept`                                       | yes | REQUESTED → ACCEPTED. Business owner or ADMIN. |
| POST   | `/v1/appointments/{id}/reject`                                       | yes | REQUESTED → REJECTED. Optional `reason` is logged but not persisted in MVP. |
| POST   | `/v1/appointments/{id}/cancel`                                       | yes | ACCEPTED/REQUESTED → CANCELLED. Customer (subject to `BOOKING_CANCEL_CUTOFF_MINUTES`), business owner, or ADMIN. |
| POST   | `/v1/appointments/{id}/reschedule`                                   | yes | Customer-only. Re-validates the new slot; ACCEPTED rows reset to REQUESTED. |
| POST   | `/v1/appointments/{id}/complete`                                     | yes | ACCEPTED → COMPLETED. Business owner or ADMIN. |
| POST   | `/v1/appointments/{id}/review`                                       | yes | `CUSTOMER`-only. Requires `COMPLETED` appointment; one review per appointment. Refreshes `rating_avg` / `rating_count`. |
| GET    | `/v1/businesses/{id}/reviews`                                        | no  | Public listing of non-deleted reviews, newest-first. |
| GET    | `/v1/admin/businesses`                                               | yes | `ADMIN`-only. Cross-status listing with optional `status` filter + limit. |
| POST   | `/v1/admin/businesses/{id}/approve`                                  | yes | `ADMIN`-only. PENDING_REVIEW → APPROVED + `APPROVE_BUSINESS` audit row. |
| POST   | `/v1/admin/businesses/{id}/reject`                                   | yes | `ADMIN`-only. PENDING_REVIEW → REJECTED + `REJECT_BUSINESS` audit row (notes are the canonical rejection-reason store). |
| POST   | `/v1/admin/businesses/{id}/suspend`                                  | yes | `ADMIN`-only. APPROVED or PENDING_REVIEW → SUSPENDED + `SUSPEND_BUSINESS` audit row. |
| POST   | `/v1/admin/businesses/{id}/feature`                                  | yes | `ADMIN`-only. Set / clear `featured_until` on an APPROVED business; emits `FEATURE_BUSINESS` or `UNFEATURE_BUSINESS`. |
| GET    | `/v1/admin/users`                                                    | yes | `ADMIN`-only. Cross-status / cross-role listing with optional filters. Returns `AdminUserView` (adds `status`). |
| POST   | `/v1/admin/users/{id}/suspend`                                       | yes | `ADMIN`-only. ACTIVE → SUSPENDED + `SUSPEND_USER` audit row. |
| POST   | `/v1/admin/users/{id}/restore`                                       | yes | `ADMIN`-only. SUSPENDED → ACTIVE + `RESTORE_USER` audit row. DELETED is terminal. |
| GET    | `/v1/admin/categories`                                               | yes | `ADMIN`-only. Lists active + deactivated rows with optional `isActive` filter. Returns `AdminCategoryView` (adds `isActive`). |
| POST   | `/v1/admin/categories`                                               | yes | `ADMIN`-only. Create a category + `CREATE_CATEGORY` audit row. Slug uniqueness enforced. |
| PATCH  | `/v1/admin/categories/{id}`                                          | yes | `ADMIN`-only. Patch a category + `UPDATE_CATEGORY` audit row. No-op empty patch still records intent. |
| DELETE | `/v1/admin/categories/{id}`                                          | yes | `ADMIN`-only. **Soft-delete** — flips `is_active` to `false` + `DEACTIVATE_CATEGORY` audit row. Already-inactive → 409. |
| GET    | `/v1/admin/appointments`                                             | yes | `ADMIN`-only cross-business listing. Filters: `status`, `businessId`, `customerId`, `from`, `to`, `limit`. Read-only; no audit row. |
| GET    | `/v1/admin/notifications`                                            | yes | `ADMIN`-only cross-channel listing of `notification_logs`. Filters: `status`, `channel`, `recipientUserId`, `from`, `to`, `limit` (1..100, default 100). Read-only; no audit row. |

See `api/openapi.yaml` for the full contract.

### Notification dispatch prerequisites

Phase 6 introduces a `NotificationService` dispatcher (`backend/shared/domains/notifications/notificationService.ts`) composed by every appointment-mutation Lambda. Each successful create / accept / reject / cancel / reschedule fires exactly one notification through the dispatcher; `complete` is intentionally silent in MVP. The MVP wiring routes every notification through `MockNotificationGateway` (channel `MOCK`) — every dispatched row lands in `notification_logs` at status `SENT` with a `mock-<uuid>` `provider_ref`, no external calls made.

- **Best-effort error policy.** Provider failures land as `notification_logs.status = 'FAILED'` with `error_message` populated; the dispatcher catches the gateway-class exception and persists the row before returning normally. The appointment-service helpers (`notifyBusinessOwner` / `notifyCustomer`) also wrap the dispatcher in a try/catch and swallow anything that escapes — defense-in-depth against any non-gateway error class so a notification miss can never block a booking.
- **Reminder lambda.** `backend/lambdas/scheduled/sendReminders.ts` exposes a `ScheduledHandler` entry + a pure `runReminderBatch(deps)` core. Each invocation scans ACCEPTED appointments whose `starts_at` falls in `[now + 23h45m, now + 24h00m)` via the new `AppointmentsRepository.listForReminderWindow` query, then dispatches `booking.reminder.customer` to the customer and `booking.reminder.business` to the business owner. Idempotency is enforced by `NotificationLogRepository.existsForAppointmentSlot({ templateKey, recipientUserId, startsAtUtc })` — if a log row already exists at any status, the dispatch is skipped. The handler returns a `ReminderBatchSummary { scanned, sent, skipped, failed }`. The EventBridge rule that drives the 15-minute cadence is deferred to Phase 7; the Lambda is invocable today via `aws lambda invoke`.
- **Template registry.** `templateRegistry.ts` is the closed-union home for the eight MVP `BookingTemplateKey` values (`booking.requested.business`, `booking.accepted.customer`, `booking.rejected.customer`, `booking.cancelled.business`, `booking.cancelled.customer`, `booking.rescheduled.business`, `booking.reminder.customer`, `booking.reminder.business`). The repository layer keeps `template_key` permissive `string` so the registry can grow additively without a migration. Templates render against a shared `BookingTemplatePayload` shape; `startsAtUtc` is formatted in Addis Ababa local time via Luxon.

### Slot computation prerequisites

The `GET …/slots` handler depends on `BookingConfig` (`BOOKING_SLOT_STEP_MINUTES`, `BOOKING_BUFFER_MINUTES`, `DEFAULT_TIMEZONE`) which is surfaced through `loadConfig` with sane defaults (`15`, `5`, `Africa/Addis_Ababa`). Timezone math is done via [Luxon](https://moment.github.io/luxon/) — a new runtime dependency added in Phase 3 scoped to slot computation only.

Appointment-conflict filtering uses `PgAppointmentsRepository` against the `appointments` table (migration 0009). ACCEPTED, not-soft-deleted bookings for the staff member block any overlapping slot; REQUESTED rows do not block slot emission — the exclusion constraint catches a true double-book at insert time. `StubAppointmentsRepository` is retained as an in-memory seam for tests and local tooling that exercise slot computation without a database.

### Booking flow prerequisites

The Phase 4 endpoints compose `AppointmentService` (state machine + repository + slot validation + payment gateway routing) and `ReviewService`.

- **Double-booking** is prevented by an `EXCLUDE USING gist` constraint on `appointments` (migration 0009 + `btree_gist`): two active rows (`REQUESTED` or `ACCEPTED`) for the same staff member cannot have overlapping `[starts_at, ends_at)` ranges. Concurrent inserts produce SQLSTATE 23P01; the service translates to `AppointmentSlotUnavailableError` → 409 `SLOT_UNAVAILABLE`.
- **Payments** flow through a `PaymentGateway` port. `CashGateway` returns `SUCCEEDED` synchronously (no upstream call); `MockOnlineGateway` throws `OnlinePaymentsUnavailableError` (400 with `details.code: 'ONLINE_PAYMENTS_UNAVAILABLE'`). Real Telebirr / Chapa / CBE Birr providers slot behind the same port post-MVP.
- **Cancellation cutoff** is `BOOKING_CANCEL_CUTOFF_MINUTES` (default 240). Customer-initiated cancels inside the cutoff return 409 `CONFLICT`; business and admin cancellations bypass the cutoff.
- **Reviews** require an appointment in `COMPLETED` status. UNIQUE on `reviews.appointment_id` enforces one review per appointment; `business_profiles.rating_avg` / `rating_count` are recomputed from a fresh `AVG`/`COUNT` over reviews on each insert.
- **Migrations 0009–0011 apply is pending the next `terraform apply`.** Until then, the appointment / review handlers will fail at request time on missing tables — `npm test` exercises the in-memory paths.

### Admin backend prerequisites

Phase 5 ships the admin write surface. Every Phase 5 endpoint is guarded by `backend/lambdas/admin/_authz.ts`, which extracts the Cognito principal, refuses non-`ADMIN` roles with 403, and resolves the principal to an internal `users` row.

- **Audit log.** Every successful admin write persists exactly one row to `admin_actions` (migration 0012) — append-only, no `update` / `delete` paths in the repository. Failed writes (admin forbidden / not found / invalid transition / invalid input / slug taken) record zero rows. The audit row carries `adminUserId`, `action` (one of `APPROVE_BUSINESS` / `REJECT_BUSINESS` / `SUSPEND_BUSINESS` / `FEATURE_BUSINESS` / `UNFEATURE_BUSINESS` / `SUSPEND_USER` / `RESTORE_USER` / `CREATE_CATEGORY` / `UPDATE_CATEGORY` / `DEACTIVATE_CATEGORY`), `targetType` (`business_profile` / `user` / `business_category`), `targetId`, and the optional `notes` field from the request body.
- **Atomicity caveat.** The mutation and the audit-row insert run as two sequential statements — not yet wrapped in `withTransaction`. A small window exists where the mutation is committed but the audit row never lands. Documented in each admin service's header; the canonical fix threads a `PoolClient` through both repos and lands in a future commit alongside the matching change to the reviews-aggregate flow.
- **Admin write paths on services / staff / availability are still owner-only.** `API_SPEC.md` lists those as "owner or ADMIN" but the Phase 3 services / staff / availability services enforce strict-owner. Relaxing each is a one-line change (the Phase 5 follow-up list); deferred so the React admin app can ship first.

### S3 prerequisite for the media handlers

The media handlers construct `S3StorageGateway` at cold-start. They require `S3_BUCKET_MEDIA_PUBLIC` and `S3_BUCKET_MEDIA_PRIVATE` to be set; otherwise the handler fails to initialize with a `StorageError`. Other handlers (auth, business, category, etc.) work without S3 env vars set.

## Running locally

Prerequisites: Docker, Node.js 20+, and a clone of this repo.

1. Start Postgres in the background:

   ```bash
   docker-compose up -d
   ```

   This is the `docker-compose.yml` at the project root, not under `backend/`. It listens on `localhost:5432` with database `ethiolink` and user/password `ethiolink`/`ethiolink`.

2. Install backend dependencies:

   ```bash
   cd backend
   npm install
   ```

3. Apply migrations:

   ```bash
   npm run db:migrate
   ```

   Default connection parameters match docker-compose — no `.env` file is required for the happy path. To point at a different database, set the matching `PG_*` env vars before running (see `backend/.env.example`). The runner tracks applied migrations in a `schema_migrations` table; re-running is a no-op when nothing is new.

4. Apply seed data:

   ```bash
   npm run db:seed
   ```

   Runs every `.sql` file under `backend/db/seeds/` exactly once, tracked in a `schema_seeds` table. Currently this inserts the four MVP business categories (Salon, Barber, Spa, Beauty Professional). The seeds are written to be idempotent on their own (`INSERT ... ON CONFLICT`) and the runner additionally skips files that have already been applied — re-running is a fast no-op.

   Migrations and seeds are tracked independently. Use `npm run db:migrate` for schema changes and `npm run db:seed` for reference data; either can be re-run safely without the other.

To wipe the local database and start over:

```bash
docker-compose down -v   # drops the data volume
docker-compose up -d
npm run db:migrate
npm run db:seed
```

## Running tests

```bash
cd backend
npm install
npm test
```

Current suite (Phase 1 through Phase 6) covers:

- **Phase 1.** `UserService` — sync, idempotency, role mapping, get, update, missing-user. `loadConfig` — defaults, missing/invalid env vars, `PG_SSL` parsing.
- **Phase 2.** `BusinessService` — create, update, submit state machine, ownership, listing filters, cursor-pagination roundtrip, invalid-cursor handling. `MediaService` — content-type allowlist, owner-type matrix (BUSINESS / STAFF / USER), `isPublic` derivation, `confirmUpload` storage-key prefix check. `CategoryService` — listing order, active-only filter, getBySlug/getById hit + miss + inactive-row contract.
- **Phase 3.** `ServiceService`, `StaffService`, `AvailabilityService`, `slotComputer` (pure-function matrix over weekly + override + conflicts + buffer + 24:00 sentinel + timezone math), `SlotService` orchestrator.
- **Phase 4.** `appointmentStateMachine` (matrix walk + terminal sealing + integrity), `AppointmentService` (cash create / online → typed error / slot misalignment / 23P01 race-loss / accept / reject / complete / cancel cutoff matrix / reschedule resets / non-owner), `paymentGateways` (CashGateway SUCCEEDED + MockOnlineGateway throws `ONLINE_PAYMENTS_UNAVAILABLE`), `ReviewService` (happy path + recompute trigger + four typed errors + 23505 race-loss + rating validation matrix + listing soft-delete filter + limit).
- **Phase 5 backend.** `AdminBusinessService` (approve / reject / suspend / setFeaturedUntil happy paths + audit-row contents + auth matrix + invalid-transition matrix + audit invariant), `AdminUserService` (suspend / restore + DELETED-is-terminal + auth + not-found + audit invariant), `AdminCategoryService` (create / update with no-op-still-records-audit / deactivate + slug-uniqueness pre-check on create + cross-row on update + 16-case invalid-input matrix + auth + audit invariant).
- **Phase 6.** `notificationGateways` (MockNotificationGateway always-SENT contract + SMS/Telegram stubs throw `NotificationProviderNotConfiguredError` with the stable `code`), `templateRegistry` (eight closed-union booking template keys + null-fallbacks + Addis-Ababa local-time formatting + `UnknownTemplateKeyError`), `notificationService` (happy path + provider FAILED persisted + `NotificationGatewayError` swallowed + non-provider error re-thrown after best-effort FAILED mark + `UnknownTemplateKeyError` / `NotificationRecipientNotFoundError` / `NoGatewayForChannelError` surface without writing a log row), `sendReminders` (happy path → 2 sent, idempotent second run → 2 skipped, too-early / too-late window boundaries, REQUESTED / CANCELLED / COMPLETED status filter, orphan business → `failed: 2`, partial pre-existing ledger → 1 sent + 1 skipped), and a `AppointmentService — booking lifecycle notifications` describe block (create / accept / reject / CUSTOMER cancel / BUSINESS cancel / ADMIN cancel / CUSTOMER reschedule fan-outs + `complete` produces no notification + swallow-on-dispatch-failure).

All using in-memory fakes — no Postgres required.
