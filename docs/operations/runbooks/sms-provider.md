# EthioLink — SMS Provider Runbook

This is the playbook the operator follows to switch the notification dispatcher from `MockNotificationGateway` to a real SMS provider, validate the end-to-end path, and respond to provider-side issues afterwards. The runbook assumes Phase 9 commits `1a1fb95`, `4f22573`, `7931a85`, and `9e4c9a1` are merged on `main` — every code-side seam the SMS path needs is already in place.

The architecture is provider-agnostic: `GenericSmsGateway` accepts any Ethiopian REST provider whose API matches the `{ to, from, message }` body shape with a `Bearer <apiKey>` auth header. Switching providers post-go-live is an env-var change plus optionally a small `GenericSmsGateway` subclass — no schema migration, no Lambda code change.

## Provider selection

The Phase 9 task doc recommends **AfroMessage** as the starting point: documented REST API, Telco-direct routing, sender-id registration, JSON request/response shape that matches `GenericSmsGateway` 1:1. The codebase doesn't bind to a specific vendor — any of the following work without code changes if their API matches the generic shape:

- AfroMessage — `https://api.afromessage.com`
- Geez SMS / similar Ethiopian gateway resellers — varies by vendor
- Twilio (international fallback only — pricing prohibitive for in-country Ethiopian traffic at MVP scale)

The decision is the operator's. The remainder of this runbook uses `${VENDOR}` and `${VENDOR_BASE_URL}` placeholders so the document doesn't bind to a specific choice. Capture both before starting Step 1.

## Required configuration

Five env vars drive the SMS path. The Phase 7 Lambda module surfaces them all as Terraform variables — operators set them at the env-stack level (`infra/terraform/environments/{dev,prod}/main.tf`) and never as inline Lambda env overrides.

| Variable                          | Required | Value (example)                                                             | Notes                                                                                                                |
| --------------------------------- | -------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `notifications_provider`          | **yes**  | `"sms"`                                                                     | Flips the routing flag. `"mock"` (default) keeps the wired-but-dormant `GenericSmsGateway` out of the dispatcher. `"production"` is a synonym reserved for future multi-provider wiring. |
| `sms_provider_api_base_url`       | **yes**  | `"https://api.afromessage.com"`                                             | Vendor REST base URL. No trailing slash required; the gateway normalizes.                                            |
| `sms_provider_sender_id`          | **yes**  | `"EthioLink"`                                                               | Sender display name registered with the vendor.                                                                      |
| `sms_provider_api_key_secret_arn` | **yes**  | `"arn:aws:secretsmanager:eu-west-1:123:secret:ethiolink/dev/sms-provider/api-key-abc"` | Secrets Manager ARN holding the API key. Also gates IAM — only the `appointments` + `scheduled` Lambda roles get `secretsmanager:GetSecretValue` on this ARN. |
| `sms_provider_name`               | optional | `"AFRO_MESSAGE"`                                                            | Written to `notification_logs.provider`. Defaults to `"GENERIC_SMS"` — set this for clearer log inspection.          |
| `sms_provider_timeout_ms`         | optional | `10000`                                                                     | HTTP request timeout. Default 10 s.                                                                                  |

When any of the three **yes**-required vars is empty, `config.smsProvider` resolves to `null` and the dispatcher keeps routing through `MOCK` — the SMS rollout is strictly opt-in.

## Secrets Manager secret shape

The gateway accepts two SecretString shapes; pick whichever the operator prefers:

**Plain string** (simplest — the SecretString IS the API key):

```text
sk_live_abc123def456...
```

**JSON-wrapped** (useful when the operator wants to record vendor-side metadata alongside the key without breaking the resolver — only `apiKey` is consumed):

```json
{
  "apiKey": "sk_live_abc123def456...",
  "vendorAccountId": "ETHIO-12345",
  "rotatedAt": "2026-05-15T10:00:00Z"
}
```

