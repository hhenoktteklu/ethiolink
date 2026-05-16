# AWS Deployment

## Region

Primary region: `eu-west-1` (Ireland). This is the closest AWS region to Ethiopia with the full set of services we need and acceptable latency. Re-evaluate when AWS Cape Town (`af-south-1`) gains parity for Cognito and RDS Proxy.

## Bootstrap (one-time)

Before any per-environment stack can apply, the shared S3 backend, DynamoDB lock table, GitHub OIDC provider, and `terraform-deploy` IAM role must exist. These four resources live in `infra/terraform/bootstrap/` and are created exactly once per AWS account by an operator from their laptop. After that, every other apply runs from CI against the remote state this bootstrap created.

### What it provisions

- **S3 bucket** `ethiolink-terraform-state` — holds every environment's `terraform.tfstate` at `env/<name>/terraform.tfstate`. Versioned, SSE-AES256 encrypted, block-public-access enabled, force-TLS bucket policy. `prevent_destroy = true`.
- **DynamoDB table** `ethiolink-terraform-locks` — `LockID` string hash key, pay-per-request billing. Shared across environments (Terraform's `LockID` already namespaces by `bucket/key`, so concurrent dev + prod applies don't block each other). `prevent_destroy = true`.
- **GitHub OIDC identity provider** — trust anchor at `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`. Lets workflows obtain short-lived AWS credentials without long-lived access keys in the repo.
- **`ethiolink-terraform-deploy` IAM role** — assumed by GitHub Actions via OIDC. Trust condition restricts the `sub` claim to `repo:hhenoktteklu/ethiolink:*` so only Actions runs inside this repository can assume it. Currently carries `AdministratorAccess` as a deliberate temporary choice while the Phase 7 modules land; tightened in a follow-up commit once a clean dev apply has been captured in CloudTrail to author the real least-privilege policy.

### One-time procedure

The bootstrap stack stores its own state on the operator's laptop — it can't store state in the bucket it's about to create. After the initial apply, the state file under `infra/terraform/bootstrap/.terraform/` may be left in place or optionally migrated into the bucket; the stack is small and rarely changes either way.

```bash
# 1. Authenticate to AWS as a principal with permission to create
#    the bootstrap resources (S3, DynamoDB, IAM). Typically the
#    account root or a one-shot operator IAM user with
#    AdministratorAccess.
aws sts get-caller-identity  # sanity check

# 2. Apply the bootstrap stack.
cd infra/terraform/bootstrap
terraform init
terraform plan
terraform apply

# 3. Note the `terraform_deploy_role_arn` output — its account-id
#    component is the value of `AWS_ACCOUNT_ID` referenced by the
#    GitHub Actions workflows. Add it as a repository secret in
#    GitHub:
#      Settings → Secrets and variables → Actions → New repository secret
#      Name: AWS_ACCOUNT_ID
#      Value: <12-digit account id>
terraform output terraform_deploy_role_arn

# 4. Verify the dev environment can `terraform init` against the
#    new remote backend (no apply yet — modules land in Phase 7
#    commits 2+).
cd ../environments/dev
terraform init
```

After step 4 succeeds, every subsequent Terraform action on dev or prod runs from CI via the `terraform-deploy` role. The PR plan workflow (`.github/workflows/terraform-plan.yml`) is the first such surface; the deploy workflows follow in later Phase 7 commits.

### Tightening the deploy-role policy

`AdministratorAccess` is the right tradeoff during bootstrap but the wrong shape for a steady-state CI role. The follow-up commit will:

1. Apply the dev environment from scratch once with `AdministratorAccess` to capture every real API call in CloudTrail.
2. Generate a least-privilege policy from those captured calls (`iamlive` or the AWS-managed `Access Analyzer` policy-generation surface).
3. Replace the `AdministratorAccess` attachment with the generated policy and re-apply the bootstrap.
4. Split the role: keep the broad role for the PR plan workflow (already read-only at the AWS surface because `terraform plan` is a no-op against API state) and add tighter, ref-scoped roles for the dev and prod apply workflows.

## Accounts and environments

- One AWS account.
- Two environments: `dev` and `prod`, separated by resource naming, Terraform workspaces, and IAM boundaries.
- A future `staging` environment is reserved but not built in MVP.

## Resources provisioned by Terraform

### Networking

Provisioned by `infra/terraform/modules/vpc/`. One VPC per environment with the topology below.

| Property              | Dev                                  | Prod                                  |
| --------------------- | ------------------------------------ | ------------------------------------- |
| VPC CIDR              | `10.0.0.0/16`                        | `10.1.0.0/16`                         |
| Availability zones    | 2 (first 2 from `aws_availability_zones`) | 2                                |
| Public subnets        | 2 × `/24` at `cidrsubnet(...,8,0..1)` | 2 × `/24` at `cidrsubnet(...,8,0..1)` |
| Private subnets       | 2 × `/24` at `cidrsubnet(...,8,10..11)` | 2 × `/24` at `cidrsubnet(...,8,10..11)` |
| Internet Gateway      | 1                                    | 1                                     |
| NAT Gateways          | 1 (single-AZ — accepts dev outages)  | 2 (one per AZ — survives single-AZ NAT outage) |
| Bastion SG            | not created                          | created (no associated instance until on-call need) |

CIDR carve-out leaves a 10-slot gap between public and private indexes so future tiers (dedicated DB subnet group at indexes 20+, ElastiCache at 30+, etc.) can land without renumbering the existing subnets.

Security groups:

- **`sg-lambda`** — egress allow-all, no ingress. Every EthioLink Lambda attaches to this SG; Lambdas don't accept inbound TCP (API Gateway and EventBridge invoke via the AWS plane, not VPC networking).
- **`sg-rds`** — ingress on TCP 5432 from `sg-lambda` (cross-SG reference, no hardcoded CIDR). When the bastion SG is present, an additional ingress rule from the bastion SG is added on the same port. No public exposure.
- **`sg-bastion`** *(prod only)* — ingress on TCP 22 from operator-supplied CIDRs (`bastion_allowed_cidrs`, empty by default — the operator adds their IP via an out-of-band rule when access is actually needed). Egress allow-all. The SG exists ahead of any actual bastion EC2 instance so launching one is a non-Terraform-blocking step.

VPC endpoints (S3, Secrets Manager) and flow logs are intentionally out of scope for the MVP VPC module — they land in follow-up commits once a real workload measures NAT egress cost.

### Cognito

- One user pool per environment.
- Three groups: `CUSTOMER`, `BUSINESS_OWNER`, `ADMIN`.
- App clients:
  - `ethiolink-mobile` (public, PKCE, no client secret) — Flutter app on the `ethiolink://auth/{callback,logout}` deep-link scheme.
  - `ethiolink-admin` (public, PKCE, no client secret) — React SPA. The dashboard runs the PKCE flow in-browser via `admin/src/lib/auth.ts`; the callback route is `/login?code=...` (the `LoginPage` component handles the exchange). The Cognito client's `callback_urls` and `logout_urls` MUST list the same `/login` path per environment:
    - Dev: `http://localhost:5173/login`
    - Prod: `https://admin.ethiolink.app/login`

  Group-level access control (only `ADMIN` group members can use the dashboard) is enforced at the application layer — both client-side (`isAdmin(session)` in `auth.ts` gates routing through `ProtectedRoute`) and server-side (`backend/lambdas/admin/_authz.ts` refuses non-`ADMIN` roles with 403 on every admin endpoint).

**Password policy (Phase 8 security review).** 12-char minimum, lowercase + uppercase + digit + symbol all required, 7-day temporary-password validity. The previous Phase 1 default was 10 chars / symbol optional — the bootstrap stance for an empty pool. The Phase 8 pass tightens the policy to the production-ready posture documented in `docs/operations/SECURITY_REVIEW.md`. Existing users whose passwords satisfy only the older policy continue to authenticate; Cognito enforces the new policy on next password change, not retroactively.

