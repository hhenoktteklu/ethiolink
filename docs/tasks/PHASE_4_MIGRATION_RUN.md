# Phase 4 — Dev migration run

Operational checklist for applying migrations **0009 (appointments)**, **0010 (reviews)**, and **0011 (payment_intents)** to the dev database. Ticking the last item on `PHASE_4_BOOKING.md` ("Migrations 0009–0011 applied to dev") depends on running this end-to-end exactly once and capturing the output.

## TL;DR

```bash
# 1. Bring up dev Postgres
docker-compose up -d

# 2. Install backend deps
cd backend
npm install

# 3. Apply all migrations (idempotent — already-applied ones are skipped)
npm run db:migrate

# 4. (Optional) re-seed categories — safe to skip if seeds already ran
npm run db:seed

# 5. Verify the three new tables exist
docker-compose exec postgres psql -U ethiolink -d ethiolink -c "\dt appointments reviews payment_intents"
```

That's it. **No AWS credentials and no `terraform apply` are required for this run** — see "Current state" below for why.

## Current state — "dev" means local

Today, the **dev database is the docker-compose Postgres on your laptop**, not a remote RDS instance. Two facts pin this down:

1. `infra/terraform/environments/dev/main.tf` only wires the **Cognito** module. RDS is listed in the file as `# Phase 2/7 will add: module "rds" ...` — there is no dev RDS in AWS yet.
2. `backend/db/migrate.mjs` says in its header: _"Production NOT in scope. AWS deployments will run migrations through a dedicated tool (or a one-shot Lambda) wired up later; this script is strictly the local-dev `npm run db:migrate` path."_

When the **remote dev RDS lands in Phase 7**, the same `npm run db:migrate` runner works against it by overriding the `PG_*` env vars (see the "Remote dev RDS (Phase 7+)" addendum at the bottom). The body of this checklist assumes the current "dev = local" state.

## Pre-flight

- [ ] You're on a branch with migrations `0009_appointments.sql`, `0010_reviews.sql`, and `0011_payment_intents.sql` present under `backend/db/migrations/`.
- [ ] Docker Desktop / engine is running.
- [ ] Node.js 20 or higher: `node --version`.
- [ ] The repo root is the working directory for `docker-compose`; `backend/` is the working directory for `npm` commands.

## Step 1 — Required AWS credentials

For the local migration run: **none required**.

The runner connects to `localhost:5432`. No AWS API calls happen.

(AWS credentials only become relevant for the optional `terraform apply` step in Step 2, which is itself optional today because nothing about the migrations depends on AWS resources.)

## Step 2 — Terraform apply (optional today)

- **Location**: `infra/terraform/environments/dev/`.
- **Why it's optional today**: the dev Terraform stack currently provisions only Cognito. The Cognito user pool created in Phase 1 is already in place; re-applying does nothing new for migrations 0009–0011. If your dev Cognito drifted (rare), run:
  ```bash
  cd infra/terraform/environments/dev
  terraform init      # one-time per machine
  terraform plan      # review
  terraform apply     # confirm
  ```
- **Required AWS credentials for the apply** (if you do run it): an IAM identity in the EthioLink AWS account with permission to read+write Cognito user pools. Export the usual `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` (or use `AWS_PROFILE`), with `AWS_REGION=eu-west-1`.
- **Expected Terraform outputs** (all Cognito-only, declared in `infra/terraform/environments/dev/main.tf`):
  - `cognito_user_pool_id`
  - `cognito_user_pool_arn`
  - `cognito_mobile_app_client_id`
  - `cognito_admin_app_client_id`
  - `cognito_hosted_ui_domain`

  None of these are needed by the migration runner; they're listed here because the question is part of the standard "before you migrate" checklist and they're what `terraform apply` will print.

## Step 3 — Backend env vars

For local docker-compose Postgres, the defaults in `backend/db/migrate.mjs` match the docker-compose service exactly, so **no env vars are required**. The runner connects as:

| Variable      | Default        | When to override                                        |
| ------------- | -------------- | ------------------------------------------------------- |
| `PG_HOST`     | `localhost`    | When pointing at a non-local Postgres.                  |
| `PG_PORT`     | `5432`         | When docker-compose maps a different host port.         |
| `PG_DATABASE` | `ethiolink`    | When running against a non-default database.            |
| `PG_USER`     | `ethiolink`    | When running against a non-default user.                |
| `PG_PASSWORD` | `ethiolink`    | When running against a non-default user.                |
| `PG_SSL`      | `false`        | Set to `true` for RDS (it requires TLS) — Phase 7.      |

To make the values explicit, copy `backend/.env.example` to `backend/.env`. The `migrate.mjs` runner reads from `process.env`, so any standard env-loading mechanism works.

## Step 4 — Bring up Postgres

```bash
# From repo root
docker-compose up -d
```

Confirm it's healthy:

```bash
docker-compose ps          # postgres should be "running"
docker-compose logs postgres | tail -20
```

If you need a clean slate (drops all data — be sure):

```bash
docker-compose down -v
docker-compose up -d
```

## Step 5 — `npm install` if needed

```bash
cd backend
npm install
```

Only required on a fresh clone, after `package.json` changes, or after switching branches that touch `package-lock.json`. The migrate runner depends on `pg` from the regular dependency set.

## Step 6 — `npm run db:migrate`

```bash
cd backend
npm run db:migrate
```

Expected behavior:

- The runner first applies migrations 0001–0008 if they aren't already in `schema_migrations` (typical first-time-on-branch flow).
- Then 0009 (appointments) — installs `btree_gist` extension, creates the table with the EXCLUDE constraint, four indexes, and the `updated_at` trigger.
- Then 0010 (reviews) — creates the table with UNIQUE on `appointment_id`, two indexes, and the trigger.
- Then 0011 (payment_intents) — creates the table, two indexes, and the trigger.
- Each successful file produces a single line: `Applied: NNNN_name.sql`.
- Final line: `Migrations complete.`

Re-running is a no-op: each already-applied migration is skipped silently.

## Step 7 — `npm run db:seed` if needed

```bash
cd backend
npm run db:seed
```

Only required on a **fresh** database (or after `docker-compose down -v`). Idempotent — skipped if the seed file is already in `schema_seeds`. Phase 4 doesn't ship new seeds; this step exists in the checklist because anyone who recreated their database in Step 4 needs to re-seed the four MVP categories.

## Step 8 — Verify migrations 0009–0011 applied

Three checks, in order of confidence:

### 8a. Runner-side ledger

```bash
docker-compose exec postgres psql -U ethiolink -d ethiolink -c \
  "SELECT version FROM schema_migrations ORDER BY version;"
```