The cold-start resolver (`loadSecretsThenConfig.parseSmsApiKey`) detects the JSON shape by leading `{`. Anything else (empty SecretString, JSON missing `apiKey`, malformed JSON-looking blob) fails the cold start loudly with `SecretResolutionError`.

To create the secret:

```bash
aws secretsmanager create-secret \
    --name "ethiolink/dev/sms-provider/api-key" \
    --description "${VENDOR} REST API key for EthioLink dev SMS notifications" \
    --secret-string "$(read -s -p 'API key: ' KEY && echo "$KEY")" \
    --tags Key=Project,Value=ethiolink Key=Env,Value=dev Key=Component,Value=notifications
```

Capture the returned `ARN` — the env-stack wiring step uses it. Rotation is a manual `put-secret-value` against the same name (the ARN is stable across rotations).

## Terraform wiring

### Dev environment (`infra/terraform/environments/dev/main.tf`)

Extend the existing `module "lambda"` block:

```hcl
module "lambda" {
  source = "../../modules/lambda"

  # ...existing inputs unchanged...

  # Phase 9 — wire the real SMS provider.
  notifications_provider          = "sms"
  sms_provider_api_base_url       = "${VENDOR_BASE_URL}"
  sms_provider_sender_id          = "EthioLink"
  sms_provider_api_key_secret_arn = "arn:aws:secretsmanager:eu-west-1:<acct>:secret:ethiolink/dev/sms-provider/api-key-<suffix>"
  sms_provider_name               = "${VENDOR}"
}
```

### Prod environment (`infra/terraform/environments/prod/main.tf`)

Same shape against the prod secret ARN. Do **not** copy-paste the dev ARN — each env has its own secret, each provisioned independently. The prod rollout should follow dev by at least a few days of clean operation so any vendor-side hiccups are caught before they hit customers.

## Deployment

```bash
# 1. Pre-build the backend bundle (mandatory before every apply that
#    touches Lambda — Terraform's source_code_hash captures it).
cd backend && npm ci && ./scripts/package.sh && cd ..

# 2. Plan against the env you're rolling out.
cd infra/terraform/environments/dev
terraform init                # idempotent; safe to re-run
terraform plan -out=sms.plan

# 3. Review the plan output. Expected diff:
#    * In-place updates on every aws_lambda_function (env vars).
#    * New aws_iam_role_policy.lambda_sms_provider_secret on the
#      `appointments` and `scheduled` roles ONLY.
#    * No drift on RDS / S3 / Cognito / CloudFront / API Gateway / WAF.

# 4. Apply.
terraform apply sms.plan
```

Wall-clock: ~3 minutes (most of which is Lambda function updates propagating across all 50 functions). Cold-start latency on the next invocation of every function increases by one Secrets Manager round-trip (~200 ms) on the `appointments` + `scheduled` domains where the SMS key resolves. Subsequent warm invocations reuse the module-scope cache.

## End-to-end smoke test

Two flows to validate, in order. Both rely on a Cognito user with a real phone number in their `users` row.

### 1. Trigger a booking-lifecycle SMS

```bash
# Find a CUSTOMER user with users.phone set to a phone you control.
PHONE="+251911000001"
USER_ID=$(aws rds-data execute-statement \
    --resource-arn <rds-cluster-arn> --secret-arn <rds-secret-arn> \
    --database ethiolink \
    --sql "SELECT id FROM users WHERE phone = '${PHONE}' LIMIT 1" \
    --query 'records[0][0].stringValue' --output text)

# Create a booking from the mobile app (or admin SPA's future Create
# booking flow when it ships) against an APPROVED business + active
# service + active staff member at a slot in the next hour. The
# booking-lifecycle dispatcher fires:
#   * booking.requested.business → to the business owner
#
# Both reminders land in `notification_logs` as channel = SMS with
# status = SENT once the gateway returns 2xx.
```

### 2. Trigger a reminder SMS

The scheduled reminder runs every 15 minutes on the EventBridge cron `0/15 * * * ? *`. To fire it manually for testing:

```bash
FN_NAME=$(terraform -chdir=infra/terraform/environments/dev \
    output -raw lambda_scheduled_reminders_function_name)

aws lambda invoke \
    --function-name "${FN_NAME}" \
    --payload '{"version":"0","detail-type":"Scheduled Event","detail":{}}' \
    --cli-binary-format raw-in-base64-out \
    /tmp/reminders.json

cat /tmp/reminders.json
# Expected: {"scanned":N,"sent":2N,"skipped":0,"failed":0}
```

For the manual invoke to actually dispatch a reminder, there must be an `ACCEPTED` appointment in the `[now + 23h45m, now + 24h00m)` window. Pre-seed one in dev before the smoke run (or just wait for the next 15-minute tick after a real booking lands).

### 3. Inspect `notification_logs`

```sql
SELECT
    id,
    channel,
    template_key,
    status,
    provider,
    provider_ref,
    error_message,
    created_at
FROM notification_logs
ORDER BY created_at DESC
LIMIT 10;
```

Expected for each successful SMS dispatch:

| Field           | Expected value                                                |
| --------------- | ------------------------------------------------------------- |
| `channel`       | `'SMS'`                                                       |
| `status`        | `'SENT'` (or `'DELIVERED'` once the optional DLR webhook ships post-MVP) |
| `provider`      | The value of `sms_provider_name` (e.g. `'AFRO_MESSAGE'`) — or `'GENERIC_SMS'` when the var is unset |
| `provider_ref`  | Non-null. Vendor-issued message id (e.g. `msg-abc-123`).      |
| `error_message` | `null`                                                        |

If `status = 'FAILED'`, see Troubleshooting below.

### 4. Confirm receipt on the test phone

The whole point. The SMS should land within seconds — vendors document their own SLA but most Ethiopian REST providers deliver in under 30 seconds for Ethio Telecom subscribers. If the row says `SENT` but no SMS arrived, the vendor accepted the request but the carrier dropped it — check the vendor's delivery dashboard (Dashboards section below).

## Rollback

Two reversible paths. Both are non-destructive: existing `notification_logs` rows are preserved.

### Fast rollback (recommended) — flip `notifications_provider`

In the env stack:

```hcl
module "lambda" {
  # ...
  notifications_provider = "mock"
  # Leave sms_provider_* vars in place so the next attempt is a
  # one-line revert.
}
```

`terraform apply` — every Lambda env updates in place; cold starts re-evaluate `shouldWireSmsGateway(config)` which now returns `false`; the dispatcher's `gateways` map no longer wires the SMS channel; the appointment + reminder selection helpers short-circuit to `'MOCK'`. End-to-end revert in under a minute.

### Full rollback — unset `sms_provider_api_key_secret_arn`

Removes the IAM permission too:

```hcl
module "lambda" {
  # ...
  notifications_provider          = "mock"
  sms_provider_api_key_secret_arn = ""  # also removes the IAM policy
}
```

The `appointments` + `scheduled` Lambda roles lose `secretsmanager:GetSecretValue` on the SMS secret. The secret itself stays in Secrets Manager (rollback is reversible).

**Do not** delete the Secrets Manager secret on rollback — Secrets Manager retains deleted secrets for 7–30 days, but a precautionary rollback shouldn't trigger the deletion clock. If the provider relationship is truly ending (vendor switch), schedule the secret deletion separately after the new provider lands.

## Troubleshooting

Every failure mode in this list maps to a specific `notification_logs.error_message` substring or a CloudWatch log line. The dispatcher catches every provider error class and persists the row — there's always a paper trail.

### Provider 4xx — `errorCode = 'SMS_PROVIDER_REJECTED'`

The vendor accepted the HTTP request but refused to dispatch (invalid phone number, account out of credits, sender id not registered, rate-limited). Common causes:

- **Invalid phone format.** Vendor expects strict E.164 (`+251911...`). Check `users.phone` for the recipient — the column accepts free-form text, so a `0911000001` instead of `+251911000001` lands here. Fix at the data layer; no code change.
- **Account out of credits.** Vendor dashboard shows balance. Refill via the vendor's billing flow.
- **Sender id not registered.** Most Ethiopian providers require the operator to register the `senderId` (e.g. `EthioLink`) with their compliance team. Until registration completes, the vendor either rejects (4xx) or rewrites to a default sender id. Check the vendor's sender-id approval queue.

The booking flow is unaffected. The row carries `status = 'FAILED'`, the dispatcher's swallow path logs a warn, the customer just didn't get their SMS for that one event.

### Provider 5xx — `errorCode = 'SMS_PROVIDER_UNAVAILABLE'`

Vendor's gateway is down. Check the vendor's status page. Typically transient — the dispatcher persists the failure but doesn't retry (no retry layer in MVP). A future retry job (post-MVP) will pick these up.

Sustained 5xx for > 15 minutes warrants:

1. Check the CloudWatch alarm: `${env}-lambda-errors` should be firing.
2. Open the vendor's incident channel (most have a Telegram channel or status email).
3. Consider failing over: flip `notifications_provider` to `mock` temporarily so reminders stop failing visibly; communicate to the team that SMS is paused.
4. Resume once the vendor recovers.

### Timeout / network error — `errorCode = 'SMS_PROVIDER_UNAVAILABLE'`

Same error class as 5xx — the gateway can't tell "vendor returned 503" from "TCP connection refused" from the customer's perspective (both are "vendor unreachable"). The `error_message` carries the underlying error string for triage:

- `"SMS provider unreachable: The operation was aborted."` — `AbortController` timeout (default 10 s; tune via `sms_provider_timeout_ms`).
- `"SMS provider unreachable: fetch failed"` — TCP/TLS-layer failure. Check VPC NAT health, vendor's IP allow-list, and any WAF rule on the vendor's side.
- `"SMS provider unreachable: ENOTFOUND ..."` — DNS resolution failure. Confirm `sms_provider_api_base_url` is correct.

### Missing phone — recipient routed through `MOCK`

The selection helper (`pickNotificationChannel` / `pickReminderChannel`) falls back to `MOCK` when the recipient has `phone = null` or an empty string. This is by design — there's no point trying SMS without a number. Log lines show `channel = 'MOCK'` in `notification_logs`.

Fix: confirm the customer / owner registered with a phone number. If they registered with email only (allowed by Cognito), they will continue to get `MOCK` notifications until they add a phone via `PATCH /v1/me`. This is a UX gap to surface in the future mobile app's profile-settings screen.

### Missing secret permission — cold-start failure

Symptom: every cold start of an `appointments` or `scheduled` Lambda throws `AccessDenied` from Secrets Manager. The Lambda never serves a request.

Cause: the IAM policy `lambda_sms_provider_secret` didn't attach. The most common reason is `sms_provider_api_key_secret_arn` left empty in the env stack while `notifications_provider = "sms"`.

Fix: set the secret ARN in the env stack and re-apply. The IAM policy is gated on the ARN being non-empty (`count = var.sms_provider_api_key_secret_arn != "" ? 1 : 0`), so leaving the ARN blank skips the policy creation entirely.

### Other failure modes

- **`NoGatewayForChannelError` thrown by dispatcher.** Means the routing helper picked `'SMS'` but the dispatcher's `gateways` map has no `SMS` entry. Only happens when `notifications_provider != "mock"` but the SMS gateway construction failed (e.g. the cold-start secret resolution returned an empty string after `parseSmsApiKey` somehow let it through). Check the `SecretResolutionError` log lines in CloudWatch — they're the upstream cause.
- **Dispatcher writes `status = 'SENT'` but vendor dashboard shows nothing.** Vendor accepted and persisted the message but the carrier hasn't picked it up yet. Wait 30 seconds; if still no carrier-side record, check the vendor's "queued vs. submitted vs. delivered" status indicator. This is the case the post-MVP DLR webhook will address.

## Key rotation

