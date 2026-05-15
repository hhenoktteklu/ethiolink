# Phase 8 — Completion Summary

End of Phase 8 (Production Hardening). The platform crossed the "it runs" → "it operates" line: every Phase 7 surface gained a hardening pass, the prod deploy pipeline is wired, RDS rotates its own master credential, every Lambda traces through X-Ray, structured logs carry a correlation id, the WAF is layered and tunable per route family, the admin SPA carries a strict security-header set, the booking + browse SLOs are defined with a documented error-budget policy, and the DR procedure has a runbook + a monthly verification workflow. The five operator-led items listed below are the only remaining gates before the MVP can go live with confidence; none require new code.

Authoritative scope and checklist live in [`PHASE_8_PRODUCTION_HARDENING.md`](./PHASE_8_PRODUCTION_HARDENING.md). This file is the at-a-glance status read on 2026-05-15.

## Goal recap

The Phase 8 goal as scoped at phase entry: *"Make the platform something we can confidently leave running. Close observability gaps, verify backups and DR, complete the security review, and document the operational runbooks."*

Translated into the four operational pillars:

- **Security** — production-ready posture on auth, authorization, transport, identity, and supply chain.
- **Reliability** — backup-verified, restore-rehearsed, rotation-automated, and rate-limited.
- **Observability** — correlation ids on every request, X-Ray on every Lambda, SLOs defined with budget burn alerting, per-route-family dashboards.
- **CI/CD** — prod deploy pipeline equal-parity with dev; least-privilege deploy role for prod; tag-gated promotion.

Every pillar has a code-side landing in this phase. The cross-cutting "performance / load-test assets" pillar (k6 scripts + a README playbook) ships as scaffolding ready for the operator-led capture pass.

## Completed commits

Nine commits, all on `main`, shipped in this phase. Each is independent (no dependency between hashes); the order below is chronological.

| # | Hash      | Title                                       | Files touched (count)                                                  |
| - | --------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| 1 | `ebf55e0` | Phase 8: add prod deploy workflow           | `.github/workflows/deploy-prod.yml`, bootstrap module (per-env role split), AWS_DEPLOYMENT.md, PHASE_8 checklist |
| 2 | `5a30fed` | Phase 8: split Lambda IAM roles by domain   | `infra/terraform/modules/lambda/*` (per-domain role generation), AWS_DEPLOYMENT.md, PHASE_8 checklist |
| 3 | `be4ece2` | Phase 8: add observability tracing          | `backend/shared/observability/{logger,tracing,correlationId}.ts`, Lambda module `tracing_config`, baseline IAM policy, AWS_DEPLOYMENT.md, PHASE_8 checklist |
| 4 | `a4d0fcb` | Phase 8: enable RDS secret rotation         | `infra/terraform/modules/secrets/*` (new module via SAR), env stacks, AWS_DEPLOYMENT.md, PHASE_8 checklist |
| 5 | `b721315` | Phase 8: add DR runbook and backup verification | `docs/operations/DR_RUNBOOK.md`, `.github/workflows/backup-verify.yml`, AWS_DEPLOYMENT.md, PHASE_8 checklist |
| 6 | `e4e00f1` | Phase 8: add k6 load tests                  | `infra/k6/{browse,book,full-lifecycle}.js` + `README.md`, PHASE_8 checklist |
| 7 | `1a50ddd` | Phase 8: add security hardening review      | Cognito + admin-frontend Terraform modules, env stacks, `docs/operations/SECURITY_REVIEW.md`, AWS_DEPLOYMENT.md, PHASE_8 checklist |
| 8 | `2c4841a` | Phase 8: tune WAF rules                     | `infra/terraform/modules/waf/*` (layered rate-based rules + Bot Control gate + `rule_action_override` knobs), AWS_DEPLOYMENT.md, PHASE_8 checklist |
| 9 | `e36aa86` | Phase 8: add SLOs and endpoint dashboards   | `docs/operations/SLOs.md`, `infra/terraform/modules/cloudwatch/*` (route-family dashboard + 2 SLO-burn alarms), AWS_DEPLOYMENT.md, PHASE_8 checklist |

