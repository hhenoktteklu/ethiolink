# Phase 7 — Completion Summary

End of Phase 7 (AWS Deployment). Every production resource the MVP needs is now declared in Terraform under `infra/terraform/modules/`, wired into both dev and prod environment stacks, and reachable end-to-end via a CI/CD pipeline that builds, applies, migrates, and smoke-tests on every push to `main`. Three follow-up gates remain — the prod deploy workflow, the least-privilege tightening of the deploy IAM role, and the prod admin-domain ACM cert — none of which block Phase 7 code; each is a discrete operator / hardening step.

Authoritative scope and checklist live in [`PHASE_7_AWS_DEPLOYMENT.md`](./PHASE_7_AWS_DEPLOYMENT.md). This file is the at-a-glance status read on 2026-05-15.

## Completed infrastructure modules

Every module lives under `infra/terraform/modules/<name>/` with the standard `main.tf` / `variables.tf` / `outputs.tf` shape. Each is wired into `infra/terraform/environments/dev/main.tf` and `infra/terraform/environments/prod/main.tf` with env-appropriate inputs.

**`bootstrap`** *(one-shot, applied manually from an operator laptop)*
- `aws_s3_bucket.terraform_state` — versioned, SSE-AES256, block-public-access, force-TLS bucket policy, `prevent_destroy`.
- `aws_dynamodb_table.terraform_locks` — `LockID` hash key, pay-per-request, `prevent_destroy`.
- `aws_iam_openid_connect_provider.github` — trust anchor at `token.actions.githubusercontent.com`.
- `aws_iam_role.terraform_deploy` — `ethiolink-terraform-deploy`. Trust condition pins the OIDC `sub` claim to `repo:hhenoktteklu/ethiolink:*`. Currently carries `AdministratorAccess` as a deliberate temporary choice while Phase 7 modules land.

**`cognito` (existing module — Phase 1 origin, Phase 7 alignment)**
- Admin client flipped to `generate_secret = false` (public PKCE) to match what the React SPA actually runs in-browser.
- Admin callback / logout URL defaults aligned with the SPA's `/login` route (was `/auth/callback` — drift fixed).
- Prod env stack now wires the module with `https://admin.ethiolink.app/login` for the alias; dev uses `http://localhost:5173/login` + the CloudFront URL (registered as a manual two-apply step).

**`vpc`**
- One VPC per env (dev `10.0.0.0/16`, prod `10.1.0.0/16`).
- 2 AZs × {public, private} subnets via deterministic `cidrsubnet(...)` carve-outs with a 10-slot gap between tiers.
- IGW + NAT Gateways (1 in dev, 2 in prod — one per AZ for single-AZ-outage resilience).
- Three security groups: `sg-lambda` (egress-only), `sg-rds` (ingress 5432 from `sg-lambda` via cross-SG reference), optional `sg-bastion` (prod-only, no associated EC2 yet).

**`s3`**
- Three buckets per env: `media-public` (public-read via bucket policy + force-TLS), `media-private` (block-public-access full, versioning on for accidental-delete recovery), `logs` (lifecycle expiration: 90d dev / 365d prod).
- `Object Ownership = BucketOwnerEnforced` (ACLs disabled) on every bucket. CORS for the admin SPA + future mobile web shell origins.
- Server access logging from media buckets to the logs bucket under per-bucket prefixes.

**`rds`**
- Postgres 15.18 in private subnets (bumped from 15.6 in May 2026 — see `infra/terraform/modules/rds/variables.tf`). `db.t4g.small` single-AZ in dev; `db.m6g.large` Multi-AZ in prod.
- Encrypted gp3 storage (autoscale 20→100 GiB dev, 100→1000 GiB prod). 7-day backups dev / 35-day prod.
- Master credentials live in Secrets Manager at the stable name `ethiolink/${env}/rds/master` with the AWS-rotation-compatible JSON shape.
- `deletion_protection = true` + `prevent_destroy = true` + `final_snapshot_identifier`. Performance Insights on (7-day retention).
- **RDS Proxy** (prod-only via `enable_rds_proxy = true`): dedicated `sg-rds-proxy`, IAM role allowed to read the master secret, cross-SG rules so the proxy can reach the DB. Connection pool tuned to 90% / 50% / 120s.

