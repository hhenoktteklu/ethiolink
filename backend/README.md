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

## Current state (Phase 4)

The following are wired up:

- `npm run db:migrate` — applies migrations 0001–0011 via `db/migrate.mjs`. Migrations 0009–0011 (appointments, reviews, payment_intents) are authored and reviewed; the apply against the dev RDS instance is gated on the next `terraform apply` for the Phase 4 infrastructure tickets.
- `npm run db:seed` — applies seeds (currently the four MVP categories) via `db/seed.mjs`.
- `npm test` — Node test runner via `tsx`. Suite covers Phase 1 (`UserService` + `loadConfig`), Phase 2 (`BusinessService` / `MediaService` / `CategoryService`), Phase 3 (`services`, `staff`, `availabilityService`, `slotComputer`, `slotService`), and Phase 4 (`appointmentStateMachine`, `appointmentService`, `paymentGateways`, `reviewService`). All use in-memory fakes — no Postgres required.

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

See `api/openapi.yaml` for the full contract.

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

Current suite (Phase 1 through Phase 4) covers:

- **Phase 1.** `UserService` — sync, idempotency, role mapping, get, update, missing-user. `loadConfig` — defaults, missing/invalid env vars, `PG_SSL` parsing.
- **Phase 2.** `BusinessService` — create, update, submit state machine, ownership, listing filters, cursor-pagination roundtrip, invalid-cursor handling. `MediaService` — content-type allowlist, owner-type matrix (BUSINESS / STAFF / USER), `isPublic` derivation, `confirmUpload` storage-key prefix check. `CategoryService` — listing order, active-only filter, getBySlug/getById hit + miss + inactive-row contract.
- **Phase 3.** `ServiceService`, `StaffService`, `AvailabilityService`, `slotComputer` (pure-function matrix over weekly + override + conflicts + buffer + 24:00 sentinel + timezone math), `SlotService` orchestrator.
- **Phase 4.** `appointmentStateMachine` (matrix walk + terminal sealing + integrity), `AppointmentService` (cash create / online → typed error / slot misalignment / 23P01 race-loss / accept / reject / complete / cancel cutoff matrix / reschedule resets / non-owner), `paymentGateways` (CashGateway SUCCEEDED + MockOnlineGateway throws `ONLINE_PAYMENTS_UNAVAILABLE`), `ReviewService` (happy path + recompute trigger + four typed errors + 23505 race-loss + rating validation matrix + listing soft-delete filter + limit).

All using in-memory fakes — no Postgres required.
