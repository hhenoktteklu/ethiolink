# EthioLink — Paid Featuring Runbook

This is the playbook the operator follows to switch on paid featuring in an env stack, validate the end-to-end loop (owner mobile → backend → admin SPA → sweep Lambda), and respond to issues afterwards. The runbook assumes Phase 9 commits `ea5b8c8` (foundation), `5b3bd31` (endpoints + sweep), `386a32b` (owner mobile UI), and `303100b` (admin SPA panel) are merged on `main` — every code-side seam paid featuring needs is already in place.

Architecture posture: paid featuring is **opt-in per env** (the env stack flips a flag) and **server-priced** (owners pick the package code, the server picks the amount). The MVP payment gateway is the in-process `CashGateway` — the subscription lands as `ACTIVE` immediately on the wire. The real Telebirr / Chapa provider is a deferred follow-up tracked under "Known limitations" below.

## Feature flag and pricing

Three env vars drive the path. The Phase 9 Lambda module surfaces them all as Terraform variables — operators set them at the env-stack level (`infra/terraform/environments/{dev,prod}/main.tf`) and never as inline Lambda env overrides.

| Variable                    | Required | Default | Source / value (example)                                                                                       | Notes                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEATURING_ENABLED`         | **yes**  | `false` | env-stack `featuring_enabled = true`                                                                            | The master flag. When `false`, every owner-facing endpoint short-circuits with `503 FEATURING_DISABLED` and the mobile Promote screen renders the "Not yet available" branch. Admin-side `comp` / `cancel` still work — admins can pre-seed comp subscriptions before opening the flag to owners.                       |
| `FEATURING_7D_PRICE_ETB`    | optional | `500`   | env-stack `featuring_7d_price_etb = 500`                                                                        | Server-priced amount in ETB written to `featuring_subscriptions.price_etb` for new `OWNER_PURCHASE` rows targeting `FEATURING_7D`. Comps land at 0 regardless of this value.                                                                                                                                            |
| `FEATURING_30D_PRICE_ETB`   | optional | `1500`  | env-stack `featuring_30d_price_etb = 1500`                                                                      | Same as above for `FEATURING_30D`.                                                                                                                                                                                                                                                                                     |

When `FEATURING_ENABLED` is `false`, the rest of the stack is dormant — no schema or state changes are required to keep featuring switched off. The migration `0018_featuring_subscriptions.sql` is always applied; the table simply stays empty until owners can purchase or admins comp.

## Deployment and apply steps

The env stack already knows about every variable; the operator's job is to set them and re-apply.

1. **Set the env-stack variables.** Edit `infra/terraform/environments/<env>/main.tf` (or the env-specific `.tfvars` if the stack reads from one):

   ```hcl
   module "lambda" {
     # …existing inputs…

     featuring_enabled         = true
     featuring_7d_price_etb    = 500
     featuring_30d_price_etb   = 1500
   }

   module "eventbridge" {
     # …existing inputs…

     # Phase 9 Track 6 — paid featuring sweep rule.
     featuring_sweep_function_name = module.lambda.featuring_sweep_function_name
     featuring_sweep_function_arn  = module.lambda.featuring_sweep_function_arn
     featuring_sweep_enabled       = true
   }
   ```

   Both blocks are already wired in the dev env. Confirm in `git diff` that `featuring_enabled` flips from `false` (or absent) to `true` and that `featuring_sweep_enabled` is `true`.

2. **Plan and apply.**

   ```bash
   cd infra/terraform/environments/<env>
   terraform plan -out=featuring.tfplan
   terraform apply featuring.tfplan
   ```

   Expected changes for a first-time enable:
   - `aws_lambda_function.featuring_*` and `admin_featuring_*` env-vars are updated (8 functions) — the `FEATURING_ENABLED` env var flips on each.
   - `aws_cloudwatch_event_rule.featuring_sweep` transitions from `DISABLED` to `ENABLED` (or is created fresh).
   - `aws_cloudwatch_event_target.featuring_sweep` + `aws_lambda_permission.allow_eventbridge_featuring_sweep` exist.

   No schema migration is needed; `0018_featuring_subscriptions.sql` is always applied via the standard migration runner.

3. **Smoke-check after apply.** Hit the deployed packages endpoint as an authenticated business owner:

   ```bash
   curl -i \
     -H "Authorization: Bearer $OWNER_ID_TOKEN" \
     "https://<api-host>/v1/businesses/<biz-id>/featuring/packages"
   ```

   Expect `200` with `{ items: [ { code: FEATURING_7D, … }, { code: FEATURING_30D, … } ] }`. A `503` with `FEATURING_DISABLED` in the body means the env var didn't propagate — re-check the Terraform plan.

4. **(Optional) Pre-seed comp subscriptions before opening to owners.** From the admin SPA, navigate to the Business Detail page of one or more APPROVED businesses and use the "Comp featuring" form to give a curated set of partners a 14- or 30-day free window. This is useful when seeding the marketplace's "Featured" sort with launch partners before paid traffic exists.

## Owner mobile QA

Manual loop against a TestFlight / internal-track build of the Flutter app, signed in as a `BUSINESS_OWNER` whose business is in `APPROVED` state.

1. **Promote card visible.** Navigate to the My Business tab → dashboard. Confirm a "Promote" card renders between "Profile" and "Services" with the campaign icon and the subtitle "Feature your business at the top of search.". Tap the card.
2. **Package list.** The Promote screen loads. Confirm:
   - Header reads "Not featured" with the star-outline icon and the subtitle "Pick a package below to promote your business.".
   - Two package cards render: "7 days featured" / "500 ETB" and "30 days featured" / "1500 ETB" (or whatever values `FEATURING_7D_PRICE_ETB` / `FEATURING_30D_PRICE_ETB` are set to in this env).
   - Each card has a "Purchase" `FilledButton`.
3. **Subscribe.** Tap "Purchase" on the 7-day card. Expected:
   - The button shows a spinner; the other Purchase button is disabled.
   - A SnackBar appears: "Featured until <Month DD, YYYY>." (the date is `now() + 7 days` for `FEATURING_7D`).
   - The screen refreshes; the header flips to "Featured" / star icon / "Featured until <date>.".
   - The package cards are hidden — the owner can't double-purchase.
4. **Active status.** Pull-to-refresh the screen. The featured header should remain. Then exit and re-enter the screen — same result, fetched fresh from `GET /v1/businesses/{id}/featuring/active`.
5. **History.** Tap the history icon in the AppBar. The `OwnerFeaturingHistoryScreen` should render a single row: `FEATURING_7D`, the startsAt → endsAt range, the `ACTIVE` status chip, and a `PURCHASED` source chip.
6. **Error branches.** Repeat with the env var `FEATURING_ENABLED=false` (revert the dev env temporarily, or test against a fresh env that has not yet flipped the flag). The Promote screen should render the "Not yet available" branch with the hourglass icon and the "Paid featuring is coming soon." copy.

## Admin QA

Manual loop against the admin SPA at `https://admin.<env>.ethiolink.com`, signed in as an `ADMIN`.

