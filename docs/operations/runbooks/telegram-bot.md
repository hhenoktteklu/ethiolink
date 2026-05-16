# EthioLink — Telegram Bot Runbook

This is the playbook the operator follows to switch the notification dispatcher from `MockNotificationGateway` / `GenericSmsGateway` to (or alongside) the real Telegram bot, validate the end-to-end path, and respond to provider-side issues afterwards. The runbook assumes Phase 9 commits `2047637`, `25fdef3`, `23eba88`, and `92218e1` are merged on `main` — every code-side seam the Telegram path needs is already in place.

Architecture posture: Telegram is **opt-in per env** (the env stack flips a flag) and **opt-in per user** (each customer / owner links their account from the mobile Profile screen). Unlinked users continue receiving SMS (or MOCK) — the dispatcher's per-recipient priority `TELEGRAM > SMS > MOCK` falls through automatically. No customer is forced to use Telegram.

## Bot provisioning (BotFather)

Telegram bots are created through `@BotFather` in the Telegram client. There is no API; this step is operator-led and one-time per environment.

1. Open Telegram, search for `@BotFather`, start a conversation.
2. Send `/newbot`.
3. **Name** (display name shown in chat list): `EthioLink Notifications` — operator can adjust the wording, but keep "EthioLink" as the brand anchor.
4. **Username** (the `@<username>` handle, must end in `bot`): **`EthioLinkBot`** for prod, **`EthioLinkDevBot`** (or similar) for dev / staging. The username goes into the `telegram_bot_username` Terraform variable and into the deep link the mobile app generates (`https://t.me/<botUsername>?start=<code>`). It is publicly visible and not rotatable without provisioning a new bot — pick deliberately.
5. BotFather replies with the bot token, formatted `<digits>:<base64-ish>`. **This is a credential** — treat it like a database password. Do not paste it into chat logs, screenshots, or git history. Move it directly into Secrets Manager (see "Secret shapes" below).
6. *(Optional but recommended)* Send `/setdescription` and `/setabouttext` to customise the bot profile copy users see when they tap into the chat for the first time. Example description: *"Booking notifications from EthioLink — confirmations, reminders, and updates from the businesses you book."*
7. *(Optional)* Send `/setprivacy` → `Disable`. The default privacy mode prevents the bot from reading non-`/`-prefixed messages in group chats; we don't need group-chat support for MVP, so the default is fine. Leave alone unless a future use case demands it.

After this step the operator has:
- A bot username (public, e.g. `EthioLinkBot`).
- A bot token (secret).

Generate a fresh **webhook secret** at the same time — a random 32+ character string the bot will pass back in the `X-Telegram-Bot-Api-Secret-Token` header on every webhook delivery. Anything not crypto-broken is fine; `openssl rand -hex 32` produces a 64-char hex string the rest of this runbook uses as the example.

## Required configuration

Seven env vars drive the Telegram path. The Phase 9 Lambda module surfaces them all as Terraform variables — operators set them at the env-stack level (`infra/terraform/environments/{dev,prod}/main.tf`) and never as inline Lambda env overrides.