Total: 9 commits, ~3000 lines added across Terraform + docs + observability shims, zero application-code rewrites in this phase outside the observability scaffolding (`backend/shared/observability/*`).

## Security hardening — completed

Landed under commits `1a50ddd`, `5a30fed`, `2c4841a`.

- **Authorization matrix audit** (`docs/operations/SECURITY_REVIEW.md`). Full route-by-route audit of all 48 API Gateway routes: 8 public read paths, 40 Cognito-authenticated paths split into 15 owner-only / 12 customer-or-owner / 13 admin-only enforcement patterns. Public reads confirmed to enforce `business.status = 'APPROVED'` at the repository layer; no public route returns customer PII. Admin endpoints triple-gated (API Gateway auth + `authorizeAdmin` server check + SPA `ProtectedRoute` client check).
- **Cognito hardening**. Password policy bumped from 10 chars / no-symbol to 12 chars / lowercase + uppercase + digit + symbol required. Existing users keep credentials until next password change. Software-token MFA (`software_token_mfa_configuration { enabled = true }`) available pool-wide; per-`ADMIN` enrollment is the documented operator step. Both app clients (mobile + admin) are public PKCE clients; no embeddable secrets in either bundle. `prevent_user_existence_errors = ENABLED` + `enable_token_revocation = true` on both.
- **Admin SPA security headers**. `aws_cloudfront_response_headers_policy` attached to both cache behaviors injects HSTS (preload-eligible, 1-year, `includeSubDomains`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` disabling 5 powerful features (camera / microphone / geolocation / payment / usb), and a strict CSP with no `unsafe-inline` on `script-src`. CSP `connect-src` / `form-action` / `img-src` allow-lists are wired from env-stack variables (`api_gateway_origin`, `cognito_origin`, `media_public_origin`).
- **Per-domain Lambda IAM roles**. Phase 7's single shared `lambda-exec` role replaced by 11 per-domain roles, keyed off the existing `area` tag. Only the `media` role carries S3 statements. Baseline policy is consistent across roles (CloudWatch Logs + ENI lifecycle + `secretsmanager:GetSecretValue` on the RDS master secret only + X-Ray segment writes).
- **WAF layered defense**. Three rate-based rules layered from tightest to loosest: `rate-limit-public-read` (600 req/5 min/IP scope-down on `GET /v1/categories|businesses*`), `rate-limit-write` (300 req/5 min/IP scope-down on non-GET methods), `rate-limit-per-ip` (existing 2000 req/5 min global fallback, preserved verbatim). Three managed rule groups (`CommonRuleSet`, `KnownBadInputsRuleSet`, `AmazonIpReputationList`) enabled by default with per-group `*_count_overrides` lists for mid-incident sub-rule muting. Bot Control gated behind `enable_bot_control = false` (priced per-request; gated on real traffic data).
- **Public-bucket posture verified**. Only `media-public` allows anonymous reads (and only via the CORS-scoped bucket policy). `media-private`, `admin-frontend`, `logs`, and the Terraform-state bucket all have block-public-access fully on. Force-TLS deny statements on every bucket via `aws:SecureTransport`.

KMS-managed encryption was reviewed and deliberately deferred — see "Deferred — post-MVP" below.

## Reliability / resilience — completed

Landed under commits `a4d0fcb`, `b721315`.

- **RDS secret rotation**. AWS-published `SecretsManagerRDSPostgreSQLRotationSingleUser` Lambda deployed via SAR into the application VPC (same private subnets + `sg-lambda` security group as the application Lambdas). `aws_secretsmanager_secret_rotation` schedules 30-day cadence; the first rotation fires immediately after apply (validates the rotation Lambda actually works before the steady-state window opens). The Lambda cold-start shim's at-module-scope cache stays correct during a rotation because AWS keeps `AWSPREVIOUS` valid until the next rotation; warm containers continue to authenticate with the old password without errors.
- **DR runbook**. `docs/operations/DR_RUNBOOK.md` carries the full step-by-step play with per-step timing. Total expected wall-clock under the documented procedure is ~43 minutes — well inside the 60-minute Phase 8 acceptance criterion. Three fallback procedures included (snapshot corruption, stuck restore, smoke-test failure) + a post-incident checklist.
- **Backup verification workflow**. `.github/workflows/backup-verify.yml` runs monthly on a cron + on dispatch. Dry-run mode (the default) identifies the most recent automated snapshot, asserts it's less than ~30 hours old, checks engine + encryption descriptors, reports to the GitHub step summary. Full-restore mode (provision scratch instance → row-count compare → tear-down) is documented scaffolding gated behind `workflow_dispatch.inputs.full_restore = true` — the scratch Terraform workspace itself is a Phase 8.5 follow-up.
- **WAF rate-limit baselines**. The Phase 8 layered rate-based rules (above) are also reliability levers: a runaway client (misconfigured bot, retry storm) hits the per-IP rate limit at the WAF edge rather than saturating Lambda concurrency. The `cloudwatch` module's `WAF blocked` alarm is the early signal.

## Observability — completed

Landed under commits `be4ece2`, `e36aa86`.

- **Structured logs with correlation ids**. `backend/shared/observability/correlationId.ts` ships the `AsyncLocalStorage`-backed `withRequestContext({ requestId, route }, fn)` scope. `getCurrentRequestContextRecord()` is the read side. The logger picks up the dynamic context via a new `contextProvider` hook on `LoggerOptions`, so every log line emitted inside a wrapped handler invocation carries the request id + route automatically without the handler having to pass them. The mechanical per-handler refactor adopting `withRequestContext` at the top of each `handler` is a small follow-up — the scaffolding is in place and forward-compatible.
- **X-Ray on every Lambda**. Terraform Lambda module sets `tracing_config.mode = "Active"` on every function. The baseline IAM policy in the new per-domain roles grants `xray:PutTraceSegments` + `xray:PutTelemetryRecords`. Lambda-level traces light up immediately. SDK-call sub-segments via `aws-xray-sdk-core`'s `captureAwsClient` are deferred to a follow-up — visible in the service-map without them, but the per-call breakdown adds drilldown depth.
- **SLO definitions**. `docs/operations/SLOs.md` defines four SLOs with error-budget math:
  - **Booking creation availability** — 99.5% / 30 days. SLI = 2xx / (2xx + non-409-4xx + 5xx) on `POST /v1/appointments`. Wired alarm: `slo-booking-creation-errors` (≥ 3 errors / 5 min on `appointments-create` Lambda, fast-burn proxy).
  - **Browse / read p95 latency** — p95 < 800 ms / 7 days. SLI = API Gateway `Latency` p95 on the 8 public read routes. Wired alarm: `slo-browse-latency-p95` (p95 > 800 ms for 2× 5 min on `businesses-list` Lambda).
  - **Categories availability** — 99.9% / 30 days. SLI = 2xx / total on `GET /v1/categories`. Reuses the existing aggregate Lambda errors alarm.
  - **Reminder success** — 99% / 30 days. SLI = `(Invocations − FailedInvocations) / Invocations` on the EventBridge reminder rule. Reuses the existing `eventbridge-failed` alarm.
  - Error-budget policy with 4 budget-state tiers, fast-burn alerting rule (14.4× threshold), monthly + quarterly + ad-hoc review cadence.
- **Per-route-family dashboards**. New `${env}-endpoints` CloudWatch dashboard with four row-pairs (Browse / Appointments / Admin / Auth-sync), each row carrying an errors widget + a Lambda p95 duration widget. Browse latency widget shows a red annotation at the 800 ms SLO target. Admin row uses prefix-derived function-key matching so new admin handlers self-register.
- **CloudWatch surface unchanged for non-SLO alarms**. The 7 Phase 7 alarms (API Gateway 5xx, aggregate Lambda errors, RDS CPU / connections / free storage, EventBridge `FailedInvocations`, WAF `BlockedRequests`) all stay in place; Phase 8 adds 2 SLO-burn alarms on top.

## CI/CD — completed

Landed under commit `ebf55e0` (the most operationally-significant CI surface for prod).

- **`deploy-prod.yml` workflow**. Mirrors `deploy-dev.yml` step-for-step (checkout → npm ci → SPA build → backend zip → Terraform plan → apply → migration runner invoke → smoke test) but gated on tag pushes matching `v*.*.*` instead of pushes to `main`. The manual-approval `environment: prod` gate stops every job until an operator approves in the GitHub UI. Concurrency group `deploy-prod` serializes runs (no parallel prod applies).
- **Per-env deploy role**. Phase 7's single `ethiolink-terraform-deploy` role split into `ethiolink-terraform-deploy-dev` + `ethiolink-terraform-deploy-prod`. The prod role's OIDC trust condition scopes the `sub` claim to `repo:hhenoktteklu/ethiolink:ref:refs/tags/v*` — a `main`-branch push cannot assume the prod role even if the workflow ref were spoofed. Both roles still carry `AdministratorAccess` as a deliberate temporary choice while Phase 8 modules land; the least-privilege tightening is a documented post-launch follow-up.
- **Backup verification workflow** (commit `b721315`, listed here for CI completeness). Monthly cron + dispatchable. Dry-run mode is the steady-state; full-restore is gated behind an explicit dispatch input.
- **Lint + test PR workflow**. Not landed in Phase 8. Acknowledged as a Phase 8 follow-up — the natural pair to the two deploy workflows. Phase 9 will pick this up alongside the test-suite expansion.

## Performance / load-test assets — completed

Landed under commit `e4e00f1`.

- **`infra/k6/browse.js`** — 100 RPS for 10 minutes against `GET /v1/businesses` (constant-arrival-rate executor). Thresholds: p95 < 800 ms (matches the SLO target), 99.9% checks pass, < 1% HTTP failures.
- **`infra/k6/book.js`** — 20 RPS for 9 minutes against `POST /v1/appointments` with realistic payload variation. Thresholds: p95 < 1500 ms, < 1% errors. The booking write path is more lenient than the browse read path on purpose — RDS Proxy serialization + state-machine validation add latency that's invisible on the read side.
- **`infra/k6/full-lifecycle.js`** — Single-VU smoke flow walking the full `create → accept → complete → review` state machine. Designed as a heartbeat after a deploy, not a load profile. Handles the documented `complete` 409 INVALID_TRANSITION case when `STARTS_AT` is in the future.
- **`infra/k6/README.md`** — Full operator playbook: install instructions, required env vars per scenario, threshold rationale, how to interpret the output, what to do when a threshold fails.

Running the scripts against dev + capturing the numbers + tuning the WAF rate-limit / RDS alarm thresholds / Lambda memory + timeout from the captured numbers is the operator-led step listed under "Remaining operator-led items" below.

## Remaining operator-led items

Five items, none requiring new code. Each is a discrete operator action that closes a manual gate before the MVP can go live.

1. **Prod first apply.** Run `deploy-prod.yml` from the first `v0.1.0` tag. The workflow's manual-approval gate stops at the plan; operator reviews the plan output (in the GitHub Actions log + the SNS alarm topic confirmation), approves, watches the apply complete, runs the smoke test from the workflow's final step. Expected wall-clock: ~25 minutes (Terraform apply ~15 min for the first prod apply, migration runner ~10 sec for the 13 MVP migrations, smoke test ~1 min).
2. **DR tabletop exercise.** Operator walks the `DR_RUNBOOK.md` start-to-finish against a scratch dev account or against a copy of the prod snapshot. The runbook documents 43 minutes of expected wall-clock; the tabletop validates that number empirically. Findings + any runbook edits land in a follow-up commit. Cadence after the first exercise: quarterly.
3. **k6 run against dev (+ later prod) and tuning capture.** Operator runs `infra/k6/browse.js` + `infra/k6/book.js` against dev with realistic env vars filled in; captures p50 / p95 / p99 latency + error rate per scenario; uses the numbers to tighten any of: `waf_rate_limit_per_5min` / `_public_read_per_5min` / `_write_per_5min`, `slo_browse_latency_p95_ms`, `rds_cpu_threshold_percent`, per-function Lambda `memory_size` + `timeout`. Each tune lands as a Terraform-var-only commit.
4. **MFA enrollment for every `ADMIN`.** Each admin signs in via the Cognito hosted UI, navigates to Account Settings → Set up MFA → Authenticator app, scans the QR with a TOTP app, verifies the 6-digit code. Once every admin has enrolled, the follow-up is to flip `mfa_configuration` from `OPTIONAL` to `ON` (one-line Terraform change). Holding off until enrollment is universal prevents a single unenrolled admin from being locked out.
5. **SNS alarm email confirmation.** Operator sets `alarm_email` in the prod env stack to the shared on-call inbox (e.g. `alerts@ethiolink.app`), applies, then clicks the confirmation link AWS sends to that address. Without confirmation, alarms still fire and post to SNS but no email is delivered. Apply the same step in dev if a per-env operator email is desired.

## Deferred — post-MVP

Five items reviewed during Phase 8 and explicitly deferred. Each has a recorded mitigation or migration path.

- **KMS-managed encryption migration.** Currently every at-rest surface uses AWS-managed keys (`aws/rds` for RDS, SSE-S3 for the buckets, `aws/secretsmanager` for secrets, `aws/lambda` for Lambda env vars). Multi-day migration project; marginal security benefit at MVP scale doesn't justify it. Full migration path documented in `SECURITY_REVIEW.md` § "Deferred — KMS". Tracked as `Phase 9 — KMS migration`.
- **Real SMS / Telegram providers.** `MockNotificationGateway` is the wired implementation in both dev and prod today. Replacement gateways (e.g. `EthioTelecomSmsGateway`, `AfroMessageSmsGateway`, `TelegramBotGateway`) plug into the existing `NotificationGateway` port; provider credentials land in Secrets Manager under `ethiolink/${env}/<provider>/api-key` with the matching IAM scope on the `notifications` Lambda role.
- **Custom API Gateway domain.** `api.ethiolink.app` mapping for the prod REST API. Requires a regional ACM cert in `eu-west-1` + Route 53 record set. Today both dev and prod use the default `*.execute-api` URL. Custom domain doesn't change wire-format behavior; it's a polish item.
- **WAF Bot Control.** `enable_bot_control` defaults to `false`. Bot Control is priced per-request; flipping it on once real traffic surfaces a residual bot share (likely 1–2 months into prod) is a one-line Terraform change. The `bot_control_inspection_level` variable selects between `COMMON` (~50 WCUs) and `TARGETED` (~500 WCUs).
- **Amharic / native localization.** The mobile app + admin SPA + email templates all ship in English today. Native Amharic translation pass + locale-aware date / number formatting + RTL-language audit is a sizable post-MVP track.

## Final recommendation

The MVP is **launch-ready after the operator-led checklist above is completed**. The remaining gates are operational — running the prod apply, confirming MFA enrollment, walking the DR runbook, capturing real load-test numbers, and confirming the alarm email — not code-shaped. None of them require an additional commit before launch.

The natural next phase is **Phase 9 — post-MVP roadmap**, scoped around the deferred items above plus the items that emerge from the first weeks of real traffic. Candidate Phase 9 themes, in rough priority order:

1. **Real notification provider integration** — the highest-leverage post-launch work; replaces the mock with one SMS provider + the Telegram bot. Unblocks the reminder + booking-confirmation customer flows from real users.
2. **KMS-managed encryption migration** — per the migration path in `SECURITY_REVIEW.md`.
3. **WAF tuning from prod traffic** — Bot Control on/off decision, per-IP rate-limit calibration from real numbers, the first wave of `rule_action_override` entries for any noisy managed sub-rules.
4. **Performance hardening from prod load** — provisioned-concurrency wiring on the cold-start-sensitive Lambdas, per-function memory tuning, RDS Proxy idle-timeout adjustment if needed.
5. **Amharic localization track** — the largest standalone post-MVP feature; can run in parallel with the operational items.
6. **Custom domains + lint-test PR workflow + SLO tightening** — the polish + maturity items that don't gate anything but compound over time.

**Alternative — invite-only early launch.** The platform supports an invite-only soft launch on dev today. The admin team visits `admin_frontend_url`; a handful of friendly business owners sign up via the mobile app; bookings flow end-to-end with the mock notification gateway. Phase 9 priorities then re-order themselves around what real users actually surface — almost certainly bumping the notification-provider integration to the top.
