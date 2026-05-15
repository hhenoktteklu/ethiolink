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
- [ ] All booking lifecycle events dispatch the correct notifications via the gateway.
- [ ] `notification_logs` rows reflect attempts and final status.
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
