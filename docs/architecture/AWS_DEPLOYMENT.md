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

**IAM grouping.** One shared `ethiolink-${env}-lambda-exec` role for every function in the env. Carries the AWS-managed VPC access policy (logs + ENI), an inline policy that grants `secretsmanager:GetSecretValue` on the RDS master secret only, and `s3:GetObject` / `s3:PutObject` on both media buckets plus `s3:DeleteObject` on the private bucket. Per-domain or per-function role splitting is a follow-up commit paired with API Gateway (the first call site where the over-permissive role becomes observable).

**Log groups.** One CloudWatch log group per function at `/aws/lambda/<function-name>` with environment-specific retention (30 days dev / 90 days prod). Explicit `aws_cloudwatch_log_group` resources rather than letting Lambda auto-create — auto-created groups default to "never expire", which is cost-hostile.

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

### EventBridge

Provisioned by `infra/terraform/modules/eventbridge/`. One scheduled rule per environment driving the `scheduled-send-reminders` Lambda:

- **Rule.** `aws_cloudwatch_event_rule` with `schedule_expression = "cron(0/15 * * * ? *)"` — every 15 minutes in UTC. The Lambda handler does its own `Africa/Addis_Ababa` timezone math for the reminder-window arithmetic (`[now + 23h45m, now + 24h00m)`), so the rule's UTC schedule is correct as-is.
- **Target.** `aws_cloudwatch_event_target` pointing at the `scheduled-send-reminders` function ARN sourced from the Lambda module. No `input` / `input_transformer` — the handler's `ScheduledEvent` shape doesn't read the payload beyond `event.resources[0]` for logging.
- **Permission.** `aws_lambda_permission` grants the `events.amazonaws.com` service principal `lambda:InvokeFunction` on the function, scoped to the rule's ARN as the `source_arn`. Without it the rule fires but the invocation 403s.
- **Disable knob.** The module's `enabled` boolean (default `true`) flips the rule between `ENABLED` and `DISABLED` without removing the resource — useful for halting reminder dispatch in one environment while debugging.

A CloudWatch alarm on the rule's `FailedInvocations` metric lands alongside the rest of the alarms in the `cloudwatch` module commit.

### WAF

Provisioned by `infra/terraform/modules/waf/`. One regional WAFv2 Web ACL per environment, associated with the API Gateway stage ARN.

**Default action.** `allow {}` — anything not matched by the rules below passes through. The alternative (default-deny + explicit allow-list) is a Phase 8 hardening choice.

**Managed rule groups** (`override_action { none {} }` on each — match decisions from the group itself are honored as-is rather than forced to `count`):

| Group                                          | Purpose                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `AWSManagedRulesCommonRuleSet`                 | OWASP-style baseline (SQLi, XSS, path traversal, etc.).             |
| `AWSManagedRulesKnownBadInputsRuleSet`         | Known exploit payloads (log4j signatures, common scanners).         |
| `AWSManagedRulesAmazonIpReputationList`        | AWS-maintained IP reputation feed of known-bad sources.             |

Each group has a module-level `enable_*` toggle (default `true`). If a managed rule false-positives a legitimate request mid-incident, the operator sets the corresponding flag to `false` and re-applies — the change is auditable in git rather than buried in a CloudWatch console toggle.

**Rate-based rule.** Per source IP, blocks for 5 minutes once the IP exceeds `rate_limit_per_5min` requests (default 2000 — ~6.7 req/sec sustained per IP; generous for legitimate clients, restrictive for trivial scrapers). The block action returns 403 to the offending IP. Tune via the env-level `waf_rate_limit_per_5min` variable once the first load test surfaces real per-IP rates.

**Observability.** Both the Web ACL and every rule have `cloudwatch_metrics_enabled = true` and `sampled_requests_enabled = true`. The `cloudwatch` module commit attaches alarms on `BlockedRequests` and per-rule-group block counts; `aws wafv2 get-sampled-requests` is the operator's mid-incident investigation surface.

**Scope.** `REGIONAL` — API Gateway REST APIs are regional. A CloudFront-fronted ACL would need `CLOUDFRONT` scope and live in `us-east-1`; the admin SPA distribution doesn't get WAF in this commit (low traffic, operator-only audience). Adding it later is a separate Web ACL + association in a follow-up.

### CloudWatch

Provisioned by `infra/terraform/modules/cloudwatch/`. The integration point that turns every upstream module's signals into operator-visible alarms + dashboards.