| Variable                            | Required | Value (example)                                                                          | Notes                                                                                                                                                                                                       |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications_provider`            | **yes**  | `"telegram"` or `"production"`                                                           | Flips the routing flag. `"mock"` (default) keeps Telegram dormant even when the rest of the config is present. `"telegram"` wires Telegram alone; `"production"` wires both Telegram AND SMS together.       |
| `telegram_bot_username`             | **yes**  | `"EthioLinkBot"`                                                                         | Without the leading `@`. Embedded in the deep link returned by `POST /v1/me/link-telegram/start`. Publicly visible.                                                                                          |
| `telegram_bot_token_secret_arn`     | **yes**  | `"arn:aws:secretsmanager:eu-west-1:123:secret:ethiolink/dev/telegram/bot-token-abc"`     | Secrets Manager ARN holding the bot token. Gates IAM — only the `integrations` + `appointments` + `scheduled` Lambda roles get `secretsmanager:GetSecretValue` scoped to this ARN.                            |
| `telegram_webhook_secret_arn`       | **yes**  | `"arn:aws:secretsmanager:eu-west-1:123:secret:ethiolink/dev/telegram/webhook-secret-xyz"` | Secrets Manager ARN holding the webhook secret. The `integrations` Lambda role gets a scoped read on this ARN. No other role needs it.                                                                       |
| `telegram_provider_name`            | optional | `"TELEGRAM_BOT_PROD"`                                                                    | Written to `notification_logs.provider`. Defaults to `"TELEGRAM_BOT"` — set this for clearer log inspection when running multiple envs against a shared analytics view.                                       |
| `telegram_link_code_ttl_seconds`    | optional | `600`                                                                                    | TTL for issued linking codes. Default 600 s (10 minutes). Long enough for a user to alt-tab into Telegram + tap Start, short enough that abandoned codes don't pile up. Tune per env-stack if needed.        |
| `telegram_timeout_ms`               | optional | `10000`                                                                                  | HTTP timeout for outbound Bot API calls. Default 10 s.                                                                                                                                                       |

When any of the three **yes**-required vars is empty, `config.telegramProvider` resolves to `null` and the dispatcher keeps routing through `SMS` / `MOCK` — the Telegram rollout is strictly opt-in.

## Secrets Manager secret shapes

Two secrets land in Secrets Manager. Each accepts two SecretString shapes; pick whichever the operator prefers.

### Bot token

**Plain string** (simplest — the SecretString IS the token):

```text
123456789:AAH-XX_AbCdEfGhIjKlMnOpQrStUvWxYz0
```

**JSON-wrapped** (useful for recording rotation metadata alongside the value — only `botToken` is consumed):

```json
{
  "botToken": "123456789:AAH-XX_AbCdEfGhIjKlMnOpQrStUvWxYz0",
  "rotatedAt": "2026-05-15T10:00:00Z",
  "rotatedBy": "henok@ethiolink.local"
}
```

### Webhook secret

**Plain string**:

```text
b3e2a1f6d8c4b9a0e7d6c5b4a3928170f6e5d4c3b2a19087746352413029180706
```

**JSON-wrapped** (only `webhookSecret` is consumed):

```json
{
  "webhookSecret": "b3e2a1f6d8c4b9a0e7d6c5b4a3928170f6e5d4c3b2a19087746352413029180706",
  "rotatedAt": "2026-05-15T10:00:00Z"
}
```

### Combined-secret option

A single secret can carry both fields when both ARN env vars point at the same ARN. `loadSecretsThenConfig.parseTelegramSecret` accepts `{ "botToken": "...", "webhookSecret": "..." }` and extracts the right key per call. Easier rotation surface (one resource); the trade-off is the two values become coupled — rotate either and you re-deploy the whole secret.

## Terraform wiring

Add the variables to the env stack (`infra/terraform/environments/dev/main.tf` shown — prod is identical apart from the ARN suffixes):

```hcl
module "lambda" {
  source = "../../modules/lambda"
  # ... existing wiring ...

  notifications_provider           = "telegram"   # or "production" to wire SMS + Telegram

  telegram_bot_username            = "EthioLinkDevBot"
  telegram_bot_token_secret_arn    = aws_secretsmanager_secret.telegram_bot_token.arn
  telegram_webhook_secret_arn      = aws_secretsmanager_secret.telegram_webhook_secret.arn

  # Optional — tunable per env:
  # telegram_provider_name         = "TELEGRAM_BOT_DEV"
  # telegram_link_code_ttl_seconds = 600
  # telegram_timeout_ms            = 10000
}

resource "aws_secretsmanager_secret" "telegram_bot_token" {
  name = "ethiolink/dev/telegram/bot-token"
  description = "Telegram bot token from BotFather. Rotated by re-running /token in @BotFather and put-secret-value."
}

