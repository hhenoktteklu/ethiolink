# Phase 6 — Notifications

## Goal

Introduce a notification abstraction with SMS, email, and Telegram channels. Mock provider is the default; real providers (Ethiopian SMS gateways, Telegram bot) are pluggable behind the same interface. Persist every outbound notification attempt in `notification_logs`.

## Scope

In scope:

- DB migration for `notification_logs`.
- `NotificationGateway` interface; `MockNotificationGateway` implementation; provider scaffolding for SMS and Telegram (no real credentials in MVP).
- Templated messages keyed by `template_key` (e.g., `booking.confirmation.customer`, `booking.requested.business`).
- Triggering events:
  - Customer creates booking → notify business (REQUESTED).
  - Business accepts/rejects → notify customer.
  - Customer cancels → notify business; business cancels → notify customer.
  - Reschedule → notify the other party.
  - Reminder 24 hours before appointment (EventBridge scheduled rule reading upcoming appointments).
- Notification log endpoints for admin troubleshooting (read-only).

Out of scope:

- Push notifications via FCM/APNs.
- Real SMS provider credentials (kept behind a feature flag).
- User notification preferences UI (everyone gets default channels in MVP).

## Files involved

- `backend/db/migrations/0013_notification_logs.sql`
- `backend/shared/adapters/notifications/NotificationGateway.ts`
- `backend/shared/adapters/notifications/MockNotificationGateway.ts`
- `backend/shared/adapters/notifications/SmsNotificationGateway.ts` (stub)
- `backend/shared/adapters/notifications/TelegramNotificationGateway.ts` (stub)
- `backend/shared/notifications/templates/*`
- `backend/lambdas/scheduled/sendReminders.ts`
- `backend/lambdas/admin/notifications/list.ts`
- Hooks added in existing booking handlers to dispatch notifications.
- `infra/terraform/modules/eventbridge/` for the reminder schedule.

## Checklist