1. **Featuring history panel renders.** Navigate to an APPROVED business via the Businesses listing. Confirm a "Paid featuring history" `Card` renders below the manual "Feature" card. For a business with no subscriptions, the table area shows "No featuring subscriptions for this business yet." and the "Cancel active subscription" form is dimmed / disabled.
2. **Comp featuring.** In the "Comp featuring" fieldset, enter `durationDays = 7` and a non-empty reason (e.g. "Launch partner — Q3 promo"). Click "Create comp". Expected:
   - The button shows "Create comp…" briefly.
   - The history table refreshes with one row: `ACTIVE` status badge (green), `ADMIN_COMP` source, `FEATURING_7D` package, price `0`, startsAt now, endsAt now+7d.
   - The business header's "Featured" chip refreshes to "Until <local datetime>".
   - The "Cancel active subscription" form is no longer dimmed.
3. **Duplicate comp 409.** Try a second comp without cancelling the first. Expected: inline `CONFLICT — Business already has an active featuring subscription` (or similar wording from the API) under the "Create comp" button, surfaced via `MutationStatus`.
4. **Cancel active.** In the "Cancel active subscription" fieldset, enter a reason (e.g. "Comp expired internally"). Click "Cancel subscription". Expected:
   - The history table row flips status to `CANCELLED` (red badge) with the reason populated in the "Cancelled reason" column.
   - The business header's "Featured" chip clears back to "—".
   - The "Cancel active subscription" form dims back to disabled (no ACTIVE row remains).