resource "aws_secretsmanager_secret" "telegram_webhook_secret" {
  name = "ethiolink/dev/telegram/webhook-secret"
  description = "Webhook secret echoed back in X-Telegram-Bot-Api-Secret-Token. Rotated via openssl rand + setWebhook."
}
```

Populate the SecretString values out-of-band:

```bash
aws secretsmanager put-secret-value \
  --secret-id ethiolink/dev/telegram/bot-token \
  --secret-string "$BOT_TOKEN"

aws secretsmanager put-secret-value \
  --secret-id ethiolink/dev/telegram/webhook-secret \
  --secret-string "$WEBHOOK_SECRET"
```

## Deployment

1. Commit the env-stack change in a PR. CI runs `terraform plan`.
2. Merge.
3. Trigger `deploy-dev.yml` (push-to-main) or `deploy-prod.yml` (tag-push + manual approval).
4. `terraform apply` rolls:
   - The new env vars to every Lambda's environment block (shared env — even Lambdas that don't use Telegram see the variables; they just don't read them).
   - Scoped `secretsmanager:GetSecretValue` IAM grants to the `integrations` + `appointments` + `scheduled` Lambda execution roles for the bot-token secret ARN, and to the `integrations` role for the webhook-secret ARN. Other domain roles are unaffected.
5. Watch the `terraform apply` output for the four new function deltas (`me-link-telegram-{start,status,unlink}` + `integrations-telegram-webhook`) plus the env updates on the appointments + scheduled Lambdas.

## `setWebhook` registration

Telegram does not push updates to the bot until the operator registers a webhook URL. One-time per env (and again after a webhook-secret rotation):

```bash
API_GW_HOST=$(cd infra/terraform/environments/dev && terraform output -raw api_gateway_invoke_url)

curl -F "url=${API_GW_HOST}/v1/integrations/telegram/webhook" \
     -F "secret_token=${WEBHOOK_SECRET}" \
     -F "allowed_updates=[\"message\"]" \
     "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook"