**`lambda`**
- 50 functions per env (the 49 application handlers + `maintenance-db-migrate`).
- Single shared `lambda.zip` produced by `backend/scripts/package.sh` (compile TS → prune tests → install prod-only `node_modules` → zip → ~5–10 MiB).
- One shared `ethiolink-${env}-lambda-exec` IAM role with AWS-managed `AWSLambdaVPCAccessExecutionRole` + an inline policy granting `secretsmanager:GetSecretValue` on the RDS master secret + S3 read/write on the media buckets.
- VPC-attached to private subnets via `sg-lambda`. One `aws_cloudwatch_log_group` per function with env-specific retention (30d dev / 90d prod).
- Per-function env overrides via `function_env_overrides` map — used in prod to point the migration runner at the direct DB endpoint (bypass RDS Proxy's DDL-hostile prepared-statement caching).

**Lambda cold-start secret resolution**
- `backend/shared/config/loadSecretsThenConfig.ts` — async wrapper around `loadConfig`. When `PG_SECRET_ARN` is present, fetches the secret via `@aws-sdk/client-secrets-manager` (lazy-imported), parses the JSON shape, resolves `PG_PASSWORD` + optional fallbacks for `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER`. Cached at module scope for warm invocations.
- All 49 application handlers + the migration runner now `await loadSecretsThenConfig()` at module top level instead of synchronously calling `loadConfig()`. Top-level await is supported in Node 20 ESM.
- 6-group test suite (`tests/config/loadSecretsThenConfig.test.ts`) covers the fallback path, happy path, cache, malformed secret variants, and the surface class.

**`api-gateway`**
- REST API per env (not HTTP API — picked for per-method Cognito user-pool authorizer support and OpenAPI parity).
- 48 HTTP routes wired to the existing Lambda handlers via `AWS_PROXY` integrations. 8 public routes (no authorizer) — `GET /v1/categories`, `GET /v1/businesses`, `GET /v1/businesses/{businessId}`, `GET /v1/businesses/{businessId}/services`, `GET /v1/businesses/{businessId}/staff`, `GET /v1/businesses/{businessId}/staff/{staffId}/availability`, `GET /v1/businesses/{businessId}/staff/{staffId}/slots`, `GET /v1/businesses/{businessId}/reviews`. The remaining 40 use the Cognito user-pool authorizer reading `Authorization` headers.
- Path-variable normalization on 4 handlers (`businesses/get`, `patch`, `submit`, `reviews/listForBusiness`) to read `.businessId` instead of `.id`, resolving an API-Gateway-mandated single-name-per-segment constraint.
- CORS via per-resource `OPTIONS` mock integrations + `default_4xx` / `default_5xx` gateway responses with the configured origin set.

**`eventbridge`**
- `aws_cloudwatch_event_rule` on `cron(0/15 * * * ? *)` targeting `scheduled-send-reminders` Lambda. Per-target `aws_lambda_permission` scoped to the rule ARN.
- `enabled` flag for env-level disable without removing the resource. The Lambda handles `Africa/Addis_Ababa` timezone math internally; the rule stays UTC-clean.

**`admin-frontend`**
- Private S3 bucket fronted by CloudFront with Origin Access Control (OAC, not the older OAI).
- Two cache behaviors: default = long-cache for hashed assets, ordered behavior on `/index.html` = no-cache.
- SPA fallback: `custom_error_response` maps 403/404 → `/index.html` with status 200 so React Router handles deep links.
- `aws_s3_object` resources via `for_each = fileset(var.admin_dist_path, "**/*")` upload every file from `admin/dist/` with per-extension `content_type` + per-file `cache_control`.
- Custom domain support via `var.custom_domain` + `var.acm_certificate_arn` (both empty by default — operator wires `admin.ethiolink.app` once a us-east-1 cert exists).

**`waf`**
- Regional WAFv2 Web ACL associated with the API Gateway stage. Default `allow {}`.
- Three AWS-managed rule groups (`CommonRuleSet`, `KnownBadInputsRuleSet`, `AmazonIpReputationList`), each with its own `enable_*` toggle.
- Rate-based rule at 2000 req / 5 min per IP (variabled at the env level — `waf_rate_limit_per_5min`).
- CloudWatch metrics + sampled requests enabled on every rule.

**`cloudwatch`**
- SNS topic per env (`ethiolink-${env}-alarms`) with optional email subscription gated by `alarm_email`.
- 7 alarms — API Gateway 5xx, aggregate Lambda errors, RDS CPU / connections / free storage, EventBridge `FailedInvocations`, WAF `BlockedRequests`. Each threshold is variabled for tuning without a module change.
- 4 dashboards: API Gateway (volume + 4xx/5xx + latency), Lambda (aggregate counters + per-function error / p95 duration widgets), RDS (CPU + connections + free storage + IOPS), WAF + EventBridge (allowed/blocked + invocations/failed).
- One aggregate Lambda alarm (namespace-wide) rather than 49 per-function alarms — the cost + notification-noise tradeoff is the documented MVP posture; per-function alarms on critical handlers are a Phase 8 follow-up.

**Migration runner Lambda**
- `backend/lambdas/maintenance/dbMigrate.ts` — 50th function, manually invoked.
- `backend/db/migrate.mjs` refactored to export `runMigrations({ client, migrationsDir?, log? })` while keeping the local CLI path gated on `import.meta.url === pathToFileURL(process.argv[1]).href`. Local `npm run db:migrate` and the Lambda share the exact same runner.
- `backend/db/migrate.d.mts` provides the type declarations so the Lambda's TS source consumes the runner with full type safety.
- `backend/scripts/package.sh` copies `backend/db/` into `dist/` so the deployment zip contains the SQL files at `/var/task/db/migrations/`.
- Returns `{ applied, skipped, failed, status: "success" | "partial_failure", target }`.
- In prod the function's `PG_HOST` env is overridden to the direct RDS endpoint (bypass the proxy — its prepared-statement caching interferes with DDL).

## Completed CI/CD

**`.github/workflows/terraform-plan.yml`** *(from the bootstrap commit)*
- PR-only workflow triggered on changes under `infra/**` or to the workflow file itself.
- Assumes the `ethiolink-terraform-deploy` role via OIDC, runs `terraform fmt -check -recursive`, `init`, `validate`, `plan -detailed-exitcode -out=tfplan.binary` against `environments/dev`, and posts the plan to the GitHub step summary.
- `concurrency: cancel-in-progress: true` keeps only the most recent plan per PR.

**`.github/workflows/deploy-dev.yml`**
- Push-to-`main` workflow triggered on changes to `backend/**`, `admin/**`, `infra/**`, or either workflow YAML.
- Steps: checkout → Node 20 + Terraform 1.6.6 → OIDC role assumption → `backend/scripts/package.sh` → `cd admin && npm ci && npm run build` (with `DEV_VITE_*` baked from secrets) → `terraform init && terraform apply -auto-approve` → capture outputs → `aws lambda invoke` the migration runner + fail on `status != "success"` → CloudFront `/index.html` invalidation → run `backend/scripts/smoke.sh`.
- `concurrency: deploy-dev / cancel-in-progress: false` serializes deploys.

**`backend/scripts/smoke.sh`** *(executable; consumed by `deploy-dev.yml`, runnable by humans)*
- Three assertions against a deployed env: (1) `GET /v1/categories` → 200 + `items` array, (2) `POST /v1/auth/sync` without JWT → 401, (3) `aws lambda invoke` on the scheduled-reminder function returns a response body with `scanned` / `sent` / `skipped` / `failed` keys.
- Pure bash + `curl` + `jq` + `aws` CLI. Exits non-zero on any failure with a printed body for debuggability.

## Operator bootstrap / prerequisites

Required steps an operator runs **once per AWS account** before CI takes over:

1. **Apply the bootstrap stack** (commit `e808d43`):
   ```bash
   aws sts get-caller-identity  # sanity check the AdministratorAccess principal
   cd infra/terraform/bootstrap
   terraform init && terraform plan && terraform apply
   ```
   Produces the S3 state bucket, the DynamoDB lock table, the GitHub OIDC provider, and the `ethiolink-terraform-deploy` IAM role.

2. **Set the `AWS_ACCOUNT_ID` GitHub secret**:
   ```bash
   terraform output -raw terraform_deploy_role_arn
   # Extract the 12-digit account ID and add it under
   # Settings → Secrets and variables → Actions → New repository secret.
   ```

3. **First manual `terraform apply` against dev** to surface every output the admin SPA build needs. The admin-frontend module's `fileset(...)` requires `admin/dist/` to exist — run `cd admin && npm ci && npm run build` with placeholder `VITE_*` values once to satisfy the path, then re-build with real values after step 4.

4. **Capture and store the four `DEV_VITE_*` GitHub Actions secrets** (after step 3 succeeds):
   | Secret                             | Source command                                                          |
   | ---------------------------------- | ----------------------------------------------------------------------- |
   | `DEV_VITE_COGNITO_DOMAIN`          | `https://$(terraform output -raw cognito_hosted_ui_domain).auth.eu-west-1.amazoncognito.com` |
   | `DEV_VITE_COGNITO_ADMIN_CLIENT_ID` | `$(terraform output -raw cognito_admin_app_client_id)`                  |
   | `DEV_VITE_ADMIN_REDIRECT_URI`      | `$(terraform output -raw admin_frontend_url)/login`                     |
   | `DEV_VITE_API_BASE_URL`            | `$(terraform output -raw api_gateway_invoke_url)`                       |

5. **Update Cognito's `admin_callback_urls`** in `infra/terraform/environments/dev/main.tf` to include the CloudFront-hosted `/login` URL from step 4, then commit + push so the workflow re-applies with the new value. Without this two-apply dance the hosted-UI redirect after sign-in fails with `redirect_mismatch`.

6. **Confirm the alarm SNS subscription** by clicking the AWS confirmation link sent to the `alarm_email` address.

After those six steps, every subsequent push to `main` triggers the full deploy + migrate + smoke cycle automatically.

## Migration runner invocation and expected result

Operators invoke the migration runner manually after every Terraform apply that ships a new SQL file. The dev workflow already does this automatically; the manual command is the on-call fallback when something needs hand-applying:

```bash
cd infra/terraform/environments/dev
aws lambda invoke \
    --function-name "$(terraform output -raw lambda_db_migrate_function_name)" \
    --cli-binary-format raw-in-base64-out \
    --payload '{}' \
    /tmp/migrate-response.json
cat /tmp/migrate-response.json
```

Expected first-apply response shape:

```json
{
  "applied": [
    "0001_init.sql",
    "0002_set_updated_at.sql",
    "0003_business_categories.sql",
    "0004_business_profiles.sql",
    "0005_media_assets.sql",
    "0006_services.sql",
    "0007_staff_members.sql",
    "0008_staff_availability.sql",
    "0009_appointments.sql",
    "0010_reviews.sql",
    "0011_payment_intents.sql",
    "0012_admin_actions.sql",
    "0013_notification_logs.sql"
  ],
  "skipped": [],
  "failed": [],
  "status": "success",
  "target": "ethiolink@ethiolink-dev-rds.<region>.rds.amazonaws.com:5432/ethiolink"
}
```

Re-invocation is idempotent — already-applied files appear in `skipped` and the response stays `"status": "success"`.

## Remaining prod / deploy gaps

None block Phase 7 code completion; each is a discrete operator or follow-up commit.

- **`deploy-prod.yml` workflow.** Not in this phase. Should ship in a Phase 7.5 follow-up or as the first Phase 8 commit. Requires (a) a tighter trust condition on the OIDC role limiting the `sub` claim to `repo:hhenoktteklu/ethiolink:ref:refs/tags/v*`, (b) a manual-approval `environment` gate, (c) the same step sequence as `deploy-dev.yml` against `infra/terraform/environments/prod`.
- **Least-privilege deploy role.** Currently the `ethiolink-terraform-deploy` role carries `AdministratorAccess` as a deliberate temporary choice. The follow-up commit: capture every API call from a clean dev `terraform apply` via CloudTrail, generate a least-privilege policy with `iamlive` or the AWS Access Analyzer policy-generator, swap the `AdministratorAccess` attachment for the generated policy. Optionally split the role into plan-only (PR) and apply (push-to-main) variants with different ref-scoping.
- **Prod admin custom domain + ACM cert.** `var.admin_custom_domain` and `var.admin_acm_certificate_arn` default to empty in the prod env stack. Once an operator provisions a us-east-1 ACM cert covering `admin.ethiolink.app` (or whichever domain ships), filling those values + re-applying attaches the alias to CloudFront in place. Same pattern for `api.ethiolink.app` once the API custom-domain follow-up lands.
- **Cognito CloudFront callback URL two-apply step (dev).** Documented in the operator bootstrap above — the CloudFront URL only exists after the first apply, so the operator updates `admin_callback_urls` in code and re-applies. A future enhancement would have the Cognito module accept the CloudFront URL as an output reference and break the cycle; for now the manual step is acceptable.

## Remaining Phase 8 hardening follow-ups

Non-blocking polish + production-readiness items. None gate any subsequent phase.

- **Custom API Gateway domain.** `api.ethiolink.app` mapping for the prod REST API, with the ACM cert in `eu-west-1` (regional). Includes Route 53 record-set wiring.
- **Real SMS / Telegram provider integration.** Replace `SmsNotificationGateway` / `TelegramNotificationGateway` stubs with concrete classes (e.g. `EthioTelecomSmsGateway`, `AfroMessageSmsGateway`, `TelegramBotGateway`) implementing the existing `NotificationGateway` port. Credentials land in Secrets Manager; the dispatcher's `gateways` map registers them under their channel keys.
- **KMS-managed encryption.** Replace SSE-S3 (`AES256`) on the S3 buckets + AWS-managed default RDS KMS key with customer-managed KMS keys + key policies + rotation lifecycle.
- **Per-domain Lambda IAM roles.** Split the single shared `lambda-exec` role into one role per domain area (or per critical handler) so the principle of least privilege applies at the function level.
- **X-Ray + RUM.** AWS X-Ray traces for the Lambda → RDS path + CloudWatch RUM on the admin SPA for client-side telemetry.
- **DR restore drill.** Quarterly restore-from-snapshot rehearsal against a scratch prod account. Includes the runbook for re-pointing API Gateway at the recovered Lambda set.
- **Load testing.** 50 RPS for 10 minutes against `GET /v1/businesses` (the public hot path). Refine WAF rate-limit, RDS CPU + connections alarm thresholds, and Lambda memory / timeout per-function overrides from the captured numbers.
- **WAF tuning.** First few weeks of prod traffic will surface managed-rule false-positives. Tighten via `rule_action_override` blocks on specific sub-rules rather than disabling whole groups via the `enable_*` toggles.
- **`lint-test.yml` PR workflow.** ESLint, the `npm test` suite, `tsc --noEmit` on both backend + admin, Flutter analyze + test on the mobile app. Not strictly Phase 8, but the natural pair to the deploy workflows.
- **`withTransaction` for the booking + audit + notification multi-write paths.** Carried over from Phase 5 / Phase 6 follow-ups. The dispatcher's swallow-everything posture keeps notifications safe; the canonical fix threads a `PoolClient` through the booking flow.

## Next recommended phase

**Phase 8 — Production Hardening.** With every Phase 7 module deployed and the dev workflow validated end-to-end, the remaining surface is operational maturity: real provider credentials, the prod deploy workflow, custom domains, KMS-managed encryption, observability depth (X-Ray + RUM), per-function IAM scoping, and the runbooks + DR drills that turn "it runs" into "it operates". The eight bullets above are the rough Phase 8 backlog.

**Alternative — early launch.** If a stakeholder demo on dev is the more urgent need, the current state already supports it. The mobile app can point at `api_gateway_invoke_url`; the admin team can visit `admin_frontend_url`; the four MVP categories seed gives content to browse; bookings flow end-to-end with the mock notification gateway. Phase 8 hardening then runs in parallel with real traffic shaping the priorities.
