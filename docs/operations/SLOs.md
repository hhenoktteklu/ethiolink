# EthioLink — Service Level Objectives

This document is the authoritative source for the production SLOs the EthioLink platform commits to. The targets are intentionally modest for an MVP serving an Ethiopian beauty / salon / spa marketplace — they're meant to be hit, not aspired to. As the platform matures and the operator team grows, the targets tighten; the [Revision history](#revision-history) section at the bottom is the change log.

The SLO numbers feed two operational surfaces:

1. **Alarms** — a small subset of the SLOs has a corresponding CloudWatch alarm wired by the `cloudwatch` Terraform module. Alarms fire on the per-window error budget burn rate, not on the long-window SLO directly (a 30-day SLO is a poor real-time signal). The wired alarms are listed under each SLO below.
2. **Dashboards** — the `${env}-endpoints` CloudWatch dashboard groups widgets by route family (browse, appointments, admin, auth-sync) so the operator can read the live SLI numbers in one place. Dashboard names are emitted by the `cloudwatch` module's `dashboard_names` output.

## SLO glossary

- **SLI (Service Level Indicator)** — the measurable quantity, e.g. `successful booking-creation requests / total booking-creation requests`.
- **SLO (Service Level Objective)** — the target value of the SLI over a window, e.g. `≥ 99.5% over 30 days`.
- **Error budget** — `1 − SLO target`, expressed in time or events allowed to fail. A 99.5% / 30-day SLO has an error budget of `30 days × 24 h × 0.005 = 3.6 h` of downtime, or `0.5%` of the total request volume.
- **Burn rate** — how fast the rolling window is consuming the error budget. A burn rate of 1× means the budget would exactly empty over the SLO window; 14.4× means it empties in 50 hours (the conventional fast-burn threshold).
- **Window** — the period over which the SLO is measured. We use a rolling 30-day window for availability SLOs and a rolling 7-day window for latency SLOs (lower noise floor than 30-day p95).

## SLOs

### 1. Booking creation availability

The most user-visible failure mode is a customer trying to book and getting an error. This is the SLO with the tightest operator attention.

| Field            | Value                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SLI**          | `(POST /v1/appointments responses with 2xx) / (POST /v1/appointments responses with 2xx, 4xx-not-409, or 5xx)`. 409 INVALID_TRANSITION is excluded — the state-machine refusing a duplicate booking is the *correct* behavior, not an SLI miss. |
| **Target**       | **99.5%** over a rolling 30-day window.                                                                                                                          |
| **Error budget** | `0.5% × 30 days = 3.6 hours` of total downtime equivalent, or `~50 failed bookings per 10000 attempts`.                                                          |
| **Window**       | Rolling 30 days.                                                                                                                                                 |
| **Measurement**  | `AWS/Lambda Errors{FunctionName=ethiolink-${env}-appointments-create}` divided by `AWS/Lambda Invocations{FunctionName=...}`. The API Gateway 5xx error count is the cross-check (a Lambda-level error and a gateway-level 5xx should match within a few percent). |
| **Linked alarm** | `${env}-slo-booking-creation-errors` — Lambda `Errors` on `appointments-create` ≥ 3 per 5 min for 1 evaluation period. Catches an outage well before the 30-day budget is in danger. |
| **Acceptance**   | Phase 8 acceptance criterion: "99.5% availability on booking creation" — landing this SLO closes that line item.                                                  |

**Why 99.5% and not 99.9%.** The booking funnel depends on Cognito (authentication) + RDS (writes) + the booking-state-machine Lambda. Cognito's stated SLA is 99.9%, RDS Multi-AZ delivers ~99.95%, and Lambda is ~99.95%. Multiplied through, the *theoretical ceiling* is around 99.8% — leaving us no operational margin for our own deploys, schema migrations, or incident recovery time. 99.5% gives us a believable target with room to operate; we'll tighten to 99.7% once a quarter of clean operational data is in hand.

**What blows the budget.** Realistic failure modes for the MVP: a botched migration that breaks the `appointments` insert path (rolled back via the DR runbook — recovery target 60 min, ~3 h of budget burned per incident), an RDS connection-exhaustion spike (mitigated by RDS Proxy in prod; ~10–30 min per event), a Cognito region issue (out of our control; the SLO accommodates ~1 incident/year). Three such incidents per quarter would clear the budget; one or two leaves headroom.

---

### 2. Browse / read p95 latency

The marketplace browsing flow (customers scrolling categories and businesses) is read-heavy and unauthenticated. Slow browsing is the second most user-visible failure mode — visitors abandon a 4-second page load even when it eventually succeeds.