```

Expected response:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

The `allowed_updates=["message"]` filter tells Telegram to only deliver `message` updates (chat joins, edited messages, etc. are ignored) — slightly tighter blast radius than the default and matches what the webhook handler actually reads.

Verify the registration at any time:

```bash
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```

The response includes `url`, `last_error_date`, `last_error_message`, `pending_update_count`. A healthy bot shows `pending_update_count: 0` and no `last_error_message`.

## Smoke tests

### Mobile link smoke

1. Install the latest TestFlight / Play Store internal-track build on a real device.
2. Sign in (any role — CUSTOMER, BUSINESS_OWNER, or ADMIN can link).
3. Tap **Profile** in the bottom nav.
4. Scroll to the **Notifications** section, tap **Telegram**.
5. Confirm the screen shows the not-linked branch with a **Link Telegram** CTA. (If it shows "Telegram is not yet enabled", the env stack hasn't been applied or the `notifications_provider` flag is still `"mock"`. If it shows an error, see Troubleshooting → "webhook 401" or "missing IAM secret permission".)
6. Tap **Link Telegram**.
7. The OS routes to Telegram — the bot conversation opens with a `/start <code>` prefilled. Tap **Start**.
8. The bot replies "✅ Linked! You will receive booking notifications here." within 1–2 seconds.
9. Alt-tab back to the app. The screen flips to the linked branch within 3–6 seconds (the polling interval).
10. Verify `users.telegram_chat_id` is populated for the test user (psql or admin SPA).

If step 9 doesn't flip within 90 seconds, the screen falls through to the "Didn't see the confirmation" branch — tap **Check now** to force a status fetch. If still not-linked, see Troubleshooting → "user stuck in polling".

### End-to-end booking smoke

1. From the same linked user, book a real appointment via the mobile booking flow.
2. Switch to the linked Telegram account. A booking-confirmation message should arrive within seconds.
3. Verify in `notification_logs` (admin SPA or psql):

   ```sql
   SELECT id, recipient_user_id, channel, provider, status, provider_ref, created_at
     FROM notification_logs
    WHERE recipient_user_id = '<test-user-id>'
    ORDER BY created_at DESC
    LIMIT 5;
   ```

   Expected: the most recent row has `channel = 'TELEGRAM'`, `provider = 'TELEGRAM_BOT'` (or the override name set in `telegram_provider_name`), `status = 'SENT'`, and a numeric `provider_ref` matching the Telegram `message_id`.
4. *(Owner-side bonus)* From another phone, book an appointment at a business whose owner has linked Telegram. The owner-side `booking.created.business` template should land on the owner's Telegram instead of SMS.
5. *(Reminder smoke)* Wait until the EventBridge reminder schedule fires (24 h + 1 h before the appointment), or manually invoke the `scheduled-send-reminders` Lambda. Verify the reminder lands in Telegram, with `channel = 'TELEGRAM'` and the templated reminder body.

## Rollback

The rollback surface is the same env-stack variable that enabled the path. **Telegram does not require a deploy revert**:

| Scenario                                                                                     | Action                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram is causing user complaints; need to disable globally without losing config.         | Set `notifications_provider = "sms"` (or `"mock"`). `terraform apply`. The factory stops wiring `TELEGRAM`; `pickNotificationChannel` short-circuits Telegram even for users who linked. Routing falls through to SMS / MOCK per priority. Existing `users.telegram_chat_id` rows are preserved — re-enabling restores routing instantly. |
| Bot is compromised; need to invalidate the token while keeping the env config intact.        | In BotFather → `/revoke` → `<bot>` → confirm. Then `aws secretsmanager put-secret-value` with the new token. Roll the affected Lambdas (`aws lambda update-function-configuration --function-name … --description "rotate $(date)"` is enough to force a cold start). Old token is dead within seconds.                              |
| Need to fully un-wire Telegram in an env.                                                    | Set `telegram_bot_username`, `telegram_bot_token_secret_arn`, `telegram_webhook_secret_arn` all to `""` in the env stack. `terraform apply`. `config.telegramProvider` resolves to `null`; the four Telegram Lambda handlers start returning 503; the IAM grants are revoked; `setWebhook` becomes a no-op (Telegram retries but our webhook 401s). Existing chat ids stay in the DB. |

## Troubleshooting

### Webhook returns 401 to Telegram

Symptoms: `getWebhookInfo` shows `last_error_message: "Wrong response from the webhook: 401 Unauthorized"` and `pending_update_count` grows.

Causes + fixes:

- **Webhook secret mismatch.** The most common cause. The secret in Telegram (passed via `setWebhook --secret_token=...`) does not match the value in Secrets Manager. Re-run `setWebhook` with the current secret value.
- **Secret rotation in progress.** The new secret was put in Secrets Manager but `setWebhook` hasn't been re-run yet. Re-register.
- **Wrong env.** The dev `setWebhook` was run against the prod bot, or vice versa. `getMe` against the bot token tells you which bot you're talking to — confirm before re-registering.

### Bot token reports invalid

Symptoms: `getWebhookInfo` or `getMe` returns `{"ok":false,"error_code":401,"description":"Unauthorized"}`.

Causes + fixes:

- BotFather revoked the token (someone else ran `/revoke` against the bot, or the operator forgot they did). Pull a fresh token via `/token` + `<bot>` and `put-secret-value` it.
- The Secrets Manager value is the JSON-wrapped shape but missing the `botToken` field. Cold-start fails with `SecretResolutionError`. Inspect with `aws secretsmanager get-secret-value` and fix the JSON shape (or set it to the plain string).

### "Bad Request: chat not found"

Symptoms: `notification_logs` rows with `status = 'FAILED'`, `provider = 'TELEGRAM_BOT'`, and `error_message` containing `chat not found`. The gateway's `errorCode` classifier maps these to `TELEGRAM_CHAT_NOT_FOUND`.

Causes + fixes:

- The user deleted the bot conversation entirely (not just blocked it). Their `users.telegram_chat_id` is stale.
- The user was migrated between Telegram accounts (rare but possible during account recovery).

Mitigation: today the code path persists `FAILED` and the next dispatch picks up the same dead chat id. The follow-up commit in "Future work" auto-clears `telegram_chat_id` on the first 403/chat-not-found response so the next event falls back to SMS / MOCK automatically. Until that lands, the operator can manually clear the row:

```sql
UPDATE users
   SET telegram_chat_id = NULL
 WHERE id = '<user-id>'
   AND telegram_chat_id IS NOT NULL;
