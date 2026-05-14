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

## Current state (Phase 2)

The following are wired up:

- `npm run db:migrate` — applies migrations 0001–0005 via `db/migrate.mjs`.
- `npm run db:seed` — applies seeds (currently the four MVP categories) via `db/seed.mjs`.
- `npm test` — Node test runner via `tsx`. Current suite covers Phase 1's `UserService` and `loadConfig`; Phase 2 domain tests (`business`, `media`, `category`) are queued for a follow-up commit.

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

See `api/openapi.yaml` for the full contract.

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

The Phase 1 suite covers `UserService` (sync, idempotency, role mapping, get, update, missing-user) and `loadConfig` (defaults, missing/invalid env vars, `PG_SSL` parsing) using an in-memory `UserRepository` fake — no Postgres required.