5. **Manual feature / unfeature remains.** Above the new panel, the original "Feature" / "Update feature window" card still works as before — it writes `featured_until` directly via `POST /v1/admin/businesses/{id}/feature` without creating a subscription row. Useful for cases where a subscription row isn't desired (dev / staging smoke tests, one-off audit experiments). The two paths coexist; the operator picks per-need.
6. **History pagination.** Comp + cancel a handful of subscriptions back-to-back; confirm the table renders them newest-first and the "—" placeholder shows in the `Payment intent` column (the public OpenAPI `FeaturingSubscription` schema doesn't carry the FK today; the column ships for forward-compat).

## Sweep Lambda QA

The `scheduled-featuring-sweep` Lambda runs every 15 minutes off the EventBridge rule `<env>-featuring-sweep`. On each tick it (a) expires ACTIVE rows whose `endsAt < now()`, (b) GCs `PENDING_PAYMENT` rows past the 10-minute TTL, and (c) recomputes each affected business's `business_profiles.featured_until`.

### Manual invoke

A targeted invoke is the fastest way to validate the path end-to-end after a deploy or to drain a backlog before the next scheduled tick:

```bash
aws lambda invoke \
  --function-name <env>-scheduled-featuring-sweep \
  --payload '{}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/sweep.out.json && cat /tmp/sweep.out.json
```

Expected `Payload`:

```json
{
  "expired": 2,
  "pendingPurged": 0,
  "featuredUntilRecomputed": 2
}
```

- `expired` — count of ACTIVE rows whose `endsAt < now()` that were flipped to `EXPIRED`.
- `pendingPurged` — count of `PENDING_PAYMENT` rows older than the 10-minute idempotency TTL that were dropped.
- `featuredUntilRecomputed` — count of business profiles whose `featured_until` was recomputed (typically equals `expired` plus any business that also had a fresh comp / cancel between sweeps).

Re-invoking is idempotent — a second run returns `{ expired: 0, pendingPurged: 0, featuredUntilRecomputed: 0 }` until new data lands.

### EventBridge schedule

```bash
aws events describe-rule --name <env>-featuring-sweep
```

Expected: `State: ENABLED`, `ScheduleExpression: rate(15 minutes)` (or whatever the env stack set `featuring_sweep_schedule_expression` to). The CloudWatch metric `AWS/Events/Invocations` for that rule should show a tick every 15 minutes; the matching Lambda's `Invocations` / `Errors` / `Duration` metrics tell the same story from the consumer side.

If the EventBridge target appears not to fire, confirm the `aws_lambda_permission.allow_eventbridge_featuring_sweep` row exists (`aws lambda get-policy --function-name <env>-scheduled-featuring-sweep`); a missing permission is the most common failure mode after a Lambda function rename or recreate.

## Database verification

Direct Postgres queries against the env's RDS — best run through the read-replica when one exists.

```sql
-- Active subscriptions per business (should be at most one each).
SELECT business_id,
       count(*) FILTER (WHERE status = 'ACTIVE') AS active_count,
       count(*) AS total
FROM   featuring_subscriptions
GROUP  BY business_id
HAVING count(*) FILTER (WHERE status = 'ACTIVE') > 1;
```

Expected: zero rows. The partial unique index `featuring_subscriptions_one_active_per_business` enforces this; any row that shows up here is a data-corruption bug worth escalating.

```sql
-- featured_until projection lines up with the active subscription.
SELECT bp.id,
       bp.name,
       bp.featured_until                 AS profile_featured_until,
       fs.ends_at                        AS active_subscription_ends_at,
       fs.status,
       fs.source
FROM   business_profiles bp
LEFT JOIN featuring_subscriptions fs
       ON fs.business_id = bp.id
      AND fs.status      = 'ACTIVE'
WHERE  bp.featured_until IS NOT NULL
   OR  fs.id IS NOT NULL
ORDER  BY bp.featured_until DESC NULLS LAST;
```

Expected: every business with an ACTIVE subscription has `profile_featured_until = active_subscription_ends_at` (within clock skew). Businesses with a non-null `profile_featured_until` but no ACTIVE subscription are legitimate — they were featured via the manual admin-action path (`POST /admin/businesses/{id}/feature`) which writes `featured_until` directly without a subscription row.

```sql
-- payment_intents linkage (Phase 9 Track 6 widened the FK).
SELECT pi.id,
       pi.appointment_id,
       pi.featuring_subscription_id,
       pi.amount_etb,
       pi.status
FROM   payment_intents pi
JOIN   featuring_subscriptions fs ON fs.id = pi.featuring_subscription_id
ORDER  BY pi.created_at DESC
LIMIT  20;
```

Expected: each recent row has `appointment_id IS NULL` and a non-null `featuring_subscription_id` — the XOR `CHECK` constraint enforces exactly one of the two. `amount_etb` should match the corresponding subscription's `price_etb`. `ADMIN_COMP` subscriptions don't create a `payment_intents` row — the gateway path is bypassed for comps.

## Rollback

Featuring is opt-in; rolling back is config-only.

1. **Disable the feature flag.** In the env stack:

   ```hcl
   module "lambda" {
     featuring_enabled = false
   }
   ```

   Plan + apply. The owner-side endpoints immediately return `503 FEATURING_DISABLED` and the mobile Promote screen flips to the "Not yet available" branch. Admin-side endpoints continue to work — admins can still cancel / comp manually.

2. **Disable the EventBridge rule.** In the env stack:

   ```hcl
   module "eventbridge" {
     featuring_sweep_enabled = false
   }
   ```

   Plan + apply. The rule's `State` flips to `DISABLED`; the sweep Lambda stops running on cadence. Already-ACTIVE rows will not expire automatically until the rule is re-enabled (or an operator manual-invokes the Lambda — see "Sweep Lambda QA" above). Existing data is intact.

3. **Admin-cancel active subscriptions.** If the operator needs every business back to "not featured" before re-enabling at a later date, walk the active list:

   ```sql
   SELECT business_id, id
   FROM   featuring_subscriptions
   WHERE  status = 'ACTIVE'
   ORDER  BY ends_at;
   ```

   For each row, open the admin SPA's Business Detail page and use the "Cancel active subscription" form (or call `POST /v1/admin/businesses/{id}/featuring/cancel` directly). Each cancellation recomputes `featured_until` to `NULL`. Refunds (if any cash already changed hands out-of-band) are an operator-led, off-platform process.

The full rollback path is reversible — toggling `featuring_enabled = true` again restores the owner-facing flow against existing schema and Lambda code.

## Troubleshooting

### `FEATURING_DISABLED` (503)

- **Symptom**: owner mobile Promote screen renders the "Not yet available" branch; backend `/featuring/packages` returns `503` with `{ error: { code: "FEATURING_DISABLED" } }`.
- **Cause**: `FEATURING_ENABLED` env var is `false` on the Lambda. Most common cause: the env-stack Terraform variable `featuring_enabled` was not set (defaults to `false`) or the apply didn't run after editing.
- **Fix**: confirm the variable in the env stack, re-plan, re-apply. Verify with `aws lambda get-function-configuration --function-name <env>-featuring-list-packages --query 'Environment.Variables.FEATURING_ENABLED'`.

### `ALREADY_ACTIVE` (409 `CONFLICT`)

- **Symptom**: owner mobile subscribe surfaces the "Already featured" inline banner; admin SPA comp surfaces `CONFLICT — Business already has an active featuring subscription`.
- **Cause**: another ACTIVE subscription exists for the same business. The partial unique index allows at most one. Common when:
  - The owner already purchased and is on a different device that didn't refresh.
  - An admin pre-seeded a comp and the owner then tried to purchase.
  - A manual-feature run happened (rare — manual feature does NOT block subscription creation, but a stale client may have shown the un-featured state).
- **Fix**: pull-to-refresh the Promote screen to pick up the current ACTIVE row; the screen will then show the "Featured until <date>" header and hide the package cards. For admins, cancel the existing active subscription first if a fresh comp is intended.

### `PAYMENT_REQUIRED` (402)

- **Symptom**: owner mobile subscribe surfaces the "Payment failed" inline banner; backend response carries `{ error: { code: "PAYMENT_REQUIRED" } }`.
- **Cause**: gateway returned `FAILED`. Under the MVP `CashGateway` this is unusual — `CashGateway` always succeeds. The error path mostly exercises against the (currently-unused) `MockOnlineGateway` test seam and the eventual `TelebirrGateway`. If it surfaces under CashGateway, it points to an internal exception in the service layer.
- **Fix**: check the `featuring-subscribe` Lambda's CloudWatch Logs for the exception trace. The transactional rollback runs automatically — re-trying the subscribe is safe; idempotency-key dedupe protects against double-charges in the eventual online path.

### Sweep not clearing `featured_until`

- **Symptom**: a subscription's `endsAt` is in the past but `business_profiles.featured_until` still points to it; the public listing keeps the "Featured" chip.
- **Cause**: the sweep Lambda hasn't fired, or it fired but couldn't complete (DB timeout, KMS permission, etc.).
- **Fix**:
  1. Manual-invoke the sweep Lambda (see "Sweep Lambda QA" above). The response payload tells you how many rows it touched.
  2. If the manual invoke returns `0` for `expired` but the SQL clearly shows a stale row, confirm `now()` inside the Lambda matches expectations — clock skew across regions is rare but possible.
  3. If the manual invoke errors, follow the CloudWatch Logs trace. Permissions issues against `KMSAccessDenied` or `RDSConnectionTimeout` are the two most-common transport-level failures.

### Owner not seeing the Promote card

- **Symptom**: a BUSINESS_OWNER signs in on the mobile app, opens "My Business", and the Promote card is absent.
- **Cause(s)**:
  1. The user is on an older client build that pre-dates commit `386a32b`. The card was added in that commit; older builds render five cards instead of six.
  2. The business isn't in `APPROVED` state. The Promote card is rendered regardless of status (it's part of the dashboard's card list), but on `DRAFT` / `PENDING_REVIEW` / `REJECTED` / `SUSPENDED` the Promote screen itself surfaces a friendlier banner — the card stays.
- **Fix**: confirm the TestFlight / Play Store build is at least Phase 9 Track 6 (commit `386a32b`). Force-quit and reopen the app to clear any stale state.

## Known limitations

- **CashGateway / offline settlement (MVP)**. The MVP payment gateway is `CashGateway`. The owner taps Purchase, the subscription lands as `ACTIVE` immediately, and the cash transaction happens out-of-band between the business and EthioLink staff. There is no card / mobile-money authorization on the wire, no receipt issuance, and no refund path. Comps from the admin SPA bypass the gateway entirely (price 0, source `ADMIN_COMP`).
- **Real Telebirr / Chapa deferred**. The backend payment gateway abstraction is ready (`PaymentGateway` with a discriminated `purpose: 'APPOINTMENT' | 'FEATURING'` input), and `MockOnlineGateway` exists as a test seam. The real integration is tracked under "deferred follow-ups" in `docs/tasks/PHASE_9_PAID_FEATURING_SUMMARY.md`. When it lands, `ONLINE_PAYMENTS_UNAVAILABLE` (503) becomes a real wire condition the mobile client already handles.
- **No receipts / invoices** are issued today. The audit trail lives in `featuring_subscriptions` + `payment_intents` for engineering / finance reconciliation; owners don't see a printable / emailable receipt.
- **No revenue dashboard**. Featuring revenue isn't summarised anywhere in the admin SPA today — operators query Postgres directly. A future dashboard is on the post-MVP backlog.
