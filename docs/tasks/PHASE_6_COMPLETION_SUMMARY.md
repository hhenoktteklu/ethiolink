# Phase 6 — Completion Summary

End of Phase 6 (Notifications). The notification dispatcher fans out behind a pluggable gateway port; every booking lifecycle mutation fires the right template through it; a scheduled reminder lambda handles the 24-hour-ahead ping with `notification_logs`-backed idempotency; and the admin dashboard exposes a read-only troubleshooting surface. `npm test` is green; migration 0013 is applied locally. One remaining checklist sub-item is gated on Phase 7 deploy work — the EventBridge Terraform rule — none on Phase 6 code.

Authoritative scope and checklist live in [`PHASE_6_NOTIFICATIONS.md`](./PHASE_6_NOTIFICATIONS.md). This file is the at-a-glance status read on 2026-05-15.

## Completed notification features

**Schema (migration 0013)**
- `notification_logs` table — `recipient_user_id` FK `ON DELETE SET NULL` (notification history outlives the recipient), `channel` CHECK list (`SMS` / `EMAIL` / `TELEGRAM` / `PUSH` / `MOCK`), `status` CHECK list (`QUEUED` / `SENT` / `DELIVERED` / `FAILED`) defaulting to `QUEUED`, `template_key text` (no CHECK — application-layer enum, additive contract), `payload jsonb NOT NULL`, `provider text` defaulting to `MOCK`, nullable `provider_ref` + `error_message`, `set_updated_at()` trigger reused from migration 0002, two listing indexes on `(recipient_user_id, created_at DESC)` and `(status, created_at DESC)`. The mutation model documented in the header is QUEUED → SENT / FAILED only; `DELIVERED` is reserved for a future read-receipt flow with no MVP producer.

**Domain layer**
- `PgNotificationLogRepository` exposes the constrained lifecycle: `insert` writes at the DB-default `'QUEUED'`; `updateStatus(id, { status, providerRef, errorMessage })` is the single mutation path. `recipient_user_id` / `channel` / `template_key` / `payload` are immutable post-insert by design (no setters). Reads: `findById`, `listForAdmin(filters, limit)` with `status` / `channel` / `recipientUserId` / `fromUtc` / `toUtc` filters sorted `created_at DESC, id DESC`, and `existsForAppointmentSlot({ templateKey, recipientUserId, startsAtUtc })` — a `SELECT 1 LIMIT 1` against `payload->>'startsAtUtc'` that backs the reminder lambda's idempotency check.
- `notificationLogView.ts` returns ISO-8601 timestamps and passes `payload` through verbatim for `<pre>` rendering in the dashboard. No public projection — recipients see the channel-side delivery, not the log.

**Gateway abstraction**
- `NotificationGateway` port — `channel`, `provider`, `send(NotificationSendInput) → NotificationSendResult` with the result-vs-throw split. `'FAILED'` results mean "provider tried and rejected" (the dispatcher persists FAILED and continues); typed `NotificationGatewayError` / `NotificationProviderNotConfiguredError` mean "can't service this request" (same posture — dispatcher catches and persists). Pre-rendered `NotificationRenderedMessage` (subject + body + metadata) keeps the future `templateRegistry` decoupled from transport.
- `MockNotificationGateway` — always returns `'SENT'` with a `mock-<uuid>` `providerRef` and an echo'd `rawResponse`. MVP default for every channel.
- `SmsNotificationGateway` + `TelegramNotificationGateway` — stubs that throw `NotificationProviderNotConfiguredError` (code `'NOTIFICATION_PROVIDER_NOT_CONFIGURED'`). Header docs sketch the future constructor + concrete `provider` name when real Ethio Telecom / AfroMessage / Telegram Bot API integrations ship.

**Template registry**
- `templateRegistry.ts` — closed `BookingTemplateKey` union for the eight MVP keys (`booking.requested.business`, `booking.accepted.customer`, `booking.rejected.customer`, `booking.cancelled.business`, `booking.cancelled.customer`, `booking.rescheduled.business`, `booking.reminder.customer`, `booking.reminder.business`). Single shared `BookingTemplatePayload` shape (businessName, serviceName, customerDisplayName, startsAtUtc, optional cancelReason + rescheduleNotes). Pure synchronous renderers with Luxon-formatted Addis Ababa local times; `subject = null` for every template (SMS / Telegram ignore subjects); `UnknownTemplateKeyError` for unregistered keys.

