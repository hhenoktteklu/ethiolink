# Phase 8 — Production Hardening

## Goal

Make the platform something we can confidently leave running. Close observability gaps, verify backups and DR, complete the security review, and document the operational runbooks.

## Scope

In scope:

- WAF tuning beyond the Phase 7 baseline: bot control, IP reputation list, custom rate limits per route. *(Phase 8 commit "tune WAF rules": three layered rate-based rules — `rate-limit-public-read` (600 req/5 min/IP, scope-down on `GET /v1/categories|businesses*`, priority 50), `rate-limit-write` (300 req/5 min/IP, scope-down on non-GET methods, priority 60), and the existing global `rate-limit-per-ip` (2000 req/5 min/IP, priority 70) preserved verbatim as the fallback. IP reputation rule group enabled by default; Bot Control gated behind `enable_bot_control = false` until real traffic numbers justify the cost. Per-managed-group `*_count_overrides` lists added so an operator can force a noisy sub-rule to COUNT mid-incident without editing the module.)*
- Secret rotation: rotate RDS master password and any third-party API keys via Secrets Manager managed rotation. *(Phase 8 commit "enable RDS secret rotation": AWS-managed `SecretsManagerRDSPostgreSQLRotationSingleUser` Lambda deployed via SAR; `aws_secretsmanager_secret_rotation` schedules 30-day cadence; first rotation fires immediately after apply. Third-party API keys land alongside the real SMS/Telegram provider integration follow-ups.)*
- RDS backup verification: monthly automated restore test to a scratch RDS instance, comparing schema and row counts. *(Phase 8 commit "DR runbook + backup verification": `.github/workflows/backup-verify.yml` runs monthly + on dispatch, default dry-run mode asserts snapshot freshness + descriptors. Full-restore mode is gated behind `workflow_dispatch.inputs.full_restore = true` and emits a "not implemented" notice until the Phase 8.5 follow-up ships the `restore-test` Terraform workspace.)*
- DR runbook in `docs/operations/DR_RUNBOOK.md` covering RDS restore, Lambda redeploy, Cognito recreation guidance. *(Phase 8 commit "DR runbook + backup verification": full step-by-step playbook with per-step timing, 43-minute total wall-clock under the 60-minute SLO, fallback procedures for snapshot corruption / stuck restore / smoke-test failure, post-incident checklist.)*
- Load testing: scripted scenarios for browse, book, accept, complete, with assertions on p95 latency. *(Phase 8 commit "k6 load tests": `infra/k6/browse.js` (100 RPS / 10 min / p95 < 800 ms), `infra/k6/book.js` (20 RPS / 9 min / p95 < 1500 ms / errors < 1 %), `infra/k6/full-lifecycle.js` (smoke flow). README documents install + env vars + thresholds + interpretation. Tuning commit follows once captured numbers exist.)*
- Security review:
  - All endpoint authorization matrix reviewed against `API_SPEC.md`. *(Phase 8 commit "add security hardening review": full route-by-route audit in `docs/operations/SECURITY_REVIEW.md` — 8 public routes documented, 40 authenticated routes split into owner-only / customer-or-owner / admin-only, no exceptions outside the scheduled + migration runner Lambdas.)*
  - All Lambda IAM roles audited for least privilege. *(Phase 8 commit "split Lambda IAM roles by domain": shared role replaced by 11 per-domain roles; only the `media` role carries S3 statements. Per-handler narrowing on high-risk handlers remains a follow-up.)*
  - Public S3 access limited strictly to the `media-public` bucket. *(Phase 8 commit "add security hardening review": confirmed in `SECURITY_REVIEW.md` — `media-public` allows public reads via CORS-scoped bucket policy; `media-private`, `admin-frontend`, `logs`, and Terraform state buckets all have block-public-access fully on.)*
  - Cognito password policy hardened; account lockout reviewed. *(Phase 8 commit "add security hardening review": `password_minimum_length` bumped from 10 to 12, `require_symbols` flipped from false to true. Existing users keep credentials until next password change. Account lockout retains Cognito's default brute-force protection.)*
  - CSP and security headers on the admin SPA. *(Phase 8 commit "add security hardening review": `aws_cloudfront_response_headers_policy` adds HSTS preload-eligible, X-Frame-Options DENY, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy disabling 5 features, and a CSP with no `unsafe-inline`/`unsafe-eval` on script-src. Attached to both cache behaviors.)*
- Observability gaps:
  - Structured request logs with correlation ids. *(Phase 8 commit "observability tracing": `backend/shared/observability/correlationId.ts` ships the ALS scope + `getCurrentRequestContextRecord` adapter. Logger picks up the dynamic context via the new `contextProvider` hook on `LoggerOptions`. The mechanical per-handler refactor adopting `withRequestContext` is a small follow-up.)*
  - X-Ray tracing on every Lambda. *(Phase 8 commit "observability tracing": Terraform Lambda module sets `tracing_config.mode = "Active"` on every function; baseline IAM policy adds `xray:PutTraceSegments` + `xray:PutTelemetryRecords`. Lambda-level traces light up immediately. SDK-call sub-segments via `aws-xray-sdk-core` + `captureAwsClient` are deferred to a follow-up.)*
  - Per-endpoint latency and error dashboards.
  - SLO definitions: 99.5% availability on booking creation, p95 < 800ms on browse.

Out of scope:

- Marketplace expansion modules — covered in later post-MVP phases.
- Native Amharic UI rollout.

## Files involved

- `infra/terraform/modules/waf/*` (extended)
- `infra/terraform/modules/secrets/*` (rotation configuration)
- `infra/terraform/modules/cloudwatch/*` (additional dashboards and alarms)
- `backend/shared/observability/{logger,tracing,correlationId}.ts`
- `docs/operations/DR_RUNBOOK.md`
- `docs/operations/RUNBOOK.md`
- `docs/operations/SLOs.md`
- `docs/operations/SECURITY_REVIEW.md`

## Checklist

- [ ] WAF rules tuned and tested. *(Tuning shipped — Phase 8 commit "tune WAF rules". Validation against the dev stage with sampled requests + per-rule CloudWatch metrics is the operator-led step still to schedule.)*
- [ ] Secret rotation enabled for RDS and third-party providers.
- [ ] Backup restore test scripted and passing. *(Dry-run workflow shipped — `.github/workflows/backup-verify.yml`. Full-restore scratch-workspace remains Phase 8.5.)*
- [ ] DR runbook validated by a tabletop exercise. *(Runbook shipped at `docs/operations/DR_RUNBOOK.md`; tabletop exercise is the operator-led validation step still to schedule.)*
- [ ] Load test passes target p95 latency. *(Scripts shipped at `infra/k6/`; running them against dev + capturing the numbers is the operator-led step still to schedule.)*
- [ ] Security review checklist completed and signed off. *(Engineering sign-off shipped in `docs/operations/SECURITY_REVIEW.md` alongside the Phase 8 "add security hardening review" commit. Ops + external security sign-offs are the post-prod-deploy items still to schedule — recorded inline in the doc.)*
- [ ] All Lambdas emit structured logs with correlation ids.
- [ ] X-Ray enabled across all Lambdas.
- [ ] SLO dashboards live and pinned in CloudWatch.

## Acceptance criteria

- A DR drill completes within 60 minutes from "RDS lost" to "API serving from restored database".
- Load test sustained at 100 RPS on read paths and 20 RPS on booking creation with error rate < 1% and p95 latency within targets.
- Security review checklist has zero outstanding criticals.

## Test plan

- DR drill: scheduled exercise restoring RDS from the most recent snapshot into a scratch environment.
- Load test: `k6` scripts targeting browse, book, accept flows.
- Synthetic monitoring: Route 53 / CloudWatch synthetics for the public listing endpoint, alarming if it fails for two consecutive checks.
- Pen-test pass on auth, ownership, and authorization boundaries.

## Rollback notes

- WAF rule changes are reversible by Terraform.
- Secret rotation can be paused via Secrets Manager.
- Observability changes (log structure, tracing) are additive and non-breaking.
