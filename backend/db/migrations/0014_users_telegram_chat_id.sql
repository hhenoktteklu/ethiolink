-- EthioLink — migration 0014: users.telegram_chat_id.
--
-- Phase 9 Track 2 foundation. Stores the Telegram chat id of users
-- who have linked their account to the bot. `NULL` for everyone
-- else (the default — Telegram linking is opt-in). The
-- `notificationService.buildRecipient` helper reads this column
-- and forwards the value as `recipient.telegramChatId` on every
-- `dispatch`; gateways that aren't `TELEGRAM` ignore it.
--
-- Design notes:
--   * `text` not `bigint`. Telegram chat ids are signed 64-bit
--     integers in the wire protocol but the Bot API documents them
--     as strings on output; using `text` avoids cross-language
--     precision surprises (JavaScript's safe integer ceiling is
--     2^53, and some group chat ids exceed that). The application
--     layer treats it as an opaque token.
--   * Nullable. The user opts in via the linking flow; absence is
--     not an error — the dispatcher's channel selector falls back
--     to SMS or MOCK when the chat id is absent.
--   * Per-environment uniqueness is NOT enforced at the schema
--     level. A real Telegram chat could in principle belong to
--     multiple EthioLink accounts (e.g. an admin re-using their
--     personal Telegram to test a customer account). The linking
--     service enforces "one user → one chat id" at the application
--     layer; if the operator ever wants a hard DB-level UNIQUE,
--     a future migration adds it once the data is known clean.
--   * Partial index for cheap "is anyone linked?" admin queries —
--     covers `WHERE telegram_chat_id IS NOT NULL` predicates
--     without bloating the main column index.

BEGIN;

ALTER TABLE users
    ADD COLUMN telegram_chat_id text NULL;

CREATE INDEX users_telegram_chat_id_present_idx
    ON users (id)
    WHERE telegram_chat_id IS NOT NULL;

COMMIT;