**Dispatcher**
- `NotificationService` — six-step lifecycle: resolve recipient → render template → look up gateway → insert QUEUED log → call `gateway.send` → update to SENT / FAILED. Channel defaults to `MOCK`. Provider errors (`NotificationGatewayError` subclasses) are CAUGHT and persisted as FAILED so bookings never break; internal errors (`UnknownTemplateKeyError`, `NotificationRecipientNotFoundError`, `NoGatewayForChannelError`) surface to the caller and DO NOT write a log row. Unexpected non-provider errors are caught for a best-effort FAILED mark, then re-thrown.

**Booking lifecycle integration**
- `AppointmentService` composes the dispatcher (plus `UserRepository` for customer-name lookups) and fires one `dispatch` call per successful mutation:

  | Event                          | Template                          | Recipient        |
  | ------------------------------ | --------------------------------- | ---------------- |
  | `create`                       | `booking.requested.business`      | business owner   |
  | `accept`                       | `booking.accepted.customer`       | customer         |
  | `reject`                       | `booking.rejected.customer`       | customer         |
  | `cancel` by `CUSTOMER`         | `booking.cancelled.business`      | business owner   |
  | `cancel` by `BUSINESS`/`ADMIN` | `booking.cancelled.customer`      | customer         |
  | `reschedule` by `CUSTOMER`     | `booking.rescheduled.business`    | business owner   |
  | `complete`                     | *(intentionally none in MVP)*     | —                |

  Channel is hardcoded to `MOCK` at the cold-start wiring of all eight appointment Lambdas. The two `notifyBusinessOwner` / `notifyCustomer` helpers wrap each `dispatch` call in an extra try/catch that logs and swallows any error class that escapes the dispatcher — defense-in-depth on the "notifications must never break a booking" rule.

**Scheduled reminder lambda**
- `backend/lambdas/scheduled/sendReminders.ts` exposes a `ScheduledHandler` entry + a pure `runReminderBatch(deps)` core (exported for tests). Each scan covers `[now + 23h45m, now + 24h00m)` via the new `AppointmentsRepository.listForReminderWindow` query (sorted `starts_at ASC, id ASC`, hard cap 1000). Per appointment it dispatches `booking.reminder.customer` to the customer and `booking.reminder.business` to the business owner. Idempotency runs through `existsForAppointmentSlot` — any prior log row at any status causes the dispatch to be skipped. The handler returns a `ReminderBatchSummary { scanned, sent, skipped, failed }`; per-target failures are isolated and never poison the batch. The EventBridge rule that drives the 15-minute cron is deferred to Phase 7; the Lambda is invocable today via `aws lambda invoke`.

## Completed backend admin surface

- `GET /v1/admin/notifications` (`backend/lambdas/admin/notifications/list.ts`) — ADMIN-gated via `authorizeAdmin`, read-only. Supports filters `status` / `channel` / `recipientUserId` / `from` / `to` (all optional, AND-combined), defaults `limit=100` and caps at 100, calls `NotificationLogRepository.listForAdmin`, returns `{ items: NotificationLogView[] }` sorted `created_at DESC, id DESC`. Closed-enum validation for `status` and `channel`; UUID regex for `recipientUserId`; ISO-8601 parse for date filters.
- OpenAPI is updated alongside: the `adminListNotifications` operation under `/admin/notifications` plus four new schemas (`NotificationStatus`, `NotificationChannel`, `NotificationLogView`, `NotificationLogList`).

## Completed admin dashboard surface

- New `NotificationsPage` route at `/notifications` with a five-filter form (status / channel / recipientUserId / from / to) mirroring the existing Bookings page. TanStack Query for fetching; ApiError-aware error rendering; the standard "showing first 100 — tighten filters" hint when the cap is hit.
- 10-column table: id, recipientUserId, channel, templateKey, status (colored badge), provider, providerRef, errorMessage, createdAt (local time), and `payload` rendered as a wrapped `<pre>` block.
- Read-only. No retry / resend button — that's a future commit that needs a matching "clear" endpoint paired with the idempotency-key story.
- `listAdminNotifications(params)` lands in `admin/src/lib/api.ts` with `NotificationStatus` / `NotificationChannel` / `NotificationLogView` types. `App.tsx` adds the route; `AdminLayout.tsx` adds the nav entry.

## Migrations applied locally

| Migration                         | Highlights                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `0013_notification_logs.sql`      | Notification log table — `recipient_user_id` FK ON DELETE SET NULL, `channel` + `status` CHECK lists, `template_key` permissive, `provider` defaults to `MOCK`, `set_updated_at()` trigger reused, two listing indexes. |

Applied on 2026-05-15 via `npm run db:migrate` against docker-compose Postgres; `schema_migrations` shows the row. The AWS-hosted dev RDS apply is gated on Phase 7's Terraform RDS module (same gate as 0009–0012 — see [`PHASE_4_MIGRATION_RUN.md`](./PHASE_4_MIGRATION_RUN.md) for the remote-RDS env-var pattern that will apply unchanged once RDS is up).