**MFA.** `mfa_configuration = "OPTIONAL"` with `software_token_mfa_configuration { enabled = true }` — TOTP via any authenticator app. Per-user enrollment is an operator step: an `ADMIN` user signs in via the hosted UI, navigates to the account-settings page, and follows the TOTP enrollment flow (the Cognito hosted UI shows a QR + secret). MFA-required posture for the `ADMIN` group is the next-step hardening tracked in the security review doc — flipping `mfa_configuration` to `ON` is a one-line change once every admin has enrolled.

### API Gateway

Provisioned by `infra/terraform/modules/api-gateway/`. One REST API per environment (REST flavor, not HTTP API — picked for per-method Cognito user-pool authorizer support and OpenAPI parity). 48 HTTP routes — every Lambda handler under `backend/lambdas/` except `scheduled/sendReminders` (EventBridge-triggered).

**Routes.** The full route table lives in `infra/terraform/modules/api-gateway/main.tf` `locals.routes` and is the authoritative source. 8 public routes (no authorizer) — every `GET` under `/v1/categories`, `/v1/businesses`, the per-business `services` / `staff` / `reviews` / `availability` / `slots` reads. The remaining 40 routes use the Cognito user-pool authorizer pointed at `module.cognito.user_pool_arn`. The authorizer reads from `method.request.header.Authorization` (`Bearer <id_token>`).

**Path-variable naming.** API Gateway requires one variable name per segment position. The shared parent `/v1/businesses/{X}` uses `{businessId}` across both the single-entity reads (was `{id}` in the OpenAPI doc) and the nested `services` / `staff` / `appointments` / `reviews` sub-trees. Four handlers (`businesses/get`, `patch`, `submit`, `reviews/listForBusiness`) were normalized to read `event.pathParameters.businessId` to match. Inner segments use `{id}` (e.g. `/services/{id}`, `/staff/{id}`) or `{staffId}` for `/staff/{staffId}/availability` and `/staff/{staffId}/slots`, matching what the handler code already reads.

**Integration.** Per route: `aws_api_gateway_method` (auth = `NONE` or `COGNITO_USER_POOLS`) + `aws_api_gateway_integration` (`type = "AWS_PROXY"`, `uri = module.lambda.function_invoke_arns[function]`) + `aws_lambda_permission` (source ARN scoped to the specific resource + method, not the API-wide `/*/*` wildcard).

**CORS.** Every resource with at least one non-OPTIONS method also gets an `OPTIONS` mock integration returning the standard `Access-Control-Allow-*` headers + the configured origin set. `aws_api_gateway_gateway_response.default_4xx` / `default_5xx` add the same origin headers to error responses so the admin SPA sees the upstream error code rather than a CORS-mangled "fetch failed". Dev CORS allow-list: `http://localhost:5173`. Prod: `https://admin.ethiolink.app`.

**Stage.** Stage name = environment name (`dev`, `prod`), so the invoke URL is `https://<api-id>.execute-api.<region>.amazonaws.com/<env>`. Each Terraform apply that changes the route map, path tree, authorizer, or CORS origin triggers a fresh deployment via a SHA-keyed `triggers` map.

**Custom domain.** Deferred — dev uses the default `*.execute-api` URL today. The prod `api.ethiolink.app` mapping lands in a follow-up commit alongside the ACM cert + Route 53 record-set work.

### Lambda

Provisioned by `infra/terraform/modules/lambda/`. Node.js 20 runtime. **One `aws_lambda_function` per handler** under `backend/lambdas/` — 49 functions total at the end of Phase 6, all named `ethiolink-${env}-<area>-<file>` (e.g. `ethiolink-dev-appointments-create`, `ethiolink-prod-admin-notifications-list`).

**Packaging.** Every function references the same `backend/dist/lambda.zip` artifact produced by `backend/scripts/package.sh`. The script compiles TypeScript to `backend/dist/`, prunes the compiled test tree, installs production-only `node_modules` inside `dist/`, and zips the result. Each `aws_lambda_function` selects its entry by a different `handler` value (`lambdas/<area>/<file>.handler`). The one-zip-many-handlers pattern is the deliberate MVP simplification — splitting into per-handler bundles is a documented follow-up gated on cold-start budget violations.

**VPC config.** Every function attaches to the VPC's private subnets with `sg-lambda` as its security group. RDS connectivity routes through `sg-rds`'s ingress rule (from `sg-lambda`); in prod the proxy SG sits between them. AWS-managed `AWSLambdaVPCAccessExecutionRole` covers the ENI lifecycle + CloudWatch logs permissions.

**Environment variables.** Assembled from upstream module outputs + `backend/.env.example` defaults:

| Env var                          | Source                                                  |
| -------------------------------- | ------------------------------------------------------- |
| `NODE_ENV`, `LOG_LEVEL`          | module input (defaults `production` / `info`)            |
| `APP_REGION`, `COGNITO_REGION`   | `var.region`                                            |
| `PG_HOST`                        | `module.rds.effective_endpoint` (proxy in prod, direct in dev) |
| `PG_PORT`                        | `module.rds.db_port`                                    |
| `PG_DATABASE`, `PG_USER`         | module input                                            |
| `PG_SSL`                         | hardcoded `"true"`                                      |
| `PG_SECRET_ARN`                  | `module.rds.master_secret_arn` (see *Password resolution* below) |
| `COGNITO_USER_POOL_ID`           | `module.cognito.user_pool_id`                            |
| `COGNITO_APP_CLIENT_ID_MOBILE`   | `module.cognito.mobile_app_client_id`                    |
| `COGNITO_APP_CLIENT_ID_ADMIN`    | `module.cognito.admin_app_client_id`                     |
| `S3_BUCKET_MEDIA_PUBLIC`         | `module.s3.media_public_bucket_name`                     |
| `S3_BUCKET_MEDIA_PRIVATE`        | `module.s3.media_private_bucket_name`                    |
| `S3_UPLOAD_URL_EXPIRES_SECONDS`  | hardcoded `900`                                          |
| `S3_READ_URL_EXPIRES_SECONDS`    | hardcoded `3600`                                         |
| `NOTIFICATIONS_PROVIDER`         | module input (default `mock`)                            |
| `PAYMENTS_PROVIDER_CASH`         | module input (default `cash`)                            |
| `PAYMENTS_PROVIDER_ONLINE`       | module input (default `mock`)                            |
| `BOOKING_*`                      | module input (defaults match `backend/.env.example`)     |
| `DEFAULT_TIMEZONE`               | module input (default `Africa/Addis_Ababa`)              |

