# EthioLink — Phase 8 security review

This document is the signed-off security baseline produced by the Phase 8 hardening pass. It captures the production-ready posture across the four review surfaces (auth, transport, identity, supply chain), records each finding, and lists the items deliberately deferred with a documented mitigation or follow-up commit.

The review is intentionally focused on the MVP surface. The system has no PII beyond email + phone + name, no payment-card data (only `payment_intents` rows with provider-side identifiers; CASH is the dominant flow), and no protected-class attributes. The bar is "production-ready for an Ethiopian beauty / salon / spa marketplace serving end customers and small-business owners" — not "FedRAMP".

## Scope

In scope:

- API Gateway authorization matrix (public vs Cognito-authenticated vs role-gated).
- Cognito password + MFA posture.
- Admin SPA browser-side security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy).
- Lambda IAM least-privilege scope.
- S3 bucket public-access posture.
- WAF baseline.
- Secrets handling (RDS master + future third-party keys).

Out of scope (with a recorded reason):

- Customer-managed KMS keys — see "Deferred — KMS" below.
- Pen test — separate engagement, scheduled after the first prod deploy.
- Bug-bounty program — post-MVP.
- SOC-2 audit — post-MVP.

## Authorization matrix audit

The authoritative route table lives in `infra/terraform/modules/api-gateway/main.tf` `locals.routes`. Every route has an `auth = "PUBLIC" | "COGNITO"` flag that drives the `aws_api_gateway_method.authorization` value (`NONE` vs `COGNITO_USER_POOLS`). Role-level enforcement happens at the application layer — the table below records the per-route decision tree.

### Public routes (8) — `authorization = "NONE"`