## Tests passing locally

`npm test` exercises 21 test files and passes locally as of 2026-05-15.

| Phase 6 test file                                          | Coverage                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/notifications/notificationGateways.test.ts`         | MockNotificationGateway always-SENT contract (channel + provider + `mock-<uuid>` providerRef + echo'd rawResponse + ISO-8601 sentAt + fresh ref per call). SMS + Telegram stubs throw `NotificationProviderNotConfiguredError` with the stable `'NOTIFICATION_PROVIDER_NOT_CONFIGURED'` code. |
| `tests/notifications/templateRegistry.test.ts`             | Eight-key set assertion + `isBookingTemplateKey` type-guard + per-key body content (business / customer / cancel-reason / reschedule-notes) + null-reason / null-notes fallbacks + `customerDisplayName: null` → "A customer" + Addis-Ababa local-time format + `UnknownTemplateKeyError`. |
| `tests/notifications/notificationService.test.ts`          | Happy path (default `MOCK` channel, SENT row with providerRef plumbed). Provider FAILED result persisted with errorMessage. `NotificationGatewayError` subclass swallowed. Non-provider error re-thrown after best-effort FAILED mark. `UnknownTemplateKeyError` / `NotificationRecipientNotFoundError` / `NoGatewayForChannelError` surface without writing a log row. |
| `tests/notifications/sendReminders.test.ts`                | Happy path → 2 sent. Idempotent second run → 2 skipped (ledger unchanged). Too-early / too-late window boundaries (0 scanned each). REQUESTED / CANCELLED / COMPLETED status filter (0 scanned). Orphan business → `failed: 2`. Partial pre-existing ledger → 1 sent + 1 skipped. |
| `tests/appointments/appointmentService.test.ts` *(extended)* | New `AppointmentService — booking lifecycle notifications` describe block: create → `booking.requested.business` (recipient = business owner), accept → `booking.accepted.customer`, reject → `booking.rejected.customer`, CUSTOMER cancel → `booking.cancelled.business` (with `cancelReason`), BUSINESS / ADMIN cancel → `booking.cancelled.customer`, CUSTOMER reschedule → `booking.rescheduled.business`, `complete` → 0 notifications, dispatch-failure-does-not-break-booking. |
| `tests/_fakes/InMemoryNotificationLogRepository.ts`         | In-memory fake mirroring `PgNotificationLogRepository` (QUEUED-default insert + `MOCK` provider default, single-shot updateStatus, full `listForAdmin` filter semantics, `existsForAppointmentSlot` triple lookup). |

Existing Phase 1–5 test files (16 of them) still pass — no regressions during the Phase 6 work. The `InMemoryAppointmentsRepository` and `InMemoryNotificationLogRepository` fakes were extended (reminder-window scan, appointment-slot dispatch lookup) without changing the existing surface.

## Remaining Phase 7 deploy gates

None of these block Phase 6 completion; each closes as part of the Phase 7 deploy pipeline.

- **Migration 0013 applied to the AWS-hosted dev RDS.** Same gate as 0009–0012: today's `infra/terraform/environments/dev/main.tf` provisions only Cognito. The `module "rds"` block lands in Phase 7; once that's `terraform apply`-ed, `npm run db:migrate` runs against the RDS endpoint with the `PG_*` env vars set.
- **EventBridge Terraform rule for `sendReminders`.** The Lambda is wired and idempotent today; what's missing is the `infra/terraform/modules/eventbridge/` module that creates an `aws_cloudwatch_event_rule` on a `cron(0/15 * * * ? *)` schedule and an `aws_cloudwatch_event_target` pointing at the Lambda function ARN, plus an `aws_lambda_permission` to allow EventBridge to invoke it. Smoke-testable today with `aws lambda invoke`.
- **NotificationsPage shipped via the admin frontend deploy pipeline.** Same gate as Phase 5: the admin app builds with `tsc --noEmit && vite build` to `admin/dist/` but the Phase 7 deploy module wires that output to S3 + CloudFront. The `/notifications` route works on `npm run dev` locally today.

## Known follow-ups

Non-blocking design tightening or feature roadmap items called out during the Phase 6 audits. None gate any subsequent phase.

- **Real SMS / Telegram provider integration.** `SmsNotificationGateway` and `TelegramNotificationGateway` are placeholder classes that throw `NotificationProviderNotConfiguredError` on every `send`. Each ships behind a new concrete class (e.g. `EthioTelecomSmsGateway`, `AfroMessageSmsGateway`, `TelegramBotGateway`) implementing the same `NotificationGateway` port. The cold-start wiring in each appointment Lambda then registers the real gateway under its channel key in the dispatcher's `gateways` map; no domain-layer change required. Templated message bodies stay channel-neutral; provider-specific concerns (sender IDs, bot tokens, dynamic-template IDs) flow through `NotificationRenderedMessage.metadata` and gateway constructor params.
- **EventBridge Terraform rule for `sendReminders`.** Listed above as a Phase 7 deploy gate. The Lambda is invocable manually today; what's missing is the `cron(0/15 * * * ? *)` rule + target + permission resources.
- **Retry policy for failed notifications.** The current dispatcher writes `FAILED` on a provider rejection and stops; `existsForAppointmentSlot` skips on any prior log row regardless of status, which means a permanently-broken provider can't blast the same recipient every cycle but a transient failure also doesn't auto-retry. The minimum viable retry is a separate scheduled job that scans `notification_logs` for `FAILED` rows newer than N minutes whose `recipient_user_id`/`payload`/`template_key` triple doesn't have a subsequent `SENT` row, and re-dispatches with bounded attempts. Pairs naturally with a "clear-failed" admin button (which itself unlocks the retry-from-dashboard UX).
- **User notification preferences.** MVP sends every booking event to every recipient on every available channel — there is no opt-out, no quiet hours, no per-channel preference. A future `users.notification_preferences jsonb` column (or a normalized `user_notification_preferences` table) plus a `GET/PATCH /v1/me/notification-preferences` endpoint covers this. The dispatcher learns to filter / pick channel based on the resolved recipient row's preferences before calling `gateway.send`.
- **Amharic-language templates.** The eight MVP templates render English only. The shared `BookingTemplatePayload` already carries the data; Amharic ships as a parallel set of renderers + a per-user locale field (`users.locale` or `customer_profiles.locale`). The dispatcher picks the locale from the resolved recipient, the registry returns the rendered message for that locale. `LocalizedText` (already in use for `business_profiles.description` / `services.name` etc.) is the natural carry-over shape.
- **`DELIVERED` read-receipt flow.** The schema reserves `DELIVERED` as a status; the dispatcher never produces it. Real read receipts (SMS provider DLR callbacks, email open pixels, Telegram delivery confirmations) land via a new inbound webhook handler that transitions `notification_logs` from `SENT` to `DELIVERED` by `provider_ref`. The transition + the schema are already supported; only the inbound webhook is missing.
- **`withTransaction` for booking + notification dispatch.** The appointment mutation, the audit-row insert (from Phase 5 admin paths), and the notification dispatch run as separate statements. The dispatcher's "swallow everything" posture means a notification miss never breaks a booking — but a notification-row insert that lands while the appointment update fails (rare ordering edge) would leave an orphan `notification_logs` row. The canonical fix threads a `PoolClient` through the booking flow. The same `withTransaction` follow-up is also listed in the Phase 5 summary; one commit can convert every multi-write service in a single pass.

## Next recommended phase

**Phase 7 — AWS Deployment.** Phase 6 closes out the MVP feature surface — the marketplace, the booking flow, the admin dashboard, and the notification fan-out all work end-to-end on a local docker-compose Postgres. What's left is making that surface reachable on a real AWS environment. Phase 7 delivers:

- The `module "rds"` Terraform block that provisions the dev RDS instance, which unblocks migrations 0009–0013 from running against the AWS-hosted dev database.
- The EventBridge rule + Lambda permissions for `sendReminders` on its 15-minute cron.
- The admin frontend deploy pipeline (S3 + CloudFront for `admin/dist/`).
- The Cognito callback / logout URL registrations on the admin app client.
- The customer-facing API Gateway routes wired to the Phase 4 + Phase 6 Lambdas with the correct authorization + CORS posture.

The remaining Phase 5 + Phase 6 deploy gates (admin frontend pipeline, Cognito URL registration, EventBridge rule, RDS-side migration applies) all close as side effects of Phase 7's work — none of them are independent.

**Alternative — Phase 8 (Production Hardening).** If a stakeholder demo on a real AWS environment is already imminent and the goal is to *operate* the marketplace instead of just deploy it, Phase 8 jumps the queue: security review (Cognito policy hardening, WAF rules on API Gateway, S3 bucket policies, IAM scoping), performance tuning (Postgres index audit, Lambda cold-start budgets, RUM on the admin dashboard), monitoring depth (CloudWatch metric filters for `notification_logs.status = 'FAILED'`, dashboards for the booking funnel, alarms for the reminder lambda's `failed` count), and runbooks for on-call. Defensible if production-readiness, not deployability, is the constraint — most teams find Phase 7 deploy work has to land first either way, so the more common ordering is 7 → 8.
