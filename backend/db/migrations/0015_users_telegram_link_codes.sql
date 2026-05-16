-- EthioLink — migration 0015: users_telegram_link_codes table.
--
-- Phase 9 Track 2 foundation. Short-lived linking codes used to
-- bind a Telegram chat id to an EthioLink user. Flow:
--
--   1. Mobile (or admin SPA) calls
--      `POST /v1/me/link-telegram/start` — handler invokes
--      `telegramLinkService.startLink(userId)` which inserts a
--      row here with a fresh random `code` and `expires_at = now()
--      + 10 minutes` (configurable per env).
--   2. The user opens the returned `https://t.me/<bot>?start=<code>`
--      deep link in Telegram. The bot receives a `/start <code>`
--      message; a future Telegram webhook Lambda redeems the code
--      via `telegramLinkService.redeemCode(code, chatId)` which
--      reads + deletes this row and writes
--      `users.telegram_chat_id = chatId` in the same transaction.
--   3. Abandoned codes expire on their own; a daily sweep job
--      calls `deleteExpired()` to keep the table small.
--
-- Design notes:
--   * `code` is the PRIMARY KEY — collisions are vanishingly
--     unlikely (the application generates 32-character base32
--     codes from `crypto.randomBytes`) and the unique constraint
--     is the cheapest dedup. No surrogate UUID id since we never
--     reference these rows by id from other tables.
--   * `ON DELETE CASCADE` on the FK to `users(id)` because a code
--     is meaningless after its owner is hard-deleted. Mirrors the
--     `customer_profiles` / `business_profiles` policy.
--   * No `updated_at` column. Codes are immutable post-insert —
--     they're either present-and-valid, expired (sweep target),
--     or deleted (redeemed / unlinked).
--   * One row per (user, in-flight linking attempt). The service
--     deletes the previous code for the same user before
--     inserting a new one so an interrupted "Start linking" tap
--     immediately invalidates the old code — small UX win, and
--     keeps the table from growing on repeated taps.
--   * Index on `(user_id)` for the per-user delete path. Index on
--     `(expires_at)` for the sweep job's `WHERE expires_at < now()`
--     predicate.

BEGIN;

CREATE TABLE users_telegram_link_codes (
    code        text        PRIMARY KEY,
    user_id     uuid        NOT NULL
        REFERENCES users (id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_telegram_link_codes_user_idx
    ON users_telegram_link_codes (user_id);

CREATE INDEX users_telegram_link_codes_expires_idx
    ON users_telegram_link_codes (expires_at);

COMMIT;