| Method | Path                                                                     | Handler                                                          | Rationale                                                                                       |
| ------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/v1/categories`                                                         | `categories-list`                                                | Marketplace browsing; the list of business categories is intentionally public.                  |
| GET    | `/v1/businesses`                                                         | `businesses-list`                                                | Marketplace browsing; lists only `APPROVED` businesses (see `businessRepository`).              |
| GET    | `/v1/businesses/{businessId}`                                            | `businesses-get`                                                 | Marketplace browsing; returns 404 unless `status = 'APPROVED'`.                                 |
| GET    | `/v1/businesses/{businessId}/reviews`                                    | `reviews-list-for-business`                                      | Reviews are public on `APPROVED` businesses only — handler refuses other statuses.              |
| GET    | `/v1/businesses/{businessId}/services`                                   | `services-list`                                                  | Service catalog of an `APPROVED` business — public so visitors can browse without an account.   |
| GET    | `/v1/businesses/{businessId}/staff`                                      | `staff-list`                                                     | Staff roster of an `APPROVED` business — public for the same reason.                            |
| GET    | `/v1/businesses/{businessId}/staff/{staffId}/availability`               | `availability-get`                                               | Working hours — public so the booking funnel can render before sign-in.                         |
| GET    | `/v1/businesses/{businessId}/staff/{staffId}/slots`                      | `availability-slots`                                             | Computed available time slots — public so the slot-picker renders for unauthenticated visitors. |

**Status enforcement.** Every public read enforces `business.status = 'APPROVED'` at the repository layer. A `PENDING`, `REJECTED`, or `SUSPENDED` business is not returned by any public route. Verified by grepping for `'APPROVED'` filters in `backend/shared/domains/businesses/businessRepository.ts` and the per-domain repositories. No public route returns any customer PII.

### Cognito-authenticated routes (40) — `authorization = "COGNITO_USER_POOLS"`

The API Gateway authorizer extracts the bearer token from `Authorization: Bearer <id_token>`, validates the signature against the user pool's JWKS, and rejects expired or malformed tokens with `401` before the Lambda is invoked. Each handler then reads the principal from `event.requestContext.authorizer.claims` via `extractPrincipal` (`backend/shared/http/principal.ts`).

The 40 authenticated routes split into three role-gating patterns:

#### Owner-only routes (15)

Business write paths under `/v1/businesses/...` (create, patch, submit, services CRUD, staff CRUD, availability) and the owner-side booking read (`GET /v1/businesses/{businessId}/appointments`). Authorization rule: caller's `users.id` must equal `businesses.owner_user_id` for the target business. Enforced by every service-layer call via `assertOwnerOfBusiness` / equivalents that consult the `businesses` row. Cross-business access (caller owns business A, requests business B) returns `404 NOT_FOUND` (we deliberately don't differentiate "doesn't exist" from "exists, not yours" to avoid an enumeration oracle).

#### Customer-or-owner routes (12)

Booking lifecycle (`/v1/appointments/...` create, accept, reject, cancel, reschedule, complete, review) + `/v1/me*`. Two-party authorization model:

- Customer actions (`POST /v1/appointments` create, `POST .../cancel` by customer, `POST .../reschedule` by customer, `POST .../review`): caller must equal `appointments.customer_user_id`.
- Owner actions (`POST .../accept`, `.../reject`, `.../complete`, `POST .../cancel` by owner, `.../reschedule` by owner): caller must own `appointments.business_id`.

Enforced by `appointmentService` at every transition. The `appointmentStateMachine` separately refuses transitions from the wrong state (e.g. `accept` on an already-`COMPLETED` booking returns `409 INVALID_TRANSITION`). Customers cannot see other customers' bookings; owners cannot see other owners' bookings.

#### Admin-only routes (13)

Every path under `/v1/admin/*`. Three-layer gate:

1. API Gateway requires a valid Cognito token (rejected with 401 otherwise).
2. Lambda runs `authorizeAdmin` (`backend/lambdas/admin/_authz.ts`) which refuses any caller whose `principal.role !== 'ADMIN'` with `403 FORBIDDEN`. The role is derived from the user's Cognito groups via `ROLE_PRECEDENCE = ['ADMIN', 'BUSINESS_OWNER', 'CUSTOMER']` — highest-precedence wins.
3. Admin SPA's `ProtectedRoute` (`admin/src/components/ProtectedRoute.tsx`) refuses non-admins client-side so non-admin users never reach the admin pages even if they hold a valid token. (Defense-in-depth; the server check is the binding one.)

Every admin write also inserts an `admin_actions` audit row keyed by the admin's `user_id`, the affected entity id, the action taken, and a free-text reason. No admin endpoint deletes the audit row.

### Cross-cutting observations

- **No "anonymous write" route.** Every state-changing route requires Cognito auth. The public read routes are read-only.
- **No tenancy leakage.** Owner-only and customer-or-owner routes confirm both the principal identity AND the row ownership at the service layer; the API Gateway authorizer only proves authenticity, not authorization.
- **Path-parameter normalization.** The `/v1/businesses/{businessId}/...` segment uses one consistent variable name across all routes (see `AWS_DEPLOYMENT.md` for the rationale). Handler code reads `event.pathParameters.businessId` consistently. The four originally-divergent handlers (`businesses/get`, `patch`, `submit`, `reviews/listForBusiness`) were normalized in the API Gateway commit.
- **OPTIONS preflights are open.** Every resource with a non-OPTIONS method has an `OPTIONS` mock integration that returns the standard `Access-Control-Allow-*` headers. The CORS origin allow-list is environment-scoped (dev: `http://localhost:5173`; prod: `https://admin.ethiolink.app`). Browsers enforce this — non-browser callers ignore CORS entirely (which is correct; CORS is not an auth mechanism).

### Known exceptions

- **`/v1/auth/sync`** — Authenticated but role-less; called by any newly-signed-in user to create their `users` row from the Cognito token. Idempotent; no PII surfaced beyond the caller's own claims.
- **Migration runner Lambda** — Not exposed via API Gateway. Invoked by operators via `aws lambda invoke`. Role-gated by IAM (the deploy role has invoke permission; nobody else does).
- **Scheduled reminder Lambda** — Not exposed via API Gateway. Invoked by EventBridge with a resource-policy `aws_lambda_permission` scoped to the specific rule ARN.

## Cognito hardening

| Property                          | Pre-Phase-8 value      | Phase 8 value          | Notes                                                                                                                       |
| --------------------------------- | ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `password_policy.minimum_length`  | 10                     | **12**                 | Tightened to the production-ready default. Existing users keep their credentials until the next password change.            |
| `password_policy.require_symbols` | false                  | **true**               | All four character classes now required (lowercase + uppercase + digit + symbol).                                           |
| `password_policy.require_*` (others) | true                | true (unchanged)       | Lowercase + uppercase + digit were always required.                                                                         |
| `temporary_password_validity_days` | 7                     | 7 (unchanged)          | Admin-created users have a 7-day window to set a permanent password.                                                        |
| `mfa_configuration`               | OPTIONAL               | OPTIONAL (unchanged)   | Per-user enrollment via the hosted UI.                                                                                      |
| `software_token_mfa_configuration.enabled` | true          | true (unchanged)       | TOTP via any authenticator app (Google Authenticator, 1Password, Authy, etc.).                                              |
| `account_recovery_setting`        | email > phone          | email > phone (unchanged) | Verified email is the primary recovery channel; verified phone is the fallback.                                         |
| `admin_create_user_config.allow_admin_create_user_only` | false | false (unchanged) | Self-service signups are allowed (the marketplace requires it). Admin-created users are still possible via the API. |
| `prevent_user_existence_errors`   | ENABLED                | ENABLED (unchanged)    | Cognito returns a generic "invalid credentials" rather than "user does not exist" to non-existence-probe attempts.          |
| `enable_token_revocation`         | true                   | true (unchanged)       | Refresh tokens can be revoked server-side (e.g. on password change).                                                        |

**MFA enrollment operator step.** Software-token MFA is enabled at the user pool level, but each `ADMIN` user must enroll individually. The flow is:

1. Admin signs in via the hosted UI (or the SPA, which redirects through the hosted UI).
2. Navigate to **Account settings** in the hosted UI's user dropdown.
3. Click **Set up MFA**, select **Authenticator app**.
4. Scan the QR code (or copy the base32 secret) into an authenticator app.
5. Enter the six-digit code to verify enrollment.

After enrollment, the next sign-in challenges for a TOTP code. The operator should enroll MFA on every `ADMIN` account before the next prod deploy. Once every `ADMIN` has enrolled, the next-step hardening is to flip `mfa_configuration` from `OPTIONAL` to `ON` — a one-line Terraform change. We're holding off until enrollment is confirmed across the team because flipping it before then locks the unenrolled admin out of the dashboard.

**App-client posture.**

- Both clients (`ethiolink-${env}-mobile`, `ethiolink-${env}-admin`) are public PKCE clients. `generate_secret = false` on both.
- A "confidential" admin client with a secret was considered and rejected — the SPA runs the OAuth flow in-browser, so any embedded secret is just a public string. The PKCE flow (code → code-verifier → token) is the correct posture for any in-browser client.
- `prevent_user_existence_errors = ENABLED` on both clients — Cognito returns a generic error to non-existence probes.
- `enable_token_revocation = true` on both clients.
- `allowed_oauth_scopes` is the minimal set per client. Mobile gets `openid email phone profile`; admin gets `openid email profile` (no phone — admin staff identity is email-only).

## Admin SPA security headers

Every admin SPA response (S3-served or SPA-fallback) carries a five-header security baseline injected by an `aws_cloudfront_response_headers_policy` attached to both cache behaviors. Full table + CSP body in `docs/architecture/AWS_DEPLOYMENT.md` under "Admin frontend → Security headers (Phase 8)". The summary verification points:

- **HSTS preload-eligible.** `max-age=31536000; includeSubDomains; preload` qualifies the host for browser HSTS-preload lists. Submission to `hstspreload.org` is deferred until the prod custom domain (`admin.ethiolink.app`) is live — submitting before then risks locking the operator out of any future http debugging during bring-up.
- **CSP without `unsafe-inline` on `script-src`.** The Vite production build was inspected — `admin/dist/index.html` contains hashed `<script type="module">` tags only, no inline JS. The build's one inline `<style>` block for the splash-screen FOUC guard keeps `style-src 'unsafe-inline'` in the policy; hash-pinning is a follow-up.
- **CSP origins from Terraform variables.** `api_gateway_origin` / `cognito_origin` / `media_public_origin` are wired from the env stack to the module so the policy stays in sync with the actual deployed hostnames. Empty inputs drop the corresponding CSP fragment (so a half-wired bootstrap environment still emits a syntactically valid policy).
- **`frame-ancestors 'none'` + `X-Frame-Options: DENY`.** Click-jacking defense for every browser. The admin SPA is never embedded.
- **`Permissions-Policy` disables five powerful features.** `camera`, `microphone`, `geolocation`, `payment`, `usb` — the admin SPA never legitimately needs any of them.

## Lambda IAM least privilege

The Phase 8 commit "split Lambda IAM roles by domain" replaced the original single shared execution role with 11 per-domain roles, keyed off the existing `area` tag on each function entry. The shape:

- **Baseline policy** (attached to every role): CloudWatch Logs write, ENI lifecycle (`AWSLambdaVPCAccessExecutionRole` managed policy), Secrets Manager `GetSecretValue` on the RDS master secret ARN only, X-Ray segment writes (`xray:PutTraceSegments`, `xray:PutTelemetryRecords`).
- **Per-domain additions** (only the `media` role): S3 `PutObject` / `GetObject` / `DeleteObject` on the public + private media buckets, scoped to the bucket ARN + `/*` object prefix. No `s3:ListAllMyBuckets`, no `s3:*` wildcard.
- **No domain other than `media`** carries S3 write permissions. The auth domain, business domain, admin domain, etc. all run on the baseline policy alone.

Per-handler narrowing within a domain (e.g. splitting "media-upload-url" from "media-confirm" into separate roles with different S3 scopes) is deferred — the operational cost of 49 distinct roles exceeds the security benefit when the domain-level scope is already tight. Recorded in the Phase 8 checklist as a follow-up.

The shared `media-public` bucket is the **only** S3 surface intended for public reads. The `media-private` bucket has block-public-access fully on and is only accessible via presigned URLs minted by the `media` Lambda role. The bucket-policy audit confirmed:

- `media-public`: public-read on objects via bucket policy (CORS allow-listed to the admin SPA origin in CORS rules; mobile is native and bypasses CORS).
- `media-private`: block-public-access fully on, no bucket policy allowing anonymous reads.
- `admin-frontend`: block-public-access fully on, OAC-only reads from CloudFront's service principal.
- `logs`: block-public-access fully on, server-access-log writes only.
- Terraform state buckets: block-public-access fully on, encrypted at rest.

## WAF baseline

The WAF baseline shipped in Phase 7 (commit "Add WAF protection") attaches a regional WAFv2 Web ACL to every environment's API Gateway stage. The Phase 8 security review confirmed the rule set is appropriate for the MVP without further tuning:

| Rule                                          | Action            | Status              |
| --------------------------------------------- | ----------------- | ------------------- |
| `AWSManagedRulesCommonRuleSet`                | block on match    | Enabled.            |
| `AWSManagedRulesKnownBadInputsRuleSet`        | block on match    | Enabled.            |
| `AWSManagedRulesAmazonIpReputationList`       | block on match    | Enabled.            |
| Rate-based rule (2000 req / 5 min / IP)       | block             | Enabled.            |
| Bot Control rule group                        | n/a               | Deferred — see below. |

Bot Control was reviewed and deliberately deferred. The Phase 7 baseline rules already block the bot families that affect MVP traffic (known scanners via `KnownBadInputs`, low-reputation source IPs via `AmazonIpReputationList`). Bot Control's pricing model charges per-request — at MVP scale the marginal block rate doesn't justify the standing cost. Recorded as a follow-up gated on real traffic numbers.

## Secrets handling

- **RDS master password** — managed in Secrets Manager (`ethiolink/${env}/rds/master`). Rotated every 30 days by the AWS-managed `SecretsManagerRDSPostgreSQLRotationSingleUser` Lambda deployed via SAR (Phase 8 commit "Enable RDS secret rotation"). The application Lambdas resolve the secret on cold start via `loadSecretsThenConfig` (`backend/shared/config/loadSecrets.ts`); warm containers cache the value. Rotation keeps `AWSPREVIOUS` valid so the transition window is safe end-to-end.
- **Cognito app-client secret** — both clients are public PKCE clients, no secret to manage.
- **Third-party API keys (SMS, Telegram, payment provider)** — landing alongside the real provider integrations in a Phase 8 follow-up. Will live in Secrets Manager under `ethiolink/${env}/<provider>/api-key`; the per-domain Lambda role grants `secretsmanager:GetSecretValue` scoped to the specific secret ARN; rotation cadence per provider.

  - **Payments (Chapa) — landed in Phase 10 first commit.** Two Secrets Manager entries: `ethiolink/${env}/payments/chapa-secret-key` (the merchant secret key `CHASECK_…`) and `ethiolink/${env}/payments/chapa-webhook` (the HMAC webhook-signing secret). SecretStrings support plain-string or JSON-wrapped shapes (`{ secretKey: … }` / `{ webhookSecret: … }` / bundled). Per-domain IAM: the secret-key ARN is read by `appointments`, `featuring`, and `integrations` Lambda roles; the webhook secret is read only by `integrations`. Rotation is operator-led — Chapa exposes a merchant-portal control for issuing a new key; rotating the SecretString and re-applying is a one-step swap (warm Lambdas continue with the cached old key until cold-start picks up the new value; the rotation window is typically < 5 min for the matching ALTER on Chapa's side). The integration is opt-in per env via `payments_provider = "chapa"` — default `"mock"` keeps the historical placeholder behaviour.

- **PCI scope (Phase 10).** EthioLink never sees cardholder data. The Chapa integration uses Chapa's hosted checkout: `ChapaGateway.authorize` calls `/v1/transaction/initialize`, receives a redirect URL, and surfaces it to the mobile client. The customer enters card / mobile-money credentials on Chapa's domain, not ours. Our backend stores only the Chapa-issued `tx_ref` + amount + status in `payment_intents` — no PAN, no CVV, no track data, no PIN ever transits or persists on EthioLink infrastructure. This is the canonical "merchant who never touches cardholder data" posture, equivalent to **PCI DSS SAQ-A** scope. The webhook handler (Phase 10 commit 3) validates Chapa's HMAC signature on inbound callbacks and re-fetches the canonical transaction status via `verify(providerRef)` rather than trusting the webhook body. No PCI scope changes are anticipated when (a) a future first-party `TelebirrGateway` lands (Telebirr is wallet-based, also hosted), or (b) the admin SPA gains a refund button (the refund call is a server-to-server admin action keyed off `provider_ref`, no card data involved).
- **Terraform state** — stored in the bootstrap S3 bucket with server-side encryption (`AES256`), versioning enabled, block-public-access fully on, and DynamoDB-backed state locks. The GitHub OIDC deploy role can read/write state; nobody else has bucket access.
- **GitHub Actions** — uses OIDC, no long-lived AWS keys checked into the repo. Per-env IAM role (`ethiolink-terraform-deploy-dev` / `-prod`) trusts the GitHub OIDC provider with subject claim scoped to the specific repo + branch (`refs/heads/main` for dev) or tag pattern (`refs/tags/v*` for prod).

## Findings

| # | Severity | Title                                                              | Status                        |
| - | -------- | ------------------------------------------------------------------ | ----------------------------- |
| 1 | Medium   | Cognito password policy too short (10 chars, no symbol required)   | **Fixed** — 12 chars + symbol required in this commit. |
| 2 | Medium   | Admin SPA missing CSP + HSTS + X-Frame-Options                     | **Fixed** — full security headers policy attached to CloudFront in this commit. |
| 3 | Low      | `ADMIN` users not MFA-enrolled                                     | **Operator step** — TOTP enrollment documented above. Auto-enforcement deferred until enrollment is verified team-wide. |
| 4 | Low      | Single shared Lambda execution role                                | **Fixed** — Phase 8 commit "split Lambda IAM roles by domain" (11 per-domain roles). |
| 5 | Low      | No HSTS preload-list submission                                    | **Deferred** — preload-eligible header shipped; submission scheduled after prod custom-domain bring-up. |
| 6 | Low      | Bot Control rule group not enabled                                 | **Deferred** — cost/benefit gated on real traffic numbers. |
| 7 | Low      | No customer-managed KMS keys (CMKs)                                | **Fixed (infra + docs); operator data-move pending** — Phase 9 Track 4. CMK module, consumer wiring, and the migration runbook all shipped; the maintenance-window data move is documented at [`docs/operations/runbooks/kms-migration.md`](runbooks/kms-migration.md). See "KMS — landed in Phase 9 Track 4" below. |
| 8 | Info     | OPTIONS preflights are open                                        | **Accepted** — CORS is not an auth mechanism; per-resource origin allow-list is the binding control. |

No criticals. The four "Fixed" items are landing in Phase 8 commits (this commit + the IAM-split commit). The four deferred items each have a recorded mitigation or follow-up.

## KMS — landed in Phase 9 Track 4

Customer-managed KMS keys (CMKs) were deferred from Phase 8 and landed across three Phase 9 commits:

- **`Phase 9: add KMS module` (`89e9576`)** — new `infra/terraform/modules/kms/` provisions six per-service CMKs (`rds`, `s3_media`, `s3_logs`, `s3_admin_frontend`, `secrets`, `lambda_env`) with annual rotation, service-principal use grants fenced by `kms:ViaService`, and `prevent_destroy = true` lifecycle. Aliases follow `alias/ethiolink-${env}-<service>`.
- **`Phase 9: wire CMKs through consumers` (`10eca4c`)** — nullable `kms_key_*` inputs added to RDS / S3 / admin-frontend / secrets / Lambda modules; env stacks pipe `module.kms.<service>_key_arn` through. Per-domain Lambda roles gain scoped `kms:Decrypt` (and `kms:GenerateDataKey*` for the media role) under the same `kms:ViaService` fence; the SAR rotation Lambda gains `kms:Decrypt` on the secrets CMK.
- **`Phase 9: add KMS migration runbook` (this commit)** — `docs/operations/runbooks/kms-migration.md` documents the maintenance-window data move (RDS snapshot copy + restore + cutover, per-bucket S3 `aws s3 cp` re-encryption, Secrets Manager forced rotation, Lambda env-var verification) plus rollback per resource and the six known risks.

**Remaining operator step:** execute the runbook in dev, then prod. Until the dev pass completes, existing at-rest data continues encrypting under the AWS-managed keys; new writes after the wiring commit encrypt under the CMK. Once the dev pass completes, this finding moves from "Fixed (infra + docs); operator data-move pending" to "Fully fixed". The historical encryption posture below remains accurate for any environment that has not yet run the runbook.

## Historical encryption posture (pre-migration)

The encryption posture **before** the Phase 9 Track 4 migration runbook executes:

- **RDS at rest.** `storage_encrypted = true` using the default AWS-managed `aws/rds` KMS key. Operator cannot rotate the key independently; AWS rotates it on AWS's schedule.
- **S3 buckets at rest.** `aws_s3_bucket_server_side_encryption_configuration` with `sse_algorithm = "AES256"` — SSE-S3, not SSE-KMS. AWS manages the per-object keys.
- **Secrets Manager at rest.** Default AWS-managed `aws/secretsmanager` KMS key.
- **Lambda environment variables at rest.** Default AWS-managed `aws/lambda` KMS key.
- **EBS volumes underneath RDS / Lambda.** Default AWS-managed keys per service.
- **In transit.** TLS 1.2+ everywhere — RDS connections use SSL (the `loadConfig` shim sets `PG_SSL = true`), API Gateway terminates TLS 1.2+, CloudFront serves TLS 1.2+ (TLS 1.2_2021 minimum policy when the custom domain is wired).

**Why deferred.** Migrating to per-service CMKs (one for RDS, one for S3, one for Secrets Manager, etc.) is a multi-day project that requires:

- Provisioning the keys with the right key policy (`Allow CloudFront/Cognito/Lambda/RDS service principal to Use Key`).
- Re-encrypting existing data at rest (RDS snapshot → restore-with-CMK; S3 PutObject with new `x-amz-server-side-encryption-aws-kms-key-id`).
- Adding the matching `kms:Encrypt` / `kms:Decrypt` / `kms:GenerateDataKey*` IAM statements to every consuming role.
- Validating cross-account / cross-region key access patterns for DR.

The marginal security benefit at MVP scale is small — the threat model where a CMK helps (AWS itself behaving maliciously toward an EthioLink admin) is not in scope for the MVP. The default AWS-managed keys are encrypted with the same underlying HSMs and rotate on AWS's schedule.

**Migration path** — superseded by Phase 9 Track 4. See [`docs/operations/runbooks/kms-migration.md`](runbooks/kms-migration.md) for the executable runbook covering all five legacy bullet points (CMK provisioning, consumer wiring, env-stack pipe-through, maintenance-window data move, IAM scope audit). The remaining work is operator execution — the engineering side of the migration has shipped.

## Sign-off

| Reviewer       | Role     | Decision  | Notes                                                                                  |
| -------------- | -------- | --------- | -------------------------------------------------------------------------------------- |
| Engineering    | author   | approved  | All "Fixed" items landed in this phase. Deferred items have a recorded follow-up.      |
| Operations     | reviewer | pending   | Operator-side sign-off after the first prod apply (CSP report-only smoke + MFA rollout). |
| Security       | reviewer | pending   | External pen-test engagement scheduled post first prod deploy.                         |

The review is re-run quarterly, or after any of the following:

- Change to the API Gateway route map (`infra/terraform/modules/api-gateway/main.tf`).
- Change to the Cognito user pool or app clients (`infra/terraform/modules/cognito/main.tf`).
- New external integration (SMS, payment, etc.).
- New cross-service IAM role.
- Any production-impacting incident.