| Field            | Value                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SLI**          | API Gateway `Latency` p95 for the 8 public read routes (every `GET` under `/v1/categories` + `/v1/businesses[/{...}]`). Measured at the API Gateway boundary so the SLI captures Lambda + DB + network. |
| **Target**       | **p95 < 800 ms** over a rolling 7-day window.                                                                                                                                                          |
| **Error budget** | The latency budget is "p95 latency seconds-over-target per week". With an 800 ms target and ~50 ms typical breach magnitude, the budget is roughly 4 hours/week of breach time before the rolling 7-day p95 itself exceeds the target. |
| **Window**       | Rolling 7 days. Shorter than the availability window because p95 latency varies more day-over-day and a 30-day p95 smooths out problems we want to catch.                                              |
| **Measurement**  | `AWS/ApiGateway Latency{ApiName=ethiolink-${env}-api, Stage=${env}}` with `Stat=p95`. Per-route latency lives on the `${env}-endpoints` dashboard's browse widget.                                       |
| **Linked alarm** | `${env}-slo-browse-latency-p95` — `businesses-list` Lambda `Duration` p95 > 800 ms for 2 consecutive 5-min windows. `businesses-list` is the heaviest browse endpoint (paginated list with category filters) — if it breaches the target, the lighter reads almost certainly do too. |
| **Acceptance**   | Phase 8 acceptance criterion: "p95 < 800 ms on browse" — landing this SLO closes that line item.                                                                                                       |

**Why 800 ms and not 500 ms.** Lambda cold starts in a VPC plus RDS query latency from a private subnet add up to ~250 ms on a warm path, ~1.5 s on a cold start. The 800 ms p95 target accepts that ~5% of requests hit a cold start; tightening to 500 ms would require provisioned concurrency (~$30/Lambda/month in prod across the 49 functions = real cost) for marginal user-visible benefit. We'll tighten to 600 ms after the first wave of provisioned-concurrency wiring lands.

**What blows the budget.** Common causes: a long-running query missing an index (the `business_categories` join is the most common offender; the `idx_business_categories_business_id` migration covers it), a Lambda concurrency cliff under load (mitigated by the WAF rate limits + RDS Proxy), or a CloudFront / Route 53 issue increasing round-trip time. The k6 `browse.js` scenario (`infra/k6/browse.js`) asserts p95 < 800 ms at 100 RPS — running it in dev before a deploy catches regressions early.

---

### 3. Categories availability

`GET /v1/categories` is the simplest, most-cached endpoint — it serves a static list of business categories. Treating it as a separate SLO gives us a "is the basic API healthy?" signal independent of any individual feature.

| Field            | Value                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SLI**          | `(GET /v1/categories responses with 2xx) / (GET /v1/categories total responses)`.                                                                                                                  |
| **Target**       | **99.9%** over a rolling 30-day window.                                                                                                                                                            |
| **Error budget** | `0.1% × 30 days = ~43 minutes` of downtime equivalent, or `~10 failed reads per 10000 attempts`.                                                                                                   |
| **Window**       | Rolling 30 days.                                                                                                                                                                                   |
| **Measurement**  | `AWS/Lambda Errors{FunctionName=ethiolink-${env}-categories-list}` divided by `Invocations{...}`. CloudFront-cached responses don't reach Lambda — those are implicitly "available" and not counted as either errors or invocations on the Lambda side. |
| **Linked alarm** | Reuses the existing `${env}-lambda-errors` aggregate alarm. The categories endpoint is one function in 49; a `categories-list`-specific alarm would be ceremony without benefit. The endpoint dashboard's per-function widget surfaces a sustained categories outage if it ever happens. |

**Why 99.9% and not 99.5%.** The endpoint is read-only, has no auth dependency, runs against a single ~10-row table, and is cacheable. Failures here usually mean the *whole API* is down, not "this endpoint is having a bad day". A higher target reflects that reality.

**What blows the budget.** A regional Lambda outage (rare; AWS publishes ~99.95% Lambda availability), an RDS outage that takes down the Postgres read path, or a botched migration that drops the `categories` table. The DR runbook recovers from any of these in under 60 minutes — well inside the 43-minute monthly budget if we incur at most one such incident per month.

---

### 4. Notification reminder success

The scheduled-reminder Lambda (`scheduled-send-reminders`) fires every 15 minutes via EventBridge and dispatches `BOOKING_REMINDER` notifications for appointments within the `[now + 23h45m, now + 24h00m)` window. Failure mode: a customer who booked yesterday for tomorrow doesn't get their reminder. The SLO is intentionally looser than the booking-creation SLO because reminders are best-effort, not a customer's primary touchpoint.

| Field            | Value                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SLI**          | `(EventBridge Invocations − FailedInvocations) / Invocations` on the reminder rule.                                                                                                                |
| **Target**       | **99% successful invocations** over a rolling 30-day window.                                                                                                                                       |
| **Error budget** | `1% × ~2880 invocations/month = ~29 failed firings/month`. One failed firing skips one 15-minute reminder batch — usually rerun-able on the next tick if the underlying issue clears.              |
| **Window**       | Rolling 30 days.                                                                                                                                                                                   |
| **Measurement**  | `AWS/Events FailedInvocations{RuleName=ethiolink-${env}-reminder-15min}` and `AWS/Events Invocations{RuleName=...}`. The reminder dashboard's EventBridge widget plots both.                        |
| **Linked alarm** | Reuses the existing `${env}-eventbridge-failed` alarm (threshold `FailedInvocations >= 1` per 5 min). Any failed firing is worth investigating; we don't need a separate SLO-burn alarm.            |