```

### "Forbidden: bot was blocked by the user"

Symptoms: `notification_logs` rows with `errorCode = 'TELEGRAM_FORBIDDEN'`, `error_message` containing `bot was blocked`.

The user explicitly blocked the bot in Telegram (long-pressed the chat → Delete and block). Same handling as `chat not found` — clear the row manually or wait for the auto-cleanup commit. Notify the user via SMS that Telegram is dropping their notifications and offer a re-link.

### "Too Many Requests: retry after N" (429)

Symptoms: `errorCode = 'TELEGRAM_RATE_LIMITED'` in `notification_logs`. Sustained 429s indicate the bot is hitting Telegram's per-bot rate limit (~30 messages/sec; lower for group chats).

At MVP volume this should not happen. If it does:

- Confirm the volume via `SELECT count(*) FROM notification_logs WHERE channel = 'TELEGRAM' AND created_at > now() - interval '1 minute';`
- If the volume is real (mass-cancellation event, marketing send accidentally routed through the booking templates), throttle at the application layer or temporarily flip `notifications_provider` to `"sms"` to spread load.
- If the volume looks unreasonable but the table confirms it, suspect a runaway scheduled reminder loop — pause EventBridge.

The dispatcher does not retry today. A future job (see Future work) can re-process `FAILED` rows with `errorCode = 'TELEGRAM_RATE_LIMITED'` after the documented `retry after` window.

### User stuck in polling on the mobile screen

Symptoms: User tapped **Link Telegram**, the bot opened, they tapped Start, but the app never flipped to linked. After 90 seconds the screen shows "Didn't see the confirmation".

Causes + fixes:

- **Webhook 401** (above). The webhook is rejecting Telegram's `/start <code>` delivery, so the redemption never lands. Fix the webhook secret and ask the user to retry.
- **Bot replied but DB write failed** — `last_error_message` on `getWebhookInfo` empty, but `users.telegram_chat_id` is still NULL. Inspect the `integrations-telegram-webhook` Lambda's CloudWatch logs — look for `telegram.webhook.failed` entries.
- **Race**: user tapped Start before the deep link fully landed. The bot's `/start` carries an empty payload; the webhook ignores it. Ask the user to tap **Restart linking** in the app and try again.

### Missing IAM secret permission

Symptoms: Webhook Lambda or appointment Lambda errors with `AccessDeniedException: User: arn:aws:sts::...:assumed-role/ethiolink-…-lambda-exec-integrations/... is not authorized to perform: secretsmanager:GetSecretValue` on cold start.

Cause: The env-stack apply set `notifications_provider = "telegram"` but forgot to populate `telegram_bot_token_secret_arn` and/or `telegram_webhook_secret_arn`. The Lambda module's IAM grants are `count = 0` when the ARN var is empty, so the role has no permission to read the secret.

Fix: set the ARN tfvar, re-apply. The IAM grant attaches automatically on the next plan.

## Rotation

### Bot token rotation

Trigger: scheduled (quarterly recommended) or on suspicion of compromise.

1. In Telegram → `@BotFather` → `/token` → `<your bot>` → confirm regeneration. BotFather displays the new token. The old token is dead instantly.
2. `aws secretsmanager put-secret-value --secret-id ethiolink/${env}/telegram/bot-token --secret-string "<new-token>"`.
3. Force the warm-cached Lambdas to cold-start so they re-resolve the secret:
   ```bash
   for fn in ethiolink-${env}-integrations-telegram-webhook \
             ethiolink-${env}-appointments-create \
             ethiolink-${env}-scheduled-send-reminders \
             # ... or all of them: aws lambda list-functions --query 'Functions[?starts_with(FunctionName, `ethiolink-${env}-`)].FunctionName' --output text
     ; do
     aws lambda update-function-configuration --function-name "$fn" \
       --description "rotate-telegram-token $(date -u +%Y-%m-%dT%H:%M:%SZ)"
   done
   ```
   (Touching `description` is enough to invalidate the warm container.)
4. Confirm: `curl -s "https://api.telegram.org/bot${NEW_TOKEN}/getMe"` returns the bot identity; a stale Lambda would 401.
5. The webhook URL does NOT need re-registration — `setWebhook` is bound to the bot, not the token.

### Webhook secret rotation

Trigger: scheduled (semi-annually recommended) or on suspicion of leak.

1. Generate the new value: `openssl rand -hex 32`.
2. `aws secretsmanager put-secret-value --secret-id ethiolink/${env}/telegram/webhook-secret --secret-string "<new-secret>"`.
3. Cold-start the `integrations-telegram-webhook` Lambda (touch `description`).
4. **Re-run `setWebhook` with the new secret** — otherwise Telegram keeps sending the old header value and the Lambda starts 401-ing every update. Same `curl` as the initial registration, with the new `secret_token=`.
5. Verify via `getWebhookInfo`: `pending_update_count` should not be growing.

## Future work

Items recorded for visibility. None blocks the launch — Telegram is fully usable today with the listed troubleshooting steps as the manual fallback.

- **Auto-clear `telegram_chat_id` on `TELEGRAM_FORBIDDEN` / `TELEGRAM_CHAT_NOT_FOUND`.** Today the dispatcher persists `FAILED` and the next event hits the same dead chat id. The cleanest fix is a thin layer over `NotificationService.dispatch` that, on those two specific error codes, sets the user's `telegram_chat_id = NULL` and re-dispatches the same template via the lower-priority channel. Small commit; the predicates already exist.
- **Delivery receipts.** Telegram's Bot API does not surface delivery / read receipts in the way SMS DLR callbacks do — there's no equivalent of `notification_logs.status = 'DELIVERED'` populated from Telegram. The `DELIVERED` enum value in the schema is documented as reserved for a future read-receipt flow; for now Telegram-sent rows stay at `SENT`. If Telegram introduces a delivery webhook in a future Bot API revision, the inbound handler is the integration point.
- **Per-user notification preferences.** Today the priority order is fixed at `TELEGRAM > SMS > MOCK`. A future `user_notification_preferences` table could let users say "send reminders via SMS even when Telegram is linked" or "Telegram for everything except payment receipts". The dispatcher's `pickNotificationChannel` is the right hook — the per-user lookup is a single `findById` already on the hot path.
- **Retry job for transient failures.** A nightly Lambda that scans `notification_logs WHERE status = 'FAILED' AND errorCode = 'TELEGRAM_RATE_LIMITED' AND created_at > now() - interval '24 hours'` and re-dispatches against the same template would smooth out Telegram-side rate-limit bursts. The dispatcher's idempotency-key support is already there; this just adds the trigger.
- **Bot-side commands beyond `/start`.** `/unlink`, `/help`, `/status` would let users manage their link from within Telegram instead of needing to open the mobile app. Out of MVP scope but pairs nicely with a paid-featuring or marketing track where the bot is also the customer-engagement surface.
- **Group chat / channel support.** Telegram bots can post to channels they're admins of — useful for business owners running a customer-broadcast channel. Out of MVP scope; the gateway and dispatcher are channel-agnostic enough that the migration is contained when it arrives.