The SMS provider's API key should rotate at least every 90 days. The dispatch path uses the AWS module-scope cache (`defaultSmsApiKeyCache`), which means a key rotation is invisible to warm Lambda containers until they cold-start.

Procedure:

```bash
# 1. Generate the new API key in the vendor's dashboard. Capture
#    both the old and the new — keep the old valid for at least
#    one rotation window so the warm-cache transition is safe.

# 2. Store the new key in Secrets Manager. The ARN stays the same;
#    only the SecretString changes.
aws secretsmanager put-secret-value \
    --secret-id "ethiolink/dev/sms-provider/api-key" \
    --secret-string "$(read -s -p 'New API key: ' K && echo "$K")"

# 3. Force Lambda cold starts. Two options:
#    a) Wait — Lambda evicts idle containers after ~15 min of
#       inactivity; the next invocation cold-starts with the new key.
#    b) Force — bump the Lambda module's source_code_hash by
#       re-running `backend/scripts/package.sh` + `terraform apply`,
#       which redeploys every function and forces cold starts.

# 4. Confirm via the next dispatch: notification_logs.providerRef
#    should reflect the new key by appearing in the new vendor
#    dashboard segment if the vendor partitions by key.

# 5. Revoke the old key in the vendor's dashboard once you've
#    confirmed every Lambda has cold-started with the new key.
```

Caveat: AWS Secrets Manager rotation (`aws_secretsmanager_secret_rotation`) is wired today only for the RDS master secret. Wiring it for the SMS API key would require a custom rotation Lambda that calls the vendor's "rotate key" API — most Ethiopian REST providers don't expose this, so manual rotation per the steps above is the operational reality.

## Dashboards and vendor console

Three operator-side surfaces:

1. **CloudWatch `${env}-endpoints` dashboard** — the Browse / Appointments / Admin / Auth-sync widgets do not show notification dispatch directly, but a sustained `appointments` error rate often correlates with the SMS path failing (because of the cold-start IAM dependency). Pin alongside the next two.
2. **CloudWatch `${env}-waf-eventbridge` dashboard** — the EventBridge widget shows `Invocations` + `FailedInvocations` on the reminder rule. A sustained gap between the two is the signal that reminder dispatch is broken (vendor outage, IAM drift, etc.).
3. **Vendor delivery dashboard** — AfroMessage and similar vendors expose per-message status (queued / submitted / delivered / failed). URL varies by vendor; capture the link to the operator-side dashboard alongside the vendor's account credentials in the operations password vault.

A CloudWatch metric filter on `notification_logs.status = 'FAILED'` + a per-route alarm is a useful next-step addition; it's not in the Phase 9 scope.

## Remaining future work

Three follow-ups recorded here for visibility. Each is scheduled into Phase 9.x or a later phase.

- **Delivery receipt (DLR) webhook.** Vendors emit a callback when the carrier confirms delivery (or final failure). Wiring it requires (a) a new public-route `POST /v1/notifications/dlr/{provider}` Lambda, (b) HMAC signature verification against the vendor's shared secret, (c) a `notificationLogRepository.updateStatusByProviderRef` method to flip the `SENT` row to `DELIVERED` or `FAILED_DELIVERY`. Until this lands, `status = 'SENT'` is the terminal state — the row never transitions to `DELIVERED`. Acceptable for MVP; expected for v1.1.
- **Per-user notification preferences.** Today every customer with a phone gets every booking-lifecycle SMS. Some customers may prefer email-only or Telegram-only once those channels land. The shape: a `notification_preferences` table keyed on `(user_id, template_key)` → preferred channel(s), default to "any wired channel matching the user's contact fields". The `pickNotificationChannel` helpers grow a preference lookup before the fallback chain.
- **Telegram channel.** Track 2 in `PHASE_9_POST_MVP.md`. The architecture is identical (gateway port + dispatcher routing + per-user preference). Adding it as a sibling to the SMS path is a 2-3 day commit once the gateway is authored.