**Password resolution.** `PG_PASSWORD` is **never** set as a Lambda environment variable — env vars are visible in plaintext in the AWS console and in the Terraform state file. Instead, every function receives `PG_SECRET_ARN = <master_secret_arn>` and the runtime resolves the secret at cold-start before `loadConfig` runs. The shim is `backend/shared/config/loadSecretsThenConfig.ts`:

  1. If `PG_SECRET_ARN` is absent (local dev), delegates directly to `loadConfig(env)` with no SDK import and no network call — preserves the docker-compose path byte-for-byte.
  2. If present, looks up the cached value for that ARN at module scope (warm-invocation fast path).
  3. On cache miss, calls `secretsResolver.resolve(arn)` — the default resolver lazy-imports `@aws-sdk/client-secrets-manager` and calls `GetSecretValueCommand`. Tests inject an in-memory resolver and a fresh cache to keep behavior deterministic.
  4. Parses the JSON shape the Terraform RDS module writes (`{ username, password, engine, host, port, dbname, dbInstanceIdentifier }`). Malformed JSON, missing `password`, or missing `username` throws `SecretResolutionError`.
  5. Builds a derived env where `PG_PASSWORD` always comes from the secret (explicit `PG_SECRET_ARN` is the operator's signal), and `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` defer to the input env when present and fall back to the secret's values when not. This lets the Terraform Lambda env point `PG_HOST` at the RDS Proxy while the secret's `host` value (the direct DB endpoint) is only used by the migration runner.
  6. Delegates to `loadConfig(derivedEnv)` and returns the frozen `AppConfig`.

Every Lambda handler's cold-start init calls `await loadSecretsThenConfig()` at module top level (Node 20 ESM supports top-level `await`) instead of the previous synchronous `loadConfig()`. The 49 handlers were swapped mechanically in the same commit that introduced the shim.

**IAM grouping.** One execution role per domain area — eleven roles per env: `ethiolink-${env}-lambda-exec-{auth,businesses,services,staff,availability,appointments,reviews,media,admin,scheduled,maintenance}`. Every role carries the same baseline (AWS-managed `AWSLambdaVPCAccessExecutionRole` for logs + ENI, plus an inline policy granting `secretsmanager:GetSecretValue` on the RDS master secret). The `media` role additionally has the S3 statements (`GetObject` / `PutObject` on both media buckets + `DeleteObject` on private + `GetBucketLocation`/`ListBucket` on both) — those statements only apply to the two media-touching handlers. Per-handler role splitting on specific high-risk handlers (e.g. `admin-businesses-suspend` getting a write-only role) is a Phase 8 follow-up gated on real incident learnings.

**Log groups.** One CloudWatch log group per function at `/aws/lambda/<function-name>` with environment-specific retention (30 days dev / 90 days prod). Explicit `aws_cloudwatch_log_group` resources rather than letting Lambda auto-create — auto-created groups default to "never expire", which is cost-hostile.

**Tracing.** Every function has `tracing_config.mode = "Active"`, which switches on AWS X-Ray at the runtime layer (cold-start, init duration, function duration, billing-relevant metrics, downstream HTTP calls made via the embedded daemon). The baseline IAM policy on every per-domain role grants `xray:PutTraceSegments` + `xray:PutTelemetryRecords`. SDK-call sub-segments (each `s3:PutObject`, each `secretsmanager:GetSecretValue`) require the `aws-xray-sdk-core` package plus per-client wrapping; the application-side `backend/shared/observability/tracing.ts` exposes a `captureAwsClient(client)` hook that no-ops today but flips on once the SDK package lands in a follow-up commit.

**Correlation IDs.** `backend/shared/observability/correlationId.ts` exports an `AsyncLocalStorage`-backed `withRequestContext(ctx, fn)` scope plus a `getCurrentRequestContext()` reader. Handlers wrap their entry body in the scope; deep call sites (the notification dispatcher, repository helpers) read the context without argument threading. The logger consumes the context via a new optional `contextProvider` hook on `LoggerOptions` — when wired, every log line auto-stamps `requestId` / `cognitoSub` / `route` / `method` / `handler`. The Phase 8 observability commit ships the helpers + the logger hook; the per-handler refactor that adopts the wrapper is a mechanical follow-up.

**Migration runner.** A 50th function, `maintenance-db-migrate`, applies database migrations against RDS. It's NOT wired to API Gateway or EventBridge — operators invoke it manually after every `terraform apply` that ships a new migration:

```bash
aws lambda invoke \
    --function-name "$(terraform output -raw lambda_db_migrate_function_name)" \
    --cli-binary-format raw-in-base64-out \
    /tmp/migrate-response.json
cat /tmp/migrate-response.json
```

The handler returns `{ applied: string[], skipped: string[], failed: { filename, error }[], status: "success" | "partial_failure", target: string }`. The same `runMigrations` function backs the local `npm run db:migrate` CLI, so laptop + Lambda apply the exact same files in the exact same order — the `schema_migrations` ledger table dedupes re-invocations.

**Migration runner — direct DB endpoint.** In prod the function's `PG_HOST` env is overridden to point at the direct RDS endpoint (`module.rds.db_endpoint`) instead of the proxy. RDS Proxy's prepared-statement caching interferes with DDL (CREATE TABLE / ALTER TABLE / CREATE INDEX) — a migration would apply against the proxy but partially-fail when the proxy's cached session state collides with the new schema. The direct endpoint bypasses the proxy entirely. The `function_env_overrides` map on the Lambda module is the seam that wires the override.

**Packaging delta for the migration runner.** `backend/scripts/package.sh` copies `backend/db/` into `dist/db/` so the deployment zip contains `db/migrate.mjs` + `db/migrations/*.sql` alongside the compiled Lambda handlers. The Lambda's runner reads the SQL files at runtime from `/var/task/db/migrations/`.

### RDS

Provisioned by `infra/terraform/modules/rds/`. One PostgreSQL 15 instance per environment, sitting on the VPC's private subnets with `sg-rds` attached (ingress on 5432 from `sg-lambda` only). Master credentials live in Secrets Manager under the stable name `ethiolink/${env}/rds/master` with the JSON shape `{ username, password, engine, host, port, dbname, dbInstanceIdentifier }` so the AWS-managed rotation Lambdas drop in without a value-shape change.

| Property                | Dev                              | Prod                              |
| ----------------------- | -------------------------------- | --------------------------------- |
| Instance class          | `db.t4g.small` (ARM, burstable)  | `db.m6g.large` (ARM, steady)      |
| Engine version          | `15.6`                           | `15.6`                            |
| Multi-AZ                | no                               | yes                               |
| Allocated storage       | 20 GiB (autoscale to 100)        | 100 GiB (autoscale to 1000)       |
| Storage type            | gp3                              | gp3                               |
| Storage encryption      | on (AWS-managed key)             | on (AWS-managed key)              |
| Backup retention        | 7 days                           | 35 days (AWS maximum)             |
| Backup window           | 22:00–23:00 UTC                  | 22:00–23:00 UTC                   |
| Maintenance window      | Sun 23:00 – Mon 00:00 UTC        | Sun 23:00 – Mon 00:00 UTC         |
| Deletion protection     | on (`prevent_destroy` + `deletion_protection`) | same                  |
| Final snapshot          | `ethiolink-${env}-rds-final`     | same                              |
| Performance Insights    | on (7-day retention)             | on (7-day retention)              |
| CloudWatch log exports  | `postgresql`                     | `postgresql`                      |
| RDS Proxy               | no                               | yes (idle-client timeout 600s)    |

**RDS Proxy** (prod-only): created behind a `enable_rds_proxy` boolean. The proxy gets its own dedicated security group (`sg-rds-proxy`) plus an IAM role allowed to read the master secret. Two cross-SG rules also land alongside it: the proxy SG accepts ingress on 5432 from anything already allowed by `sg-rds` (which already includes `sg-lambda`), and `sg-rds` itself accepts ingress from the proxy SG so the proxy can reach the DB. Connection pool tuned to 90% `max_connections_percent` / 50% `max_idle_connections_percent` / 120s `connection_borrow_timeout` — revisit after the first load test.

**Endpoint selection.** The module exposes both `db_endpoint` (direct instance) and `proxy_endpoint` (null when the proxy is disabled) plus a convenience `effective_endpoint` that points at the proxy when enabled, else the direct endpoint. Lambdas read `effective_endpoint`; the migration runner explicitly targets `db_endpoint` (proxy prepared-statement caching interferes with DDL).

### S3

Provisioned by `infra/terraform/modules/s3/`. Three buckets per environment with the shared posture below.

| Bucket                                | Public read | Versioning | Lifecycle                                   | Server access logging |
| ------------------------------------- | ----------- | ---------- | ------------------------------------------- | --------------------- |
| `ethiolink-${env}-media-public`       | yes (via bucket policy, force-TLS) | off by default (`enable_public_bucket_versioning`) | none in MVP             | writes to `logs/media-public/` |
| `ethiolink-${env}-media-private`      | no (block-public-access all on) | on                                          | none in MVP             | writes to `logs/media-private/` |
| `ethiolink-${env}-logs`               | no (block-public-access all on) | off                                         | expire after `logs_expiration_days` (90 dev / 365 prod) | n/a                   |

Shared posture across all three buckets: SSE-AES256, `Object Ownership = BucketOwnerEnforced` (ACLs disabled), force-TLS bucket policy (`Deny s3:* when aws:SecureTransport=false`), `force_destroy = false` plus `prevent_destroy = true` on the lifecycle block (a `terraform destroy` cannot tear a bucket down if it has any content — the belt-and-braces against accidental loss of customer media).

CORS for the two media buckets is driven by the `admin_allowed_origins` and `mobile_allowed_origins` inputs. The public bucket allows `GET / HEAD` from the union of those origins; the private bucket additionally allows `PUT` so a browser-side presigned upload can preflight. Native mobile clients don't enforce CORS, so `mobile_allowed_origins` is empty by default.

`S3StorageGateway` (`backend/shared/adapters/storage/`) is the sole writer for both media buckets and picks the target by `IssueUploadUrlInput.isPublic`. Lambda env vars: `S3_BUCKET_MEDIA_PUBLIC` ← `media_public_bucket_name`, `S3_BUCKET_MEDIA_PRIVATE` ← `media_private_bucket_name`. A gateway-type VPC endpoint to S3 is intentionally not created in this module — it lands once the NAT egress cost on real traffic justifies the change.

### Admin frontend (CloudFront + S3)

Provisioned by `infra/terraform/modules/admin-frontend/`. The React admin SPA (`admin/`) is hosted from a private S3 bucket fronted by CloudFront. Operators pre-build the bundle via `npm run build` before `terraform apply` — the module reads `admin/dist/` with `fileset(...)` at plan time and uploads each file as an `aws_s3_object`.

| Property                     | Dev                                  | Prod                                                                          |
| ---------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| S3 bucket                    | `ethiolink-dev-admin-frontend`       | `ethiolink-prod-admin-frontend`                                               |
| Public access                | fully blocked (OAC only)             | fully blocked (OAC only)                                                      |
| Bucket SSE                   | AES256                               | AES256                                                                        |
| CloudFront price class       | `PriceClass_100`                     | `PriceClass_200` (adds Cape Town + Mumbai edges — closer to Ethiopian users)  |
| Custom domain                | none (default CloudFront URL)        | `admin.ethiolink.app` via `var.admin_custom_domain` + ACM cert in `us-east-1` |
| SPA fallback                 | 403/404 → `/index.html` 200          | same                                                                          |
| `index.html` cache           | `no-cache, no-store, must-revalidate` | same                                                                         |
| Hashed asset cache           | `public, max-age=31536000, immutable` | same                                                                         |
| Force-TLS bucket policy      | yes                                  | yes                                                                           |
| Security headers policy      | HSTS + CSP + X-Frame-Options + Referrer-Policy + Permissions-Policy | same |

**Origin Access Control.** CloudFront uses `aws_cloudfront_origin_access_control` (OAC, sigv4-signed S3 reads) — the successor to the older Origin Access Identity (OAI). The bucket policy allows `s3:GetObject` only from the `cloudfront.amazonaws.com` service principal with `AWS:SourceArn` matching the distribution ARN, so a leaked bucket name still isn't readable from outside CloudFront.

**Pre-build step.** Operators must run, before `terraform apply`:
```bash
cd admin
# Set VITE_COGNITO_DOMAIN, VITE_COGNITO_ADMIN_CLIENT_ID,
# VITE_ADMIN_REDIRECT_URI, VITE_API_BASE_URL per environment.
npm ci
npm run build
```
The Vite bundle bakes the `VITE_*` env vars at build time, so the dev and prod bundles are different artifacts — CI builds twice, once per env, with the right outputs threaded in.

**Post-deploy invalidation.** Only `index.html` needs CloudFront invalidation after a deploy because every other file is content-hashed by Vite. Operators run:
```bash
aws cloudfront create-invalidation \
    --distribution-id $(terraform output -raw admin_frontend_distribution_id) \
    --paths "/index.html"
```

**Cognito callback URL coupling.** The Cognito module's `admin_callback_urls` must include the CloudFront URL (`https://<id>.cloudfront.net/login` in dev, `https://admin.ethiolink.app/login` in prod). Until that URL is registered, the hosted-UI redirect after sign-in fails with `redirect_mismatch`. The dev environment uses a two-apply pattern: first apply creates the distribution and surfaces the CloudFront URL via `terraform output admin_frontend_url`; the operator then updates `module.cognito.admin_callback_urls` to include the URL and re-applies.

**Security headers (Phase 8).** Every CloudFront response carries a five-header security baseline injected via an `aws_cloudfront_response_headers_policy` attached to both cache behaviors:

| Header                      | Value                                                                                                                          | Purpose                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload`                                                                                 | One-year HSTS, preload-eligible. Prevents protocol downgrade.                                                                                 |
| `X-Frame-Options`           | `DENY`                                                                                                                         | Click-jacking guard for older browsers. Paired with `frame-ancestors 'none'` in the CSP for newer ones.                                       |
| `X-Content-Type-Options`    | `nosniff`                                                                                                                      | Disables MIME sniffing — every asset is served with its declared `Content-Type` (see `local.content_types`).                                  |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                                                                                              | Keeps full URL paths inside the admin origin; outbound requests leak the origin only.                                                         |
| `Permissions-Policy`        | `camera=(), microphone=(), geolocation=(), payment=(), usb=()`                                                                 | Disables five powerful features the admin SPA never uses. Listed as a `custom_headers_config` item — `Permissions-Policy` isn't a first-class AWS field. |
| `Content-Security-Policy`   | dynamic (built from `api_gateway_origin` / `cognito_origin` / `media_public_origin`)                                          | See below.                                                                                                                                    |

The CSP body resolves to (with both origin variables populated):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https://<media-public-bucket>.s3.<region>.amazonaws.com;
font-src 'self' data:;
connect-src 'self' https://<api-id>.execute-api.<region>.amazonaws.com/<env> https://<env>.auth.<region>.amazoncognito.com;
form-action 'self' https://<env>.auth.<region>.amazoncognito.com;
frame-ancestors 'none';
base-uri 'self';
object-src 'none'
```

Notes on the policy choices:

- **No `unsafe-inline` or `unsafe-eval` on `script-src`.** The Vite production build emits hashed bundles only; nothing inline lives in the resulting `index.html` script tags. If a future Vite plugin re-introduces an inline script, the operator hash-pins it via `csp_extra_script_src` rather than adding `'unsafe-inline'`.
- **`style-src 'self' 'unsafe-inline'`.** Vite + Tailwind emit one inline `<style>` block in production for the splash-screen flash-of-unstyled-content guard. Hash-pinning the splash style is a follow-up; the in-bundle JS surface remains the high-value target.
- **`connect-src` allow-list driven by Terraform variables.** `api_gateway_origin` and `cognito_origin` are passed by each env stack so the SPA can `fetch` the API + complete the OAuth `/oauth2/token` exchange. Empty values drop the corresponding fragment so the CSP is always syntactically valid.
- **`form-action` lists Cognito.** The hosted-UI redirect is a `form` submission to the Cognito domain; without this fragment, the post-login redirect fails with a CSP violation.
- **`img-src` includes the public-media bucket.** Business cover photos + staff avatars are served from S3 directly today. A future CloudFront-fronted media origin would replace this entry.
- **`frame-ancestors 'none'`.** The admin SPA is never embedded; pairing the CSP directive with `X-Frame-Options: DENY` covers every browser version.

When the CSP needs to change, edit the `local.content_security_policy` block in `infra/terraform/modules/admin-frontend/main.tf`. CloudFront propagates the policy update within minutes — no SPA re-deploy needed.

### EventBridge

Provisioned by `infra/terraform/modules/eventbridge/`. One scheduled rule per environment driving the `scheduled-send-reminders` Lambda:

- **Rule.** `aws_cloudwatch_event_rule` with `schedule_expression = "cron(0/15 * * * ? *)"` — every 15 minutes in UTC. The Lambda handler does its own `Africa/Addis_Ababa` timezone math for the reminder-window arithmetic (`[now + 23h45m, now + 24h00m)`), so the rule's UTC schedule is correct as-is.
- **Target.** `aws_cloudwatch_event_target` pointing at the `scheduled-send-reminders` function ARN sourced from the Lambda module. No `input` / `input_transformer` — the handler's `ScheduledEvent` shape doesn't read the payload beyond `event.resources[0]` for logging.
- **Permission.** `aws_lambda_permission` grants the `events.amazonaws.com` service principal `lambda:InvokeFunction` on the function, scoped to the rule's ARN as the `source_arn`. Without it the rule fires but the invocation 403s.
- **Disable knob.** The module's `enabled` boolean (default `true`) flips the rule between `ENABLED` and `DISABLED` without removing the resource — useful for halting reminder dispatch in one environment while debugging.

A CloudWatch alarm on the rule's `FailedInvocations` metric lands alongside the rest of the alarms in the `cloudwatch` module commit.

### Secrets rotation

Provisioned by `infra/terraform/modules/secrets/`. The RDS master secret created in the `rds` module gets automatic 30-day rotation via the AWS-published `SecretsManagerRDSPostgreSQLRotationSingleUser` Lambda from the Serverless Application Repository (SAR).

**Mechanism.** `aws_serverlessapplicationrepository_cloudformation_stack` deploys AWS's published rotation Lambda into the application VPC (private subnets, `sg-lambda` security group — exactly the same network posture as the application Lambdas, because the rotation Lambda needs Postgres-wire access to `ALTER USER`). `aws_secretsmanager_secret_rotation` binds the RDS master secret to the rotation Lambda's ARN and schedules `automatically_after_days = 30`. The first rotation fires immediately after the module is applied — this validates the rotation Lambda actually works before the steady-state window opens.

**Cache caveat.** The application Lambdas cache the resolved secret at module scope (one cache per warm container, populated by `loadSecretsThenConfig` on cold start). When a rotation runs:

- AWS's rotation flow keeps the **previous** password valid until the next rotation (`AWSPREVIOUS` stage), so warm containers that still hold the old password continue to authenticate against RDS without errors.
- New cold starts pick up the rotated value automatically because `loadSecretsThenConfig` re-resolves on every cold start.
- The transition window where some containers have the old password and some have the new is therefore safe end-to-end. No application code changes needed.

**Disable knob.** `var.enabled = false` removes every resource the module creates. Useful for an environment temporarily holding rotation off while debugging an upstream issue.

**IAM scope.** The SAR template's rotation Lambda gets exactly the secret-specific permissions it needs (`secretsmanager:DescribeSecret` / `GetSecretValue` / `PutSecretValue` / `UpdateSecretVersionStage` scoped to the single secret ARN). The lone `secretsmanager:GetRandomPassword` action is on `*` because the API doesn't support resource-level scoping for that one.

### WAF

Provisioned by `infra/terraform/modules/waf/`. One regional WAFv2 Web ACL per environment, associated with the API Gateway stage ARN.

**Default action.** `allow {}` — anything not matched by the rules below passes through. The alternative (default-deny + explicit allow-list) is a post-MVP hardening choice.

**Managed rule groups** (`override_action { none {} }` on each — match decisions from the group itself are honored as-is rather than forced to `count`):

| Group                                          | Default state | Purpose                                                             |
| ---------------------------------------------- | ------------- | ------------------------------------------------------------------- |
| `AWSManagedRulesCommonRuleSet`                 | enabled       | OWASP-style baseline (SQLi, XSS, path traversal, etc.).             |
| `AWSManagedRulesKnownBadInputsRuleSet`         | enabled       | Known exploit payloads (log4j signatures, common scanners).         |
| `AWSManagedRulesAmazonIpReputationList`        | enabled       | AWS-maintained IP reputation feed of known-bad sources.             |
| `AWSManagedRulesBotControlRuleSet`             | **disabled**  | Behavioral bot defense (JA3/JA4, behavioral signals). Priced per-request — gate behind `enable_bot_control = true` once real traffic numbers justify the cost. Inspection level (`COMMON` or `TARGETED`) selected via `bot_control_inspection_level`. |

Each group has a module-level `enable_*` toggle. If a managed rule false-positives a legitimate request mid-incident, the operator has two knobs:

1. **Drop the whole group** by flipping the matching `enable_*` variable to `false`.
2. **Force a specific sub-rule to `COUNT`** (observability only, no block) via the per-group `*_count_overrides` list (`common_rule_set_count_overrides`, `known_bad_inputs_count_overrides`, `ip_reputation_count_overrides`, `bot_control_count_overrides`). Each list takes sub-rule names (e.g. `SizeRestrictions_BODY`, `CrossSiteScripting_QUERYARGUMENTS`). The canonical list comes from `aws wafv2 describe-managed-rule-group --vendor-name AWS --name <Group>` or the AWS console.

Both knobs are auditable in git rather than buried in a CloudWatch console toggle. To force a sub-rule to an action other than COUNT (e.g. CAPTCHA, ALLOW), edit `main.tf` directly — the `action_to_use` block accepts `allow {}` / `block {}` / `count {}` / `captcha {}` / `challenge {}`. The module's variable surface exposes COUNT only because it's the overwhelming operational use case; rarer overrides stay as explicit code changes to keep the variable surface small.

**Rate-based rules — layered (Phase 8 tuning).** Three rate-based rules layer from tightest-and-narrowest to widest-and-loosest. Each maintains its own per-IP counter; they're independent. A request that violates one but not the others trips only the offended rule. All three block on match with the standard WAFv2 5-minute window.

| Priority | Rule                       | Scope                                                                              | Default threshold (per IP / 5 min) | Variable                          | Purpose                                                                                                          |
| -------- | -------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 50       | `rate-limit-public-read`   | `method = GET` AND uri-path CONTAINS `/v1/categories` or `/v1/businesses`           | 600 (~2 req/sec sustained)         | `rate_limit_public_read_per_5min` | Tightest. Catches anonymous catalog scraping early. Set to `null` to disable the rule.                            |
| 60       | `rate-limit-write`         | `method != GET` (POST / PATCH / PUT / DELETE)                                       | 300 (~1 write/sec sustained)       | `rate_limit_write_per_5min`       | Catches booking-write abuse + login brute-force. Set to `null` to disable the rule.                               |
| 70       | `rate-limit-per-ip`        | every request (no scope-down)                                                       | 2000 (~6.7 req/sec sustained)      | `rate_limit_per_5min`             | Existing global fallback. Catches volumetric abuse that flies under the scope-down rules above.                   |

The 2000-req/5-min global rule is the Phase 7 default, preserved verbatim. The two scope-down rules are the Phase 8 additions. Tune each threshold via the env-stack variable (`waf_rate_limit_per_5min`, plus the two new `waf_rate_limit_*_per_5min` variables when wired) once the first load test surfaces real per-IP rates.

**Path-match implementation note.** The `rate-limit-public-read` rule uses `byte_match_statement` with `positional_constraint = CONTAINS` rather than `STARTS_WITH` because API Gateway prefixes the stage name (`/dev/v1/...`, `/prod/v1/...`). Containment match avoids per-env regex without sacrificing precision — the only places `/v1/categories` or `/v1/businesses` appear in URIs are at the API Gateway root.

**Observability.** Both the Web ACL and every rule have `cloudwatch_metrics_enabled = true` and `sampled_requests_enabled = true`. The `cloudwatch` module commit attaches alarms on `BlockedRequests` and per-rule-group block counts; `aws wafv2 get-sampled-requests` is the operator's mid-incident investigation surface.

**Scope.** `REGIONAL` — API Gateway REST APIs are regional. A CloudFront-fronted ACL would need `CLOUDFRONT` scope and live in `us-east-1`; the admin SPA distribution doesn't get WAF in this commit (low traffic, operator-only audience). Adding it later is a separate Web ACL + association in a follow-up.

### CloudWatch

Provisioned by `infra/terraform/modules/cloudwatch/`. The integration point that turns every upstream module's signals into operator-visible alarms + dashboards.

**Log groups.** Per-Lambda log groups are created by the Lambda module itself (30-day retention in dev, 90-day in prod). The CloudWatch module does not own log groups — it only consumes their metrics.

**SNS topic.** One topic per env (`ethiolink-${env}-alarms`). Every alarm in the module posts both on breach (`alarm_actions`) and on recovery (`ok_actions`) so the operator sees both edges. Optional email subscription gated by the env-level `alarm_email` variable — empty string skips the subscription (useful for the initial apply when no address is finalized). The address must click the AWS confirmation link before alerts deliver.

**Alarms** (every threshold is variabled so a real on-call event can tune without a module change):

| Alarm                                            | Source                            | Default threshold           | Rationale                                                                              |
| ------------------------------------------------ | --------------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| API Gateway 5xx                                  | `AWS/ApiGateway` `5XXError`       | ≥ 5 per 5 min               | Catches Lambda failures that surface to clients as 5xx.                                |
| Lambda errors (aggregate)                        | `AWS/Lambda` `Errors` (no dim)    | ≥ 5 per 5 min               | One alarm for "something is wrong"; the dashboard's per-function widgets are drilldown. |
| RDS CPU                                          | `AWS/RDS` `CPUUtilization`        | > 80% for 2× 5 min          | Usually the precursor to connection exhaustion.                                        |
| RDS connections                                  | `AWS/RDS` `DatabaseConnections`   | ≥ 80 for 2× 5 min           | Approaches Postgres `max_connections = 100`; tune up when RDS Proxy multiplexes more.  |
| RDS free storage                                 | `AWS/RDS` `FreeStorageSpace`      | < 5 GiB                     | Storage autoscaling should already be growing; this is the fallback alarm.             |
| EventBridge `FailedInvocations`                  | `AWS/Events` `FailedInvocations`  | ≥ 1 per 5 min               | Any single failure on the reminder rule is worth investigating.                        |
| WAF blocked requests                             | `AWS/WAFV2` `BlockedRequests`     | ≥ 100 per 5 min             | Real attack (rules working) or managed-rule false-positive (operator tunes).           |
| **SLO** booking-creation errors *(Phase 8)*       | `AWS/Lambda` `Errors{appointments-create}` | ≥ 3 per 5 min        | Fast-burn proxy for the booking-creation SLO (99.5% / 30 days). See `docs/operations/SLOs.md` §1. |
| **SLO** browse-latency p95 *(Phase 8)*            | `AWS/Lambda` `Duration{businesses-list}` p95 | > 800 ms for 2× 5 min | Fast-burn proxy for the browse-latency SLO (p95 < 800 ms / 7 days). See `docs/operations/SLOs.md` §2. |

The two SLO alarms are gated on the underlying function existing in the lambda module's `function_names` output — a renamed handler skips the alarm rather than blocking the apply. The `slo_alarm_names` output exposes the subset so the operator can mute them independently during a planned load test.

**Dashboards** (five total — Phase 8 adds `${env}-endpoints`):

| Dashboard                  | Widgets                                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${env}-api-gateway`       | Request volume + 4xx / 5xx counts; p50 / p95 latency.                                                                                                                                                                                              |
| `${env}-lambda`            | Aggregate errors + invocations + throttles; per-function error counts; per-function p95 duration.                                                                                                                                                  |
| `${env}-rds`               | CPU + connections (left / right axes); free storage; read/write IOPS + latency.                                                                                                                                                                    |
| `${env}-waf-eventbridge`   | WAF allowed / blocked counts; EventBridge `Invocations` + `FailedInvocations` on the reminder rule.                                                                                                                                                |
| `${env}-endpoints` *(Phase 8)* | Four row-pairs (errors + p95 latency) keyed by route family: **Browse** (`categories-list`, `businesses-list`, `businesses-get`, `services-list`, `staff-list`, `reviews-list-for-business`, `availability-get`, `availability-slots`), **Appointments** (every `appointments-*` handler — 9 functions), **Admin** (every `admin-*` handler — derived by prefix scan, 13 functions today), **Auth-sync** (`auth-sync`, `me-get`, `me-patch`). The Browse row's p95 widget carries a red annotation at the 800 ms SLO target. Maps cleanly onto the SLOs in `docs/operations/SLOs.md`. |

**Lambda alarm posture.** One aggregate alarm watches namespace-wide Lambda errors rather than 49 per-function alarms — the cost (~$5/env/month for 49 alarms) and notification noise (49 separate SNS pings on a shared-dependency outage) outweigh the per-function precision for MVP. The Lambda dashboard's per-function widgets are the drilldown when the aggregate alarm fires. Phase 8 adds **two** per-function alarms (on `appointments-create` and `businesses-list`) — only because they're the binding SLO indicators, not as a general posture shift.

**SLO surface.** `docs/operations/SLOs.md` is the authoritative source for SLO definitions, error-budget policy, and the operator review cadence. The two SLO-burn CloudWatch alarms above are the fast-burn proxies; the long-window numbers (99.5% / 30 days for booking creation, p95 < 800 ms / 7 days for browse, 99.9% / 30 days for categories, 99% / 30 days for reminders) are the post-hoc reckoning rather than the alerting surface.

### IAM

- One execution role per Lambda, scoped to only the resources that Lambda needs.
- A `deploy` role consumed by GitHub Actions OIDC for plan/apply.

## Configuration flow

Application config is provided to Lambdas via environment variables sourced from Terraform variables and Secrets Manager. The application reads its config from a single `loadConfig()` function in `backend/shared/config/` that validates required keys at startup. No hard-coded environment values anywhere in the code.

## Deployment pipeline

GitHub Actions workflows:

- `lint-test.yml` on every PR — runs ESLint, unit tests for backend, Flutter analyze + test, React lint + test. *(Phase 8 follow-up.)*
- `terraform-plan.yml` on PRs touching `infra/` — runs `terraform plan` against dev and posts the plan. *(Lives in the repo; activated by the bootstrap commit.)*
- `deploy-dev.yml` on merge to `main` — builds the Lambda zip, builds the admin SPA, applies dev Terraform, invokes the migration runner Lambda, invalidates the CloudFront `/index.html`, then runs the smoke test. *(Lives in the repo.)*
- `deploy-prod.yml` on manual dispatch with a `vX.Y.Z` tag — same step sequence as dev applied to prod with three independent gates (tag-shape regex, GitHub Actions `environment: prod` manual approval, OIDC role trust-condition filter on `:ref:refs/tags/v*`). Uses a separate `ethiolink-terraform-deploy-prod` IAM role.

### `deploy-dev.yml` flow

| Step                                | Notes                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Checkout + Node 20 + Terraform 1.6.6 | Standard CI runner setup.                                                                      |
| Configure AWS via OIDC              | Assumes the `ethiolink-terraform-deploy` role created by the bootstrap stack.                  |
| Build Lambda package                | `backend/scripts/package.sh` → `backend/dist/lambda.zip`.                                       |
| Build admin SPA                     | `cd admin && npm ci && npm run build`. `VITE_*` baked in from GitHub Actions secrets (see below). |
| `terraform init` + `apply`          | Against `infra/terraform/environments/dev` with `-auto-approve`.                               |
| Invoke migration Lambda             | `aws lambda invoke` on `maintenance-db-migrate`. Fails the deploy if `status != "success"`.    |
| CloudFront invalidation             | `aws cloudfront create-invalidation --paths "/index.html"`.                                     |
| Smoke test                          | `backend/scripts/smoke.sh` — three assertions, fails the deploy on any miss.                   |

### Required GitHub Actions secrets

Set under **Settings → Secrets and variables → Actions → Repository secrets**:

| Secret                                | Value                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `AWS_ACCOUNT_ID`                      | 12-digit AWS account id (from the bootstrap apply).                                          |
| `DEV_VITE_COGNITO_DOMAIN`             | `https://<hosted-ui-domain>.auth.eu-west-1.amazoncognito.com` (from `terraform output cognito_hosted_ui_domain`). |
| `DEV_VITE_COGNITO_ADMIN_CLIENT_ID`    | From `terraform output cognito_admin_app_client_id`.                                         |
| `DEV_VITE_ADMIN_REDIRECT_URI`         | The CloudFront URL with `/login` appended (e.g. `https://<id>.cloudfront.net/login`).        |
| `DEV_VITE_API_BASE_URL`               | From `terraform output api_gateway_invoke_url`.                                              |
| `PROD_VITE_COGNITO_DOMAIN`            | Same shape as the dev secret, sourced from the prod env's `terraform output`.                |
| `PROD_VITE_COGNITO_ADMIN_CLIENT_ID`   | From the prod env's `terraform output cognito_admin_app_client_id`.                          |
| `PROD_VITE_ADMIN_REDIRECT_URI`        | `https://admin.ethiolink.app/login` once the alias is wired, else the CloudFront URL.        |
| `PROD_VITE_API_BASE_URL`              | From the prod env's `terraform output api_gateway_invoke_url`.                               |

The `VITE_*` values come from a previous Terraform apply — the operator captures them once after the initial bootstrap and stores them as secrets. CI bakes them into every subsequent admin bundle.

### `deploy-prod.yml` flow

Triggered manually via **Actions → deploy-prod → Run workflow** with a required `tag` input. The workflow validates the tag matches `vX.Y.Z` before any AWS calls and refuses to proceed otherwise. After validation:

| Step                                  | Notes                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Validate tag format                   | Regex `^v[0-9]+\.[0-9]+\.[0-9]+$`. Fails fast on bad input.                                          |
| Checkout at the tag                   | `actions/checkout@v4` with `ref: ${{ inputs.tag }}` — puts the workflow in the tag's ref, which is what the OIDC trust condition requires. |
| Configure AWS via OIDC                | Assumes `ethiolink-terraform-deploy-prod`. The role's trust policy filters `sub` to `:ref:refs/tags/v*` — push-to-main runs are rejected. |
| Build Lambda + admin                  | Same scripts as dev; admin uses `PROD_VITE_*` secrets.                                              |
| `terraform init` + `apply`            | Against `infra/terraform/environments/prod`.                                                       |
| Invoke migration Lambda               | Against the prod RDS via the migration runner; fails the deploy on `status != "success"`.          |
| CloudFront `/index.html` invalidation | Same as dev.                                                                                       |
| Smoke test                            | `backend/scripts/smoke.sh` against the prod invoke URL + reminder function name.                   |

Three independent gates protect prod: (1) the tag-shape regex inside the workflow, (2) the GitHub Actions `environment: prod` manual-approval prompt that pauses the job pending a designated reviewer, (3) the OIDC `sub` claim filter on the deploy role. Any one of the three failing blocks the apply.

### Tightening the prod role

The `ethiolink-terraform-deploy-prod` role currently carries `AdministratorAccess` as a deliberate temporary choice. The follow-up commit captures the call set from the first clean prod apply via CloudTrail and replaces the managed-policy attachment with a generated least-privilege policy. The dev role gets the same treatment in the same commit.

### Smoke test

`backend/scripts/smoke.sh` is the post-deploy validation surface. Three assertions:

1. `GET ${INVOKE_URL}/v1/categories` returns HTTP 200 with a JSON `items` array — exercises API Gateway routing, the categories Lambda, RDS connectivity, and the seed data.
2. `POST ${INVOKE_URL}/v1/auth/sync` without an `Authorization` header returns HTTP 401 — asserts the Cognito authorizer is wired correctly.
3. `aws lambda invoke` against the scheduled-reminder Lambda returns a JSON response with `scanned` / `sent` / `skipped` / `failed` keys — validates the scheduled lambda's cold-start + DB connection + return shape without waiting for the 15-minute cron.

A non-zero exit fails the deploy workflow. Operators can invoke the same script locally:

```bash
INVOKE_URL=https://<api-id>.execute-api.eu-west-1.amazonaws.com/dev \
REMINDER_FUNCTION_NAME=ethiolink-dev-scheduled-send-reminders \
    bash backend/scripts/smoke.sh
```

## KMS posture

Phase 9 Track 4 introduces customer-managed KMS keys (CMKs) — one per consuming service — replacing the AWS-managed keys that shipped through Phase 8. **As of the `Phase 9: add KMS module` commit the keys exist but are unused**; consumer modules (rds, s3, secrets, lambda) still encrypt under the AWS-managed defaults until the follow-up commit threads the CMK ARNs through their `kms_key_*` inputs and the operator runs the re-encryption runbook.

### Module + keys

Provisioned by `infra/terraform/modules/kms/`. Six keys, each a `SYMMETRIC_DEFAULT` `ENCRYPT_DECRYPT` AES-GCM 256 key with annual AWS-managed rotation:

| Service slug          | Alias (dev / prod)                                  | Consumer (post-wiring)                                     | Key-policy use grant                                                      |
| --------------------- | --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `rds`                 | `alias/ethiolink-${env}-rds`                        | RDS Postgres storage + `ethiolink/${env}/rds/master` secret | `rds.amazonaws.com`, fenced by `kms:ViaService = rds.${region}.amazonaws.com` |
| `s3_media`            | `alias/ethiolink-${env}-s3-media`                   | `media-public` + `media-private` buckets                   | `s3.amazonaws.com`, fenced by `kms:ViaService = s3.${region}.amazonaws.com` |
| `s3_logs`             | `alias/ethiolink-${env}-s3-logs`                    | Server-access-logs bucket                                  | `s3.amazonaws.com` + `logging.s3.amazonaws.com` (delivery service)        |
| `s3_admin_frontend`   | `alias/ethiolink-${env}-s3-admin-frontend`          | Admin SPA bucket                                           | `s3.amazonaws.com` + `cloudfront.amazonaws.com` (OAC reads) fenced by `aws:SourceAccount` |
| `secrets`             | `alias/ethiolink-${env}-secrets`                    | Secrets Manager entries                                    | `secretsmanager.amazonaws.com`, fenced by `kms:ViaService`                |
| `lambda_env`          | `alias/ethiolink-${env}-lambda-env`                 | Lambda environment-variable blobs                          | `lambda.amazonaws.com`, fenced by `kms:ViaService`                        |

Every key also carries the standard "account root can administer this key" statement (`kms:*` for `arn:aws:iam::${account_id}:root`) — without it the operator has no recovery path if a per-service grant turns out to be wrong, and a key with no admin statement is undeleteable from the console.

### Key-rotation + deletion guardrails

- **Rotation.** `enable_key_rotation = true` on every key. AWS rotates the backing key material annually with no operator action required. Historical ciphertexts stay decryptable through the rotation event because AWS retains the previous backing key material against the same key id.
- **Deletion window.** `deletion_window_in_days` defaults to 30 in prod, set to 7 in dev (faster throwaway). This is the period AWS waits after a `ScheduleKeyDeletion` call before the key is irrevocably destroyed; during the window `CancelKeyDeletion` recovers the key intact.
- **`prevent_destroy = true`** on every `aws_kms_key` resource. The Terraform-side guard is the hard "you cannot `terraform destroy` this by mistake"; the deletion window is the AWS-side recovery net for a `ScheduleKeyDeletion` call that did make it through.

### Outputs

The module exposes:

- Per-service ARN + key id (`rds_key_arn` / `rds_key_id`, etc.).
- Aggregated maps `key_arns`, `key_ids`, `alias_names` keyed by service slug, useful for the env stack to print a single block of every CMK in the env and for future observability dashboards to enumerate keys without naming each one explicitly.

Both env stacks (`environments/dev/main.tf`, `environments/prod/main.tf`) construct the module and re-export `kms_key_arns` + `kms_alias_names`. The outputs stand by unused — the consumer modules don't read them yet — by design: the first apply in each environment provisions the keys without disturbing any existing data, so the operator can review a clean Terraform plan before any data moves.

### What the module commit did NOT do (historical context)

The first Track 4 commit (`Phase 9: add KMS module`) deliberately landed the keys with no consumer wiring. That commit's plan was zero `Modify` / `Replace` actions on existing resources — six new keys + six new aliases only. The wiring commit below picks up from there.

### Wiring (`Phase 9: wire CMKs through consumers`)

Each consumer module now accepts a nullable KMS input that defaults to `null` (preserves AWS-managed encryption — no behavior change when unset). The env stacks pass `module.kms.<service>_key_arn` to each input. The shape per consumer:

| Module                                 | Inputs added                                                                                     | Behavior when set                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/terraform/modules/rds`          | `kms_key_id`, `secrets_kms_key_id`                                                               | `aws_db_instance.this.kms_key_id` + `aws_secretsmanager_secret.master.kms_key_id` flip to the CMK. The DB-instance change cannot in-place re-encrypt — Terraform reports drift; the snapshot+restore runbook is the data-move path. The secret's next version write encrypts under the CMK. |
| `infra/terraform/modules/s3`           | `media_kms_key_arn`, `logs_kms_key_arn`                                                          | The `media-public`, `media-private`, and `logs` buckets' default SSE flips from `AES256` to `aws:kms` with `kms_master_key_id` + `bucket_key_enabled = true`. Existing objects keep prior encryption; new writes use the CMK. |
| `infra/terraform/modules/admin-frontend` | `kms_key_arn`                                                                                  | The admin SPA bucket flips to SSE-KMS. CloudFront OAC reads continue to work because the `s3_admin_frontend` CMK policy grants `cloudfront.amazonaws.com` `kms:Decrypt` fenced by `aws:SourceAccount`. |
| `infra/terraform/modules/secrets`      | `secrets_kms_key_arn`                                                                            | An inline `kms:Decrypt` policy is attached to the SAR-deployed rotation Lambda's execution role (looked up by name extracted from the function's `role` ARN) so rotations continue after the secret flips to the CMK. |
| `infra/terraform/modules/lambda`       | `env_kms_key_arn`, `secrets_kms_key_arn`, `s3_media_kms_key_arn`                                 | Every `aws_lambda_function.function` gets `kms_key_arn = env_kms_key_arn` (env-var blob re-encrypts in place on the next apply). Every per-domain role gets `kms:Decrypt` on the secrets CMK so cold-start `loadSecretsThenConfig` can resolve the RDS master secret. The `media` role gets `kms:Decrypt` + `kms:GenerateDataKey*` on the media-bucket CMK so PutObject / GetObject paths against SSE-KMS buckets keep working. |

The new IAM policies all use a `kms:ViaService` condition (`secretsmanager.${region}.amazonaws.com` or `s3.${region}.amazonaws.com`) so the grant only applies when the call comes through the named service — matching the `kms:ViaService` fence on the corresponding `kms` module key policy.

### What the wiring commit does NOT do

- Does not move any existing data at rest from the AWS-managed key to a CMK. The RDS instance flags drift but does not in-place re-encrypt; S3 objects already in the buckets keep their previous encryption; the existing version of each Secrets Manager secret remains under the old key until the next rotation.

### Data move — KMS migration runbook

The maintenance-window data move is documented at [`docs/operations/runbooks/kms-migration.md`](../operations/runbooks/kms-migration.md). The runbook covers:

- Pre-flight checklist (Terraform plan review, RDS pre-snapshot, S3 object-count baselines, Secrets Manager version capture, Lambda smoke baseline, alarm + window confirmation).
- RDS re-encryption via snapshot copy under the new CMK, restore from copy, cutover (Option A: `terraform import`; Option B: rename) with a 10–20 minute read-only window.
- S3 re-encryption via `aws s3 cp s3://bucket/ s3://bucket/ --recursive --metadata-directive REPLACE --sse aws:kms --sse-kms-key-id <arn>` per bucket, including the `media-public` / `media-private` / `logs` (with the today-prefix exclude trick) / `admin-frontend` (with a CloudFront invalidation chaser) flavors.
- Secrets Manager re-encryption via forced rotation (RDS master) or no-op `put-secret-value` (non-rotating secrets).
- Lambda env-var verification — the wiring commit already re-encrypted at rest; the runbook documents the spot-check.
- End-to-end verification (resource-level + smoke + manual booking happy path) + per-resource rollback.
- Dev-first execution + prod maintenance-window pattern (two operators on the bridge, Saturday 06:00–09:00 EAT, 72-hour pre-snapshot retention).
- Known risks: RDS endpoint change vs. cached Lambda env (R1), SSE-KMS cost (R2), IAM `AccessDenied` (R3), SAR rotation Lambda perms (R4), pre-snapshot deletion timing (R5), `aws s3 cp` mid-flight on the logs bucket (R6).

## Disaster recovery

The DR procedure is documented in [`docs/operations/DR_RUNBOOK.md`](../operations/DR_RUNBOOK.md). Highlights:

- **Recovery target.** 60 minutes from "RDS lost" to "API serving from a restored database" — the Phase 8 acceptance criterion. Total expected wall-clock under the documented procedure is ~43 minutes, leaving headroom for unexpected steps.
- **Primary recovery path.** Terraform-driven in-place restore from the most recent RDS automated snapshot. The `aws_db_instance.snapshot_identifier` field is set on a branch, applied, then unset on a follow-up commit once recovery is stable.
- **Verification chain.** Migration runner + smoke test (`backend/scripts/smoke.sh`) prove the restored DB is reachable end-to-end before declaring recovery complete.
- **Backup verification.** A monthly `.github/workflows/backup-verify.yml` workflow identifies the most recent automated snapshot, asserts it's less than ~30 hours old, checks the engine + encryption descriptors, and reports to the GitHub step summary. The full-restore mode (provision scratch instance → row-count compare → tear-down) is documented scaffolding gated behind a `workflow_dispatch.inputs.full_restore = true` flag; the scratch Terraform workspace itself ships in a Phase 8.5 follow-up.
- **Daily logical backups (`pg_dump`) to S3.** Belt-and-braces on top of RDS automated snapshots — restorable even if the regional RDS service has an issue. Phase 8 follow-up; not in this commit. The `dbBackup` Lambda + EventBridge daily schedule + per-day S3 prefix all mirror the existing migration-runner pattern.
- **Quarterly DR drill.** Manual operator-led exercise restoring prod into a scratch account, end-to-end timed. Cadence + checklist live in the runbook.