Expected: rows include `0009_appointments`, `0010_reviews`, `0011_payment_intents`. (Exact format matches whatever Phase 1's migration runner records — typically the filename without `.sql`.)

### 8b. Tables exist with the right shape

```bash
docker-compose exec postgres psql -U ethiolink -d ethiolink -c \
  "\d appointments"
docker-compose exec postgres psql -U ethiolink -d ethiolink -c \
  "\d reviews"
docker-compose exec postgres psql -U ethiolink -d ethiolink -c \
  "\d payment_intents"
```

Sanity-spot-check:

- `appointments` lists an `EXCLUDE USING gist` constraint named `appointments_no_overlap_excl`.
- `appointments` lists indexes `appointments_business_starts_idx`, `appointments_customer_starts_idx`, `appointments_staff_starts_idx`, `appointments_status_idx`.
- `reviews` lists a UNIQUE constraint on `appointment_id` plus indexes `reviews_business_created_idx` and `reviews_customer_created_idx`.
- `payment_intents` lists indexes `payment_intents_appointment_created_idx` and `payment_intents_status_idx`.

### 8c. End-to-end smoke (optional, post-handler-deploy)

Once the Lambda handlers are deployed and you have a customer token and an APPROVED business with a service, staff, and availability:

```bash
curl -X POST "$API_BASE/v1/appointments" \
  -H "Authorization: Bearer $CUSTOMER_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "staffId":"...","serviceId":"...",
    "startsAt":"2026-...:00Z","paymentMethod":"CASH"
  }'
```

Expected: 200 with an `AppointmentView` whose `status` is `REQUESTED` and `paymentMethod` is `CASH`.

A second identical request: 409 `SLOT_UNAVAILABLE` (the EXCLUDE constraint catches it). This is the concurrent-booking acceptance criterion satisfied at low load; the dev double-book smoke script is the follow-up.

## Step 9 — Rollback if a migration fails

The migration runner uses transactional files (each migration has `BEGIN` / `COMMIT`). If a SQL statement inside a migration fails:

1. **Postgres rolls back the file's transaction automatically.** No partial schema change persists. The runner does not insert into `schema_migrations`, exits non-zero, and the failing file's name is in the error message.

2. **Inspect the error**:
   ```bash
   docker-compose exec postgres psql -U ethiolink -d ethiolink -c \
     "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 5;"
   ```
   The most recent applied version tells you exactly where the runner stopped.

3. **Fix forward, don't fix back.** The project rule (per `DATABASE_SCHEMA.md` "Migrations" and `migrate.mjs` header): migrations are forward-only. Do **NOT** edit an existing migration file. Either:
   - Author a new compensating migration (`0012_…`) that undoes / corrects whatever needs reverting.
   - Or, on a local dev machine only, blow away the database (`docker-compose down -v`) and re-run from scratch.

4. **Edge case — file succeeded but the post-INSERT into `schema_migrations` failed** (very rare — network blip mid-run): the next `npm run db:migrate` will try to re-apply the file and fail because the objects already exist. Manual recovery is documented in the runner header:
   ```bash
   docker-compose exec postgres psql -U ethiolink -d ethiolink -c \
     "INSERT INTO schema_migrations (version) VALUES ('NNNN_name');"
   npm run db:migrate
   ```

5. **Phase 4 specifically** — the FK chain is `payment_intents → appointments`, `reviews → appointments`, so a compensating migration that drops `appointments` must drop `payment_intents` and `reviews` first. Documented in `PHASE_4_BOOKING.md` "Rollback notes".

## Step 10 — Mark the checklist item

After Step 8 verifies all three migrations applied:

- Tick `[ ] Migrations 0009–0011 applied to dev.` in `docs/tasks/PHASE_4_BOOKING.md`.
- The remaining `terraform apply`-gated items in the test plan (concurrent-create smoke + integration full-flow) can now run.

## Remote dev RDS (Phase 7+) — addendum

When the dev Terraform stack grows the `module "rds"` block (Phase 7):

1. `terraform apply` in `infra/terraform/environments/dev/` will create the RDS instance and expose new outputs — at minimum `rds_endpoint`, `rds_port`, `rds_database`, and a `rds_secret_arn` pointing at Secrets Manager.
2. Set the `PG_*` env vars before running the migrator:
   ```bash
   export PG_HOST=$(terraform output -raw rds_endpoint)
   export PG_PORT=$(terraform output -raw rds_port)
   export PG_DATABASE=$(terraform output -raw rds_database)
   export PG_USER=ethiolink_app                 # or whatever Terraform creates
   export PG_PASSWORD=$(aws secretsmanager get-secret-value \
     --secret-id "$(terraform output -raw rds_secret_arn)" \
     --query SecretString --output text \
     | jq -r .password)
   export PG_SSL=true                            # RDS requires TLS
   npm run db:migrate
   ```
3. Verification (Step 8) uses `psql` directly against the RDS endpoint (with `PGPASSWORD` set) instead of `docker-compose exec`.
4. Rollback (Step 9) is the same fix-forward pattern. Forward-only is even stricter on a shared dev RDS because other developers will be hitting it.

A dedicated runbook for the AWS-hosted migration path lands with Phase 7 — this section is a forward-pointer, not the canonical doc.
