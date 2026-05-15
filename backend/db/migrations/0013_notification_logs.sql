-- EthioLink — migration 0013: notification_logs table.
--
-- Persisted record of every outbound notification attempt. One row
-- per (recipient × channel × template) dispatch — the booking flow
-- inserts as `QUEUED`, the gateway call resolves it to `SENT`
-- (provider acknowledged) or `FAILED` (provider raised an error).
--
-- See docs/architecture/DATABASE_SCHEMA.md "notification_logs" for
-- the canonical column spec.
--
-- Design notes:
--   * **Mutation model is QUEUED → SENT / FAILED.** The
--     `NotificationLogRepository` exposes exactly two write paths:
--     `insert` (which creates the row at `status = 'QUEUED'`) and
--     `update` (which flips it to `SENT` / `FAILED` and writes
--     `provider_ref` / `error_message` once the gateway call
--     returns). `DELIVERED` is reserved for a future read-receipt
--     flow (SMS provider callbacks, email opens) and has no MVP
--     producer; the CHECK list keeps it so a future commit can use
--     it without a schema change. No `delete` path — notification
--     attempts are permanent and audit-relevant.
--
--   * **`recipient_user_id` has `ON DELETE SET NULL`** rather than
--     `RESTRICT` (used by `appointments.customer_id`, etc.) or
--     `CASCADE`. The notification history outlives the recipient:
--     if a user is hard-deleted, their notification log entries
--     stay — the `recipient_user_id` goes to NULL so the FK is
--     consistent, but the `channel`, `template_key`, `payload`,
--     `status`, and timestamps remain for audit / reconciliation.
--     Mirrors how some auth systems retain logout / login attempts
--     for deleted accounts.
--
--   * **`template_key` is `text` without a CHECK.** Same stance as
--     `admin_actions.action` (migration 0012): the application
--     layer owns the enum. Adding a new template key
--     (e.g. `booking.no_show.customer`) is a code-only change; no
--     migration required. The contract documented in
--     `notificationService.ts` (additive — extend, never rename or
--     remove, removing breaks deserialization of historical rows).
--
--   * **`channel` IS CHECK-constrained.** Channels are
--     infrastructure choices (SMS / EMAIL / TELEGRAM / PUSH / MOCK)
--     and adding a new one means adding a real provider — a far
--     bigger commit than a typo-fix. The CHECK is the cheap guard
--     that prevents an application-layer bug from writing `'sms'`
--     in lowercase.
--
--   * **`status` defaults to `'QUEUED'`.** The dispatcher inserts
--     the row before calling the gateway; the column default makes
--     that insert short and unambiguous. The first UPDATE moves it
--     to `SENT` or `FAILED`.
--
--   * **`provider` defaults to `'MOCK'`.** The MVP default
--     dispatcher uses `MockNotificationGateway`; explicit
--     `provider` is written by real providers (SMS / Telegram /
--     Email) when they're configured. Free-form `text` rather than
--     a CHECK list because new providers ship as code-only changes
--     too — same justification as `template_key`.
--
--   * **Indexes** match the two documented read paths:
--     - `(recipient_user_id, created_at DESC)` — "what has this
--       user received recently". Used by the admin user-detail
--       view (future) and the support inquiry path.
--     - `(status, created_at DESC)` — "show me failed
--       notifications in the last 24 hours". Used by the admin
--       notification-logs listing endpoint's default filter and
--       by any future "retry the failures" reconciliation job.
--
--   * Reuses the `set_updated_at()` trigger function defined in
--     migration 0002.

BEGIN;

CREATE TABLE notification_logs (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_user_id   uuid
        REFERENCES users (id) ON DELETE SET NULL,
    channel             text          NOT NULL
        CHECK (channel IN ('SMS', 'EMAIL', 'TELEGRAM', 'PUSH', 'MOCK')),
    template_key        text          NOT NULL,
    payload             jsonb         NOT NULL,
    status              text          NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'SENT', 'DELIVERED', 'FAILED')),
    provider            text          NOT NULL DEFAULT 'MOCK',
    provider_ref        text,
    error_message       text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX notification_logs_recipient_created_idx
    ON notification_logs (recipient_user_id, created_at DESC);

CREATE INDEX notification_logs_status_created_idx
    ON notification_logs (status, created_at DESC);

CREATE TRIGGER notification_logs_set_updated_at
BEFORE UPDATE ON notification_logs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