**Log groups.** Per-Lambda log groups are created by the Lambda module itself (30-day retention in dev, 90-day in prod). The CloudWatch module does not own log groups — it only consumes their metrics.

**SNS topic.** One topic per env (`ethiolink-${env}-alarms`). Every alarm in the module posts both on breach (`alarm_actions`) and on recovery (`ok_actions`) so the operator sees both edges. Optional email subscription gated by the env-level `alarm_email` variable — empty string skips the subscription (useful for the initial apply when no address is finalized). The address must click the AWS confirmation link before alerts deliver.

**Alarms** (every threshold is variabled so a real on-call event can tune without a module change):

| Alarm                              | Source                          | Default threshold           | Rationale                                                                              |
| ---------------------------------- | ------------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| API Gateway 5xx                    | `AWS/ApiGateway` `5XXError`     | ≥ 5 per 5 min               | Catches Lambda failures that surface to clients as 5xx.                                |
| Lambda errors (aggregate)          | `AWS/Lambda` `Errors` (no dim)  | ≥ 5 per 5 min               | One alarm for "something is wrong"; the dashboard's per-function widgets are drilldown. |
| RDS CPU                            | `AWS/RDS` `CPUUtilization`      | > 80% for 2× 5 min          | Usually the precursor to connection exhaustion.                                        |
| RDS connections                    | `AWS/RDS` `DatabaseConnections` | ≥ 80 for 2× 5 min           | Approaches Postgres `max_connections = 100`; tune up when RDS Proxy multiplexes more.  |
| RDS free storage                   | `AWS/RDS` `FreeStorageSpace`    | < 5 GiB                     | Storage autoscaling should already be growing; this is the fallback alarm.             |
| EventBridge `FailedInvocations`    | `AWS/Events` `FailedInvocations` | ≥ 1 per 5 min              | Any single failure on the reminder rule is worth investigating.                        |
| WAF blocked requests               | `AWS/WAFV2` `BlockedRequests`   | ≥ 100 per 5 min             | Real attack (rules working) or managed-rule false-positive (operator tunes).           |

**Dashboards** (four total):

| Dashboard             | Widgets                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `${env}-api-gateway`  | Request volume + 4xx / 5xx counts; p50 / p95 latency.                                                                  |
| `${env}-lambda`       | Aggregate errors + invocations + throttles; per-function error counts; per-function p95 duration.                      |
| `${env}-rds`          | CPU + connections (left / right axes); free storage; read/write IOPS + latency.                                        |
| `${env}-waf-eventbridge` | WAF allowed / blocked counts; EventBridge `Invocations` + `FailedInvocations` on the reminder rule.                 |

**Lambda alarm posture.** One aggregate alarm watches namespace-wide Lambda errors rather than 49 per-function alarms — the cost (~$5/env/month for 49 alarms) and notification noise (49 separate SNS pings on a shared-dependency outage) outweigh the per-function precision for MVP. The Lambda dashboard's per-function widgets are the drilldown when the aggregate alarm fires. Per-function alarms on a handful of critical handlers (booking lifecycle, scheduled-reminder) are a Phase 8 follow-up.

### IAM

- One execution role per Lambda, scoped to only the resources that Lambda needs.
- A `deploy` role consumed by GitHub Actions OIDC for plan/apply.

## Configuration flow

Application config is provided to Lambdas via environment variables sourced from Terraform variables and Secrets Manager. The application reads its config from a single `loadConfig()` function in `backend/shared/config/` that validates required keys at startup. No hard-coded environment values anywhere in the code.

## Deployment pipeline (target state, built out in Phase 7)

GitHub Actions workflows:

- `lint-test.yml` on every PR — runs ESLint, unit tests for backend, Flutter analyze + test, React lint + test.
- `terraform-plan.yml` on PRs touching `infra/` — runs `terraform plan` against dev and posts the plan.
- `deploy-dev.yml` on merge to `main` — `terraform apply` to dev, deploy Lambdas, run smoke tests.
- `deploy-prod.yml` on manual dispatch with a release tag — same as dev, applied to prod with an approval gate.

## Disaster recovery (target state, Phase 8)

- Daily logical backups (`pg_dump`) to S3 in addition to RDS automated snapshots.
- Documented runbook to restore RDS from snapshot and re-point API Gateway to a recovered Lambda set.
- Quarterly DR drill that restores prod to a scratch environment.