- [ ] Migration 0013 applied.<!-- `0013_notification_logs.sql` authored: id uuid PK, `recipient_user_id` FK `ON DELETE SET NULL` (notification history outlives the recipient), `channel` CHECK in `SMS`/`EMAIL`/`TELEGRAM`/`PUSH`/`MOCK`, `template_key text` with no CHECK (app-layer enum — additive contract, same stance as `admin_actions.action`), `payload jsonb NOT NULL`, `status` default `QUEUED` CHECK in `QUEUED`/`SENT`/`DELIVERED`/`FAILED`, `provider` default `MOCK`, nullable `provider_ref` + `error_message`, `set_updated_at()` trigger reused, indexes on `(recipient_user_id, created_at DESC)` + `(status, created_at DESC)`. The mutation model documented in the header is QUEUED→SENT/FAILED only — `DELIVERED` reserved for a future read-receipt path. "Applied" needs `npm run db:migrate` locally; Phase 7 RDS provisioning for the AWS-hosted dev apply. -->
- [x] All booking lifecycle events dispatch the correct notifications via the gateway.<!-- Booking integration in place: `AppointmentService` now composes `NotificationService` (plus `UserRepository` for customer-name lookups) and fires one `dispatch` call per successful mutation. Event → template → recipient matrix: `create` → `booking.requested.business` → business owner; `accept` → `booking.accepted.customer` → customer; `reject` → `booking.rejected.customer` → customer; CUSTOMER `cancel` → `booking.cancelled.business` → business owner (with `cancelReason`); BUSINESS / ADMIN `cancel` → `booking.cancelled.customer` → customer (with `cancelReason`); CUSTOMER `reschedule` → `booking.rescheduled.business` → business owner. `complete` deliberately fires nothing in MVP — the review-prompt notification is a future scheduled-job concern. Channel is hardcoded to `MOCK`; the eight Lambda handlers all wire `MockNotificationGateway` at cold-start. All dispatch calls go through `notifyBusinessOwner` / `notifyCustomer`, which wrap the dispatcher in an extra try/catch that logs and swallows anything that escapes — defense-in-depth on the "notifications must never break a booking" rule. --><!-- Dispatcher in place: `backend/shared/domains/notifications/notificationService.ts` composes `UserRepository` + `NotificationLogRepository` + a per-channel `NotificationGateway` map. Lifecycle: resolve recipient → render template → insert QUEUED log → call gateway → update SENT or FAILED. Provider errors (`NotificationGatewayError` subclasses) are CAUGHT and persisted as FAILED so bookings never break; internal errors (`UnknownTemplateKeyError`, `NotificationRecipientNotFoundError`, `NoGatewayForChannelError`) surface to the caller and DO NOT write a log row. Default channel is `MOCK`. Template registry (`templateRegistry.ts`) ships the eight MVP booking template keys (requested.business, accepted.customer, rejected.customer, cancelled.business, cancelled.customer, rescheduled.business, reminder.customer, reminder.business) — closed union here, permissive `string` at the repository layer. Booking-handler integration is the next code commit; the dispatcher is the only thing those handlers call. --><!-- Gateway abstraction in place: `backend/shared/adapters/notifications/NotificationGateway.ts` defines the port (`channel` + `provider` + `send(NotificationSendInput) → NotificationSendResult`), with the result-vs-throw split: `'FAILED'` for "provider rejected" (dispatcher persists + booking continues), typed `NotificationGatewayError` / `NotificationProviderNotConfiguredError` for "can't service this request" (same posture). `MockNotificationGateway` always returns `'SENT'` with a `mock-<uuid>` providerRef — the default until real providers are wired up. `SmsNotificationGateway` + `TelegramNotificationGateway` are stubs that throw `NotificationProviderNotConfiguredError`; they reserve the `channel` slots and provide the constructor shape for future real providers. No DB coupling here — the dispatcher (next commit, `NotificationService`) owns the translation between gateway results and `notification_logs.updateStatus` calls. Template rendering is also kept out of the gateway: it accepts a pre-rendered `NotificationRenderedMessage` (subject + body + metadata), so the future `templateRegistry` is decoupled from the transport. -->
- [ ] `notification_logs` rows reflect attempts and final status.<!-- Repository in place: `backend/shared/domains/notifications/notificationLogRepository.ts` exposes the constrained lifecycle — `insert` writes the row at the DB-default `status = 'QUEUED'`, `updateStatus(id, { status, providerRef, errorMessage })` is the only mutation. `recipient_user_id` / `channel` / `template_key` / `payload` are immutable post-insert by design (no setters exposed). Reads: `findById` (point lookup) + `listForAdmin(filters, limit)` with `status` / `channel` / `recipientUserId` / `fromUtc` / `toUtc` filters, sorted `created_at DESC, id DESC`. View module (`notificationLogView.ts`) returns JSON with ISO-8601 timestamps and the raw `payload` passed through verbatim for admin debugging. `NotificationGateway` port + `MockNotificationGateway` are the next code commits; the dispatcher composes them with this repository to fill out the lifecycle. -->
- [ ] EventBridge schedule fires `sendReminders` every 15 minutes; idempotent — same appointment is not re-reminded.
- [ ] Admin can list notification logs filtered by user, channel, status.

## Acceptance criteria

- Switching `NOTIFICATIONS_PROVIDER=mock` (default) results in logs marked `SENT` with no external calls.
- Switching to `sms` or `telegram` (when credentials are provided) routes the same template through the real provider without code changes.
- A failing provider records `FAILED` plus the error message and does not break the booking flow.

## Test plan

- Unit: template rendering with a fixture payload.
- Unit: notification dispatcher fan-out per event with the mock gateway, asserting the right `template_key` is selected.
- Integration: book → assert two log rows (customer + business).
- Manual: simulate provider failure; assert booking still succeeds and `notification_logs` shows the failure.

## Rollback notes

- Migration forward-only.
- Notifications are best-effort — the dispatch path catches all errors, so disabling notifications cannot block bookings.
- To roll back the EventBridge schedule, set its `enabled` flag to false in Terraform.