**Why 99% and not 99.5%.** Reminder dispatch is dependent on Cognito (to resolve the customer's contact info), the notification provider (SMS gateway, Telegram bot — at MVP, a mock provider), and the booking row being present and consistent. A single provider blip can fail one tick without affecting customer experience meaningfully — they get their reminder via the next channel, or the booking just happens without a reminder. 99% leaves headroom for the noise inherent in a best-effort path.

**What blows the budget.** A notification-provider outage (the most common cause once we wire real providers), a Lambda timeout on a slow Postgres query (mitigated by the reminder query's covering index), an EventBridge -> Lambda permission drift (rare; Terraform-managed). The reminder rule is observed by both the EventBridge dashboard widget and the existing `${env}-eventbridge-failed` alarm.

## Error budget policy

The error budget policy is the rule for what an operator does when an SLO's budget is depleted (or burning fast). The policy is intentionally light for the MVP — we don't have a paging rotation yet — but the rules establish the cadence we'll formalize as the team grows.

1. **Budget healthy (< 50% consumed).** No special action. Continue normal deploy cadence + feature work.
2. **Budget watch (50–75% consumed).** Reviewer on every PR is encouraged to flag risky changes (schema migrations, IAM policy changes, anything touching the affected endpoint's Lambda). No automatic freeze.
3. **Budget burning (75–100% consumed).** Feature work for the affected endpoint is paused. The next deploy on that codepath must be a fix that demonstrably moves the SLI in the right direction (cited in the PR description). Deploys to *other* codepaths continue.
4. **Budget exhausted (100% consumed before window rolls).** A short retrospective is written before the next deploy of any kind. The retro lives in `docs/operations/retros/<date>-<slo>.md` and answers four questions: what happened, what we'd do differently, what residual risk remains, what changes (code or runbook) we're shipping in response.

**Fast-burn alerting.** Any SLO whose 5-minute burn rate exceeds 14.4× (i.e. would exhaust a 30-day budget in 50 hours) is treated as an incident regardless of the headline percentage. The wired CloudWatch alarms (`${env}-slo-booking-creation-errors`, `${env}-slo-browse-latency-p95`) are the fast-burn proxies — they fire well before the budget actually empties. The 30-day rolling number is the post-hoc reckoning.

**No customer-facing SLA.** The numbers in this document are internal operating targets, not contractual commitments. Public SLA language requires legal review + a customer-facing status page; both are post-MVP.

## Dashboards

The `${env}-endpoints` CloudWatch dashboard groups widgets by route family and is the primary operator view for SLI numbers. Open via:

```bash
aws cloudwatch get-dashboard --dashboard-name "ethiolink-${env}-endpoints"
```

The dashboard has four row-pairs (errors + p95 latency per row), keyed by route family:

| Row group        | Routes covered                                                                                                                                                                                                              | What to watch                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browse**       | `categories-list`, `businesses-list`, `businesses-get`, `reviews-list-for-business`, `services-list`, `staff-list`, `availability-get`, `availability-slots`                                                                  | p95 against the 800 ms SLO target. Latency is the headline number.                                                                              |
| **Appointments** | `appointments-create`, `appointments-accept`, `appointments-reject`, `appointments-cancel`, `appointments-reschedule`, `appointments-complete`, `appointments-review`, `appointments-list-mine`, `appointments-list-for-business` | Errors on `appointments-create` against the booking-creation SLO. The other endpoints share the same DB write path and tend to fail together.   |
| **Admin**        | every `admin-*` function (13 in total)                                                                                                                                                                                       | Errors. Admin endpoints fail far less often than customer-facing ones, but a sustained admin error rate is a signal to investigate before it surfaces customer-side. |
| **Auth-sync**    | `auth-sync`, `me-get`, `me-patch`                                                                                                                                                                                            | Errors. Auth-sync is the cold-start path for every new user — a sustained failure here breaks new-user onboarding silently.                     |

The existing 4 dashboards (`${env}-api-gateway`, `${env}-lambda`, `${env}-rds`, `${env}-waf-eventbridge`) remain — they're the cross-cutting views (API-wide, Lambda-wide, DB-wide, security-and-jobs). The new `${env}-endpoints` dashboard is the route-family-aware overlay.

## SLO review cadence

- **Monthly** — operator reviews the rolling 30-day numbers, marks any breached budget, writes the retro for any exhausted budget.
- **Quarterly** — SLO targets themselves are re-examined against actual observed performance. Either tighten (if we've been comfortably hitting target) or rewrite (if the target turned out to be wrong). The change lands in this document with a [Revision history](#revision-history) entry.
- **Ad-hoc** — any major incident triggers a retro that may also propose an SLO change.

## Revision history

| Date       | Change                                                                                  | Author      |
| ---------- | --------------------------------------------------------------------------------------- | ----------- |
| 2026-05-15 | Initial draft. Phase 8 production hardening — SLOs 1–4 defined, error-budget policy set. | Engineering |
