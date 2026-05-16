# EthioLink — Payments Provider Runbook

This is the playbook the operator follows to switch the EthioLink stack from the historical `MockOnlineGateway` placeholder to the real Chapa hosted-checkout integration, validate the end-to-end loop (mobile booking + featuring → Chapa → webhook → admin reconciliation), and respond to provider-side issues afterwards. The runbook assumes Phase 10 commits `eed6885` (adapter), `d9f22cd` (factory routing), `476881a` (webhook handler), `56d8db5` (intent persistence), `3cadb91` (mobile online checkout), and `cad159e` (admin reconciliation) are merged on `main` — every code-side seam the Chapa path needs is already in place.

Architecture posture: paid online payments are **opt-in per env** (the env stack flips a flag) and **server-priced** (the gateway authorises against an amount the server picked, not anything the client sent). The MVP customer-facing flow uses Chapa's hosted checkout — EthioLink never sees card / PAN / CVV data; the customer enters credentials on `checkout.chapa.co` and we receive a signed webhook with the canonical outcome. A direct Telebirr integration sits behind the same `PaymentGateway` port as a deferred follow-up; flipping providers is a Terraform variable change with no schema or wire-shape impact.

## Chapa provider onboarding

Chapa accounts are created through the Chapa merchant dashboard (https://dashboard.chapa.co). There is no API for provisioning; this step is operator-led and one-time per environment.

1. Sign up for a Chapa merchant account. Choose the legal entity that matches the operator's invoicing arrangement. Chapa requires a business registration document upload + bank-account verification before live keys are issued — the sandbox flow runs without these.
2. Note the two key pairs Chapa issues:
   - **Sandbox**: `CHAPUBK_TEST-…` (public) and `CHASECK_TEST-…` (secret).
   - **Live**: `CHAPUBK-…` and `CHASECK-…`. Live keys are gated on the document review; the dashboard surfaces an "Activate live mode" banner when ready.
3. Generate a fresh **webhook signing secret** at the same time. Anything cryptographically random and ≥ 32 chars is fine; `openssl rand -hex 32` produces a 64-char hex string the rest of this runbook uses as the example. Chapa's dashboard has a "Webhook secret" field that accepts arbitrary strings.
4. Decide on the **return URL**. Operators set this to `ethiolink://payments/return` so the mobile app deep-links back to the booking flow after the customer completes (or cancels) payment. The `ethiolink://` scheme is already registered on iOS + Android via the existing Cognito callback wiring — no additional native edits.

After this step the operator has:
- A merchant **secret key** (sandbox `CHASECK_TEST-…`, eventually live `CHASECK-…`).
- A **webhook signing secret** (random ≥ 32-char string).
- A confirmed **return URL** (`ethiolink://payments/return` for both envs).

## Required configuration

Six env vars drive the path. The Phase 10 Lambda module surfaces them all as Terraform variables — operators set them at the env-stack level (`infra/terraform/environments/{dev,prod}/main.tf`) and never as inline Lambda env overrides.

| Variable                            | Required | Value (example)                                                                                | Notes                                                                                                                                                                                                       |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments_provider`                 | **yes**  | `"chapa"`                                                                                       | Routing flag. `"mock"` (default) keeps `MockOnlineGateway` in place — every `ONLINE_PENDING` booking returns `400 ONLINE_PAYMENTS_UNAVAILABLE` and featuring subscribe runs through the in-process `CashGateway`. `"chapa"` wires `ChapaGateway` for the online slot. |
| `chapa_secret_key_secret_arn`       | **yes**  | `"arn:aws:secretsmanager:eu-west-1:123:secret:ethiolink/dev/payments/chapa-secret-key-abc"`     | Secrets Manager ARN holding the Chapa secret key. IAM grant attaches the `secretsmanager:GetSecretValue` permission to the `appointments` + `featuring` + `integrations` Lambda roles only.                  |
| `chapa_webhook_secret_secret_arn`   | **yes**  | `"arn:aws:secretsmanager:eu-west-1:123:secret:ethiolink/dev/payments/chapa-webhook-xyz"`        | Secrets Manager ARN holding the webhook HMAC signing secret. Read only by the `integrations` Lambda role.                                                                                                    |
| `chapa_api_base_url`                | optional | `"https://api.chapa.co"`                                                                        | Defaults to the production endpoint. The sandbox runs on the same host with sandbox-mode keys, so an override is rarely needed. Set if Chapa publishes a regional endpoint in the future.                    |
| `chapa_return_url`                  | **yes**  | `"ethiolink://payments/return"`                                                                  | Mobile deep link Chapa redirects to after the hosted checkout. Must match the scheme registered on iOS + Android exactly.                                                                                    |
| `payments_timeout_ms`               | optional | `12000`                                                                                         | HTTP request timeout for outbound Chapa calls. Default 12 s.                                                                                                                                                 |

When `payments_provider` is `"mock"` (the default), `config.chapaProvider` resolves to `null` and the gateway factory keeps `MockOnlineGateway` wired — no schema or state changes are required to keep paid payments switched off. Setting `payments_provider = "chapa"` without supplying the two secret ARNs causes `createPaymentGateways` to throw `CHAPA_NOT_CONFIGURED` at Lambda cold start, so a misconfig fails loud rather than silently routing through the mock.

## Secrets Manager secret shapes

Two secrets land in Secrets Manager. Each accepts both a plain-string form and a JSON-wrapped form; the operator picks per-secret. The bundled-resource form (one Secrets Manager entry serving both env-var ARNs) is also supported — point the same ARN at both env vars and the resolver picks the right field.

### Chapa secret key

**Plain string** (simplest — the SecretString IS the merchant key):

```text
CHASECK_LIVE-XXXXXXXXXXXXXXXXXXXXXXXXXX
```

**JSON-wrapped** (useful for recording rotation metadata alongside the value — only `secretKey` is consumed):

```json
{
  "secretKey": "CHASECK_LIVE-XXXXXXXXXXXXXXXXXXXXXXXXXX",
  "rotatedAt": "2026-05-16T10:00:00Z",
  "rotatedBy": "henok@ethiolink.local"
}
```

### Webhook signing secret

**Plain string**:

```text
whsec_b3e2a1f6d8c4b9a0e7d6c5b4a3928170f6e5d4c3b2a19087746352413029180706
```

**JSON-wrapped** (only `webhookSecret` is consumed):

```json
{
  "webhookSecret": "whsec_b3e2a1f6d8c4b9a0e7d6c5b4a3928170f6e5d4c3b2a19087746352413029180706"
}
```

### Combined-resource option

If the operator prefers one Secrets Manager entry per env, point both `chapa_secret_key_secret_arn` and `chapa_webhook_secret_secret_arn` at the same ARN and use a JSON object with both fields:

```json
{
  "secretKey": "CHASECK_LIVE-XXXXXXXXXXXXXXXXXXXXXXXXXX",
  "webhookSecret": "whsec_…"
}
```

The resolver extracts `secretKey` from one env-var resolution and `webhookSecret` from the other. The bundled form is slightly cheaper (one Secrets Manager entry → one rotation slot) at the cost of coupling the two rotation cadences.

## Terraform apply steps

The env stack already knows about every variable; the operator's job is to set them and re-apply.

1. **Set the env-stack variables.** Edit `infra/terraform/environments/<env>/main.tf` (or the env-specific `.tfvars` if the stack reads from one):

   ```hcl
   module "lambda" {
     # …existing inputs…

     payments_provider                = "chapa"
     chapa_secret_key_secret_arn      = "arn:aws:secretsmanager:eu-west-1:123:secret:ethiolink/dev/payments/chapa-secret-key-abc"
     chapa_webhook_secret_secret_arn  = "arn:aws:secretsmanager:eu-west-1:123:secret:ethiolink/dev/payments/chapa-webhook-xyz"
     chapa_return_url                 = "ethiolink://payments/return"
   }
   ```

2. **Plan and apply.**

   ```bash
   cd infra/terraform/environments/<env>
   terraform plan -out=payments.tfplan
   terraform apply payments.tfplan
   ```

   Expected changes on a first-time enable:
   - `aws_lambda_function.appointments-*` + `featuring-*` + `integrations-chapa-webhook` env-vars updated (Chapa env vars flip on each).
   - New `aws_iam_role_policy.lambda_chapa_secret_key` rows attached to `appointments` + `featuring` + `integrations` roles.
   - New `aws_iam_role_policy.lambda_chapa_webhook_secret` row attached to the `integrations` role.
   - The `POST /v1/integrations/chapa/webhook` API Gateway route is created (it was conditional on the function being wired in commit 3).

3. **Smoke-check after apply.** Hit the deployed packages endpoint as an authenticated business owner:

   ```bash
   curl -i \
     -H "Authorization: Bearer $OWNER_ID_TOKEN" \
     "https://<api-host>/v1/businesses/<biz-id>/featuring/packages"
   ```

   Expect `200`. A `503` is fine for the unconfigured path; for Chapa the request should return the packages.

## Webhook registration / Chapa dashboard setup

Chapa needs to know where to POST every payment event. Configure two values on the Chapa dashboard's "Webhooks" section:

1. **Webhook URL.** Set to `https://<api-host>/v1/integrations/chapa/webhook` (the public API Gateway endpoint provisioned by commit 3). The endpoint is open-by-design — the HMAC-SHA256 signature on the request body is the binding auth. No Cognito authoriser.
2. **Webhook secret.** Paste the same random string already in Secrets Manager. Chapa signs every payload with this secret; the handler validates via `crypto.timingSafeEqual` and rejects mismatches with `401`. The dashboard "Test webhook" button fires a sample payload — confirm it reaches the Lambda's CloudWatch Logs before considering the wiring complete.

## Dev sandbox smoke

A targeted smoke confirms the full loop works. Use sandbox keys (`CHASECK_TEST-…`) so no real money moves. The script:

### Online appointment

1. From the mobile customer app (signed in as a CUSTOMER), book any service with `paymentMethod = ONLINE_PENDING`.
2. The app opens Chapa hosted checkout in the system browser. Use one of the published test cards (`https://developer.chapa.co/docs/test-cards/`) — `4000 0000 0000 0408` for success, `4000 0000 0000 0002` for declined.
3. After successful payment, Chapa redirects to `ethiolink://payments/return` and the mobile waiting screen polls `GET /v1/me/appointments`. The appointment should appear with status `REQUESTED` (online cash-status doesn't change the appointment row itself in this MVP — see the `markPaymentSucceeded` log-only hook in `AppointmentService`).
4. In the admin SPA, navigate to the business detail page → Payments panel. One row appears with provider `CHAPA`, status `SUCCEEDED`, the matching amount in ETB, and providerRef = the Chapa `tx_ref` (format `apt-<appointmentId>-<8 chars>`).

### Paid featuring purchase

1. From the mobile owner app's Promote screen, tap Purchase on a package.
2. The owner is redirected to Chapa. Use a test card.
3. After return, the screen's overlay polls `getActive` and flips to the "Featured!" success branch.
4. Admin SPA: the featuring panel + the Payments panel both reflect the new state (subscription ACTIVE, payment_intent SUCCEEDED).

### Webhook success

1. CloudWatch Logs for the `integrations-chapa-webhook` function should show one structured `info` log per webhook delivery:
   ```
   chapa.webhook.featuring_activated { subscriptionId: "...", providerRef: "feat-...-aaaa" }
   ```
   or `chapa.webhook.appointment_payment_succeeded` for the booking variant.
2. The reply body is `{ "ok": true, "handled": true, "txRef": "...", "status": "SUCCEEDED" }`.
3. Chapa's dashboard "Webhook deliveries" tab shows a `200` response. Failed deliveries can be re-fired from the same tab — the handler is idempotent so this is safe.

### Admin reconciliation panel

1. Navigate to any APPROVED business → the new "Payments" card sits below the manual-feature card.
2. The table shows every `payment_intents` row attached to the business with columns Purpose / Provider / Status / Amount / Currency / Provider ref / Created.
3. Cross-business view: `curl https://<api-host>/v1/admin/payment-intents?from=<24h-ago>&status=SUCCEEDED` as an admin → expect the same wire shape across all businesses.

## Mobile smoke

Real-device runs on TestFlight (iOS) / Play Store internal-track (Android):

1. **Redirect opens.** Tap "Pay now (Chapa)" → tap Book → the system browser must open and load `checkout.chapa.co`. If it doesn't, see "Mobile launcher refused" in Troubleshooting.
2. **Return deep link.** After completing payment in the browser, the OS should foreground the EthioLink app and surface the waiting screen's "Payment received" success branch. If the OS shows a "No app can handle this URL" toast, the deep-link scheme didn't propagate — confirm the existing Cognito `ethiolink://auth/callback` flow still works first; if THAT broke, the scheme is the issue. If only payments are affected, the Chapa-side return URL is mistyped.
3. **Polling success / failure / timeout.** Drive each case once:
   - Success: standard happy path above.
   - Failure: cancel on Chapa's hosted page → the app's waiting screen transitions to "Payment failed" with the "Pick another slot" CTA.
   - Timeout: kill the network briefly mid-poll → after 90 s the screen surfaces "Still processing" with "Check again" + "Pick another slot" buttons.

## Admin QA

A 5-minute walkthrough against any business that has at least one online booking or featuring purchase:

1. **`BusinessDetailPage` Payments panel.** Confirm the panel renders below the manual-feature card; empty state for businesses without recorded intents; populated state shows newest-first with the colour-coded status badge.
2. **Cross-business admin endpoint.** `curl` `GET /v1/admin/payment-intents?from=<ISO>&provider=CHAPA&status=SUCCEEDED` with an admin id-token. Expect the cross-business listing with the same wire shape as the per-business endpoint. Useful for matching Chapa's payout statements against the recorded intents.

## Rollback

Paid payments are opt-in; rolling back is config-only.

1. **Flip `payments_provider` back to `mock`.** Edit the env stack and re-apply:

   ```hcl
   module "lambda" {
     payments_provider = "mock"
   }
   ```

   Plan + apply. Online appointment attempts immediately return `400 ONLINE_PAYMENTS_UNAVAILABLE` again; featuring subscribe runs through `CashGateway` synchronously. The Chapa webhook endpoint stays live but every delivery returns `503` (the env-gate fires) so Chapa's retry timer eventually gives up.

2. **(Optional) Hide the online option in the mobile UI.** A feature-flag override is the cleanest follow-up if the operator needs to suppress the radio without a backend re-deploy. Today the mobile flow always renders both options and surfaces the server's 400 inline; the experience is fine but cluttered. Implementing this as `config.paymentsEnabled` on the AppConfig is a small future commit.

3. **Rotate Chapa keys.** In Chapa's dashboard, generate a new secret key and/or webhook secret. Update the matching Secrets Manager entry's SecretString in place — no Terraform re-apply needed; warm Lambda containers continue with the cached old value until cold-start picks up the new one. Existing in-flight transactions complete under the old key thanks to Chapa's grace window. The rotation playbook matches the SMS / Telegram patterns.

## Troubleshooting

### `401 UNAUTHENTICATED` from the webhook endpoint

- **Symptom**: Chapa's dashboard shows repeated `401` webhook deliveries.
- **Cause**: signature mismatch. Either the webhook secret in Secrets Manager differs from the one Chapa is signing with, OR Chapa is sending a header name the handler doesn't recognise (we tolerate `Chapa-Signature` + `chapa-signature` + `X-Chapa-Signature` + uppercase variants; if Chapa renames it, the handler needs a Phase 10.5 commit).
- **Fix**: re-paste the webhook secret in both places — Chapa dashboard AND Secrets Manager. Confirm the secret has no trailing whitespace. The `sha256=` prefix some SDKs add is tolerated; bare hex digests also work.

### `503 INTERNAL_ERROR` "Chapa integration is not configured"

- **Symptom**: every webhook delivery returns `503` with the message above.
- **Cause**: env-gating fired. `chapaProvider` resolved to `null` because at least one of `CHAPA_SECRET_KEY` / `CHAPA_WEBHOOK_SECRET` / `CHAPA_RETURN_URL` is missing from the Lambda env. Most common: the Secrets Manager ARN is set but the secret itself is empty / unreadable.
- **Fix**: `aws lambda get-function-configuration --function-name <env>-integrations-chapa-webhook --query 'Environment.Variables.{a:CHAPA_SECRET_KEY_SECRET_ARN,b:CHAPA_RETURN_URL}'` to confirm both env vars are set. Then `aws secretsmanager get-secret-value --secret-id <arn>` to confirm the secret resolves and has the expected shape (plain string OR JSON with the right field).

### `unknown_tx_ref` in webhook logs

- **Symptom**: webhook returns `200` with `{ handled: false, reason: "unknown_tx_ref" }`. Logs show `chapa.webhook.unknown_tx_ref { txRef: "..." }`.
- **Cause**: the webhook authenticated correctly, the verify call succeeded, but no `payment_intents` row exists with that `tx_ref`. Either (a) the service-side INSERT failed (check `appointments-create` / `featuring-subscribe` logs for `payment_intent_persist_failed`), OR (b) the row was sweep-GCed before the webhook arrived (rare — the sweep TTL is 10 min, well outside Chapa's normal webhook latency).
- **Fix**: query `payment_intents` directly for the `tx_ref` to confirm. If no row exists, the persist step erred — investigate the service-layer logs. If the row exists with status PENDING, the webhook handler has a bug; escalate.

### Chapa returns `5xx` from `/v1/transaction/verify`

- **Symptom**: webhook returns `500`. Logs show `chapa.webhook.verify_unavailable { txRef, error }`.
- **Cause**: Chapa is unreachable (transport-level) or returning 5xx (upstream error). The handler intentionally returns `500` so Chapa retries with its exponential backoff. Retries continue for up to 24 hours.
- **Fix**: nothing on our side. The handler's own retry surface is Chapa-driven. If the issue persists past Chapa's 24h retry budget, manually re-invoke the webhook from the Chapa dashboard once their side recovers.

### Mobile launcher refused (`url_launcher.launchUrl` returns false)

- **Symptom**: tapping Book / Purchase shows the waiting screen briefly, then flips to "Payment failed" with copy "Could not open the Chapa checkout."
- **Cause**: no browser registered to handle `https://` URLs on the device, OR the OS refused the URL for security reasons (rare on iOS; possible on Android in lockdown profiles).
- **Fix**: confirm the device has at least one browser installed. The fallback is to switch to cash payment — the existing "Pick another slot" CTA on the failed branch supports this.

### PENDING `payment_intents` row stuck

- **Symptom**: the row stays in PENDING for > 10 minutes even though the customer claims they completed payment.
- **Cause**: the webhook didn't arrive (Chapa's delivery problem) OR the verify call reported PENDING on every poll (Chapa's internal state hasn't settled — extremely rare).
- **Fix**:
  1. Check Chapa dashboard's "Webhook deliveries" for any failed attempts. If retries are pending, wait for them.
  2. If no delivery attempts are recorded, fire one manually from the Chapa dashboard's "Resend webhook" button against the relevant `tx_ref`.
  3. If the customer has confirmation from Chapa but our state hasn't flipped within 30 minutes, manually update the row via SQL: `UPDATE payment_intents SET status = 'SUCCEEDED' WHERE provider_ref = '<tx_ref>'` and (for featuring) flip the subscription to ACTIVE via the admin SPA's comp flow. Note this as a one-off in the operator log.

## Security / PCI note

EthioLink never touches cardholder data. The Chapa integration is the canonical "merchant who never sees the PAN" posture, equivalent to **PCI DSS SAQ-A** scope:

- The mobile app opens Chapa's hosted checkout in an external browser. The customer enters card / mobile-money credentials on `checkout.chapa.co`, never on EthioLink-controlled UI.
- The webhook payload from Chapa carries the transaction reference (`tx_ref`) + status — not the PAN, CVV, or expiry. The verify-response payload carries the same minimal fields.
- `payment_intents` records `provider`, `amountEtb`, `status`, `providerRef`, and the verify-response payload in `rawResponse`. The Chapa verify-response payload itself does NOT include the PAN (we've verified with their docs and against real test transactions); even if Chapa changed its API to include it, the column is admin-only and not surfaced in the mobile or owner-side UIs.
- Refunds, when implemented, will be a server-to-server admin action keyed off `provider_ref`. No card data involved.

The security review record at `docs/operations/SECURITY_REVIEW.md` documents the PCI scope; no Phase 10 commit changed the auth / authorisation matrix or the data classification of any existing column.
