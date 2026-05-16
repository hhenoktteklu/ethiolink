# Phase 10 — Completion Summary

End of Phase 10. The platform now has every code-side surface required to capture real revenue against an Ethiopian payment rail: the `MockOnlineGateway` placeholder is retired in favour of `ChapaGateway` (aggregating Telebirr / CBE Birr / Amole / M-Pesa Ethiopia / Visa / Mastercard via Chapa's hosted checkout), the booking + featuring flows persist `payment_intents` rows at gateway-authorize time, the webhook handler verifies + activates idempotently, the mobile app opens Chapa's hosted checkout via `url_launcher` and polls the relevant API surface for the status flip, and the admin SPA renders a reconciliation panel against the recorded intents. Phase 10 is engineering-complete; the remaining work is operator-led (Chapa onboarding, key rotation, dev → prod cutover).

Authoritative scope and per-commit sub-checklists live in [`PHASE_10_REAL_PAYMENTS.md`](./PHASE_10_REAL_PAYMENTS.md). This document is the at-a-glance status read on 2026-05-16.

## Goal recap

Phase 10's entry scope ([scoping conversation](./PHASE_9_PAID_FEATURING_SUMMARY.md) "Next recommended commit"):

> Replace `MockOnlineGateway` with a real Ethiopian mobile-money provider so the `ONLINE_PENDING` booking path and paid featuring can complete actual transactions. The `PaymentGateway` port and the discriminated `purpose: 'APPOINTMENT' | 'FEATURING'` input are already in place from Phase 9 — what's missing is one concrete provider implementation plus the webhook half, the secret + IAM plumbing, the mobile checkout surface, and the operator playbook.

All four pieces shipped. Provider choice: **Chapa** as the first integration because (a) sandbox access is self-serve so the dev → integration → smoke loop closes inside one sprint, (b) one Chapa integration buys access to five underlying Ethiopian payment rails without separate first-party integrations, (c) the wire shape (initialize → redirect → webhook → verify) matches the redirect-then-confirm flow the `PaymentGateway` port was designed for.

## Completed commits

Seven commits, all on `main`. Each is independently reversible — there are no cross-commit build-time dependencies — so a follow-up phase can re-prioritise any single commit without entangling the others.

| # | Hash       | Title                                                       | Files touched (count) |
| - | ---------- | ----------------------------------------------------------- | --------------------: |
| 1 | `eed6885`  | Phase 10: add Chapa payment gateway                         | 17 |
| 2 | `d9f22cd`  | Phase 10: route online payments through gateway factory     | 21 |
| 3 | `476881a`  | Phase 10: add Chapa webhook handler                         | 12 |
| 4 | `56d8db5`  | Phase 10: persist pending payment intents                   |  7 |
| 5 | `3cadb91`  | Phase 10: add mobile online checkout                        | 12 |
| 6 | `cad159e`  | Phase 10: add admin payment reconciliation                  | 14 |
| 7 | `153815f`* | Phase 10: add real payments runbook (this commit)           |  3 |

*(The runbook commit reuses the format of the Phase 9 paid-featuring runbook. The hash above is the hash of THIS commit once it lands.)*

Total: ~3,800 lines added across backend, mobile, admin SPA, Terraform, and docs.

## Completed backend / API

- **Adapter** (`backend/shared/adapters/payments/ChapaGateway.ts`, commit `eed6885`). Full Chapa REST adapter — `authorize` initiates `/v1/transaction/initialize` and returns PENDING + redirect URL; `verify` GETs `/v1/transaction/verify/:tx_ref` and returns SUCCEEDED / FAILED / PENDING. Injectable `ChapaHttpTransport` seam, AbortController-driven timeout, typed `ChapaInvalidRequestError` (4xx) / `ChapaUnavailableError` (5xx / network / timeout / unparseable body) / `ChapaDeclinedError`, deterministic `synthesizeTxRef` for retry-safe upstream dedupe, `formatAmountEtb` with `toFixed(2)` rounding, synthetic per-customer email for users without `users.email`.
- **Port widening** (`backend/shared/adapters/payments/PaymentGateway.ts`, commit `eed6885`). `verify(providerRef)` method added; `PaymentAuthorization` gains optional `redirectUrl: string | null`; `PaymentVerificationUnsupportedError` typed throw for synchronous gateways. `CashGateway` + `MockOnlineGateway` implement `verify` as a typed unsupported throw.
- **Factory** (`backend/shared/factories/paymentGatewayFactory.ts`, commit `eed6885`). `createPaymentGateways(config, options?)` builds the `(cash, online)` pair. Default `payments_provider = "mock"` → `MockOnlineGateway`; `"chapa"` + non-null `chapaProvider` → `ChapaGateway`; `"chapa"` + null config → throws `CHAPA_NOT_CONFIGURED` at cold start. Optional `chapaTransport` test seam.
- **Config + secret resolution** (`backend/shared/config/loadConfig.ts` + `loadSecretsThenConfig.ts`, commit `eed6885`). New `PaymentsProvider` type, `ChapaProviderConfig` interface, `buildChapaProviderConfig` with required-field gate, `parseChapaSecret` accepting plain + JSON shapes, module-scope `defaultChapaSecretCache` mirroring the SMS / Telegram patterns.
- **Service routing** (`AppointmentService` + `FeaturingService` + the 10 appointment Lambdas + featuring/subscribe Lambda, commit `d9f22cd`). Hand-built `new CashGateway()` / `new MockOnlineGateway()` pairs replaced with `createPaymentGateways(config)`. `AppointmentService.create` returns the gateway authorization unchanged (already paired with the appointment from the start); `FeaturingService.subscribe` widens its return type to `{ subscription, authorization }`. Handler wire shapes wrap into `CreateAppointmentResponse` / `SubscribeFeaturingResponse` so the mobile client can read `payment.redirectUrl`.
- **Database** (migration 0019 from commit `d9f22cd`). `payment_intents` gains `payment_intents_provider_ref_uniq` — a UNIQUE partial index on `provider_ref WHERE provider_ref IS NOT NULL`. The webhook handler relies on this for reverse-lookup; the uniqueness also blocks `tx_ref` collisions across providers.
- **Webhook handler** (`backend/lambdas/integrations/chapaWebhook.ts`, commit `476881a`). `POST /v1/integrations/chapa/webhook` — HMAC-SHA256 signature gate with `crypto.timingSafeEqual` (tolerates `sha256=` prefix), defense-in-depth re-fetch via `paymentGateway.verify(tx_ref)` rather than trusting the webhook body, dispatches to `featuringService.activateFromPayment` or `appointmentService.markPaymentSucceeded` / `markPaymentFailed`. Six outcome branches: signature mismatch → 401; service not configured → 503; malformed body / missing tx_ref / unknown tx_ref → 200 with `handled: false`; verify SUCCEEDED → mark intent + dispatch; verify FAILED → mark intent; verify PENDING → 200 (wait for next webhook); `ChapaUnavailable` → 500 (Chapa retries); `ChapaInvalidRequest` → 200 (no retry).
- **Service mutations** (`FeaturingService.activateFromPayment` + `AppointmentService.markPaymentSucceeded` / `markPaymentFailed`, commit `476881a`). Idempotent activation hook for the webhook; for appointments today the marks are log-only (a future commit fleshes them out with the `payment_status` column flip + the booking-requested notification gating).
- **Payment-intents repository** (`backend/shared/domains/payments/paymentIntentsRepository.ts`, commits `476881a` + `cad159e`). `findByProviderRef`, `insertOrFindByProviderRef` (upsert via `ON CONFLICT (provider_ref) DO NOTHING`), `markSucceeded` + `markFailed` with CAS updates that refuse to downgrade SUCCEEDED rows, `listForBusiness(businessId, limit)` (`UNION ALL` across appointment + featuring FK paths), `listAll(filters, limit)` with dynamic WHERE clause for cross-business reconciliation. Postgres + in-memory implementations share the same contract; the in-memory variant gets a `seed(row, businessId?)` test seam.
- **Persist-at-authorize** (commit `56d8db5`). `AppointmentService` + `FeaturingService` deps widened with optional `paymentIntentsRepo`. When the gateway returns PENDING with a non-null `providerRef`, the service inserts a `payment_intents` row keyed by the target id. Cash + synchronous SUCCEEDED outcomes don't write (`providerRef: null` short-circuits). Persist failures bubble up as 500 so Chapa retries the whole flow; missing-repo branch logs `payment_intent_repo_missing` at error level without throwing.
- **Admin reconciliation** (commit `cad159e`). Two new admin Lambdas: `GET /v1/admin/businesses/{id}/payment-intents` (`listForBusiness` filter) + `GET /v1/admin/payment-intents` (cross-business filter with `from` / `to` / `provider` / `status` / `limit`). New `PaymentIntentView` + `PaymentIntentList` schemas with derived `purpose` discriminator (APPOINTMENT vs FEATURING).
- **OpenAPI**. All new endpoints + schemas documented (`CreateAppointmentResponse`, `SubscribeFeaturingResponse`, `PaymentSummary`, `ChapaWebhookPayload`, `ChapaWebhookAck`, `PaymentIntentView`, `PaymentIntentList`). The historical 400 `ONLINE_PAYMENTS_UNAVAILABLE` response is retained as a defensive code for unwired envs.

## Completed mobile

- **Booking models** (commit `3cadb91`). New `PaymentSummary` + `CreateAppointmentResponse` Dart models mirroring the backend wrapper. `PaymentSummary` exposes `redirectUrl` / `providerRef` / `status` / `errorCode` / `errorMessage` with `isPending` / `isSucceeded` / `isFailed` getters.
- **Booking repository** (commit `3cadb91`). `HttpAppointmentsRepository.create` returns `CreateAppointmentResponse` (was `Appointment`); parses the wrapped wire shape.
- **Booking flow screen** (commit `3cadb91`). Confirm step gains a "Cash at the business" / "Pay now (Chapa)" radio toggle. New `_Step.paying` interstitial driven by `_PaymentWaitingStep` covers five phases (opening / polling / succeeded / failed / timedOut). `PaymentRedirector` typedef mirrors the existing `LinkLauncher` pattern from the Telegram screen; test seam injected so widget tests never open a real browser. Polls `GET /v1/me/appointments` every 3 s up to 90 s for the payment-status flip.
- **Owner promote screen** (commit `3cadb91`). New `SubscribeFeaturingResult` + `FeaturingPaymentSummary` models in the owner package. `HttpFeaturingRepository.subscribe` returns the wrapped result. Purchase dispatches on `result.payment.redirectUrl` — PENDING + redirectUrl replaces the body with a full-screen `_PromotePaymentWaitingBody` overlay covering the same five phases; polls `getActive` for the ACTIVE transition. Cash settlement preserves the SnackBar + refresh flow unchanged.
- **Deep link** (commit `3cadb91`, docs in `mobile/README.md`). The existing Cognito-side intent filter + `CFBundleURLSchemes` entries cover the `ethiolink://` scheme — no new native scaffolding required. Operator sets `chapa_return_url = "ethiolink://payments/return"` on the env stack.

## Completed admin SPA

- **API client** (`admin/src/lib/api.ts`, commit `cad159e`). New `PaymentProvider` / `PaymentIntentStatus` / `PaymentIntentPurpose` / `PaymentIntentView` / `PaymentIntentListResponse` types; new `listAdminPaymentIntentsForBusiness` + `listAdminPaymentIntents` helpers.
- **Business detail page** (`admin/src/pages/BusinessDetailPage.tsx`, commit `cad159e`). New `PaymentIntentsPanel` mounted below the manual-feature card on every business detail (visible regardless of status so suspended-business audits work). Renders a TanStack-Query-backed table with columns for purpose / provider / status (colour-coded badge: SUCCEEDED green / PENDING amber / FAILED / CANCELLED red) / amount / currency / provider ref / created-at. Loading / empty / error states wired through the same `ApiError` formatter as the rest of the page.
- **Featuring panel preserved**. The Phase 9 featuring history panel + comp/cancel forms (commit `303100b`) are unchanged. The new Payments panel sits below them.

## Terraform / env vars / Secrets

Five new Terraform variables in `infra/terraform/modules/lambda/variables.tf`:

| Variable                            | Default  | Purpose                                                                                                                          |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `payments_provider`                 | `"mock"` | Routing flag. `"chapa"` opts in.                                                                                                  |
| `chapa_secret_key_secret_arn`       | `""`     | Secrets Manager ARN for the Chapa secret key. Plain or `{ secretKey: "…" }` JSON.                                                  |
| `chapa_webhook_secret_secret_arn`   | `""`     | Secrets Manager ARN for the HMAC webhook-signing secret. Plain or `{ webhookSecret: "…" }` JSON.                                   |
| `chapa_api_base_url`                | `""` → `https://api.chapa.co` | Production endpoint; rarely overridden.                                                                  |
| `chapa_return_url`                  | `""`     | Mobile deep link (`ethiolink://payments/return`).                                                                                  |
| `payments_timeout_ms`               | `12000`  | HTTP timeout for outbound Chapa calls.                                                                                            |

IAM grants (gated on the matching ARN being non-empty):
- `chapa_secret_key_secret_arn` → `secretsmanager:GetSecretValue` granted to **three** Lambda area roles: `appointments` / `featuring` / `integrations`.
- `chapa_webhook_secret_secret_arn` → same, granted only to `integrations`.

Lambda functions added (3): `integrations-chapa-webhook`, `admin-payments-list-for-business`, `admin-payments-list`.

API Gateway routes added (3): `POST /v1/integrations/chapa/webhook` (PUBLIC, HMAC-gated), `GET /v1/admin/businesses/{id}/payment-intents` (COGNITO + admin), `GET /v1/admin/payment-intents` (COGNITO + admin).

Schema additions (migration 0019 from commit `d9f22cd`): partial unique index `payment_intents_provider_ref_uniq` on `provider_ref`.

## Tests added

- `backend/tests/payments/chapaGateway.test.ts` — 18 cases over a recording fake transport: authorize happy / 4xx / 5xx / timeout / missing-checkout-url; verify SUCCESS / FAILED / PENDING / unknown / 4xx / empty ref; factory guards; helper coverage.
- `backend/tests/payments/paymentGatewayFactory.test.ts` — factory selection (mock default / chapa+config / chapa+null → throw), transport seam propagation, cash always wired.
- `backend/tests/payments/paymentGateways.test.ts` (extended) — `verify` → `PaymentVerificationUnsupportedError` cases for both Cash + Mock.
- `backend/tests/payments/paymentIntentsRepository.test.ts` — idempotent CAS contract pinning.
- `backend/tests/payments/paymentIntentsPersistence.test.ts` — 5 service-level cases: PENDING online inserts a single row; cash inserts nothing; duplicate providerRef collapses; missing repo + PENDING logs without throwing; PENDING + null providerRef silent.
- `backend/tests/payments/paymentIntentsAdminReconciliation.test.ts` — 8 cases for `listForBusiness` + `listAll` + view mapping.
- `backend/tests/lambdas/chapaWebhookHandler.test.ts` — 18 cases for the webhook (signature gates, env-gating, body validation, unknown tx_ref, SUCCEEDED / FAILED, NoActive / InvalidActivationState swallowed, replay idempotency, downgrade-refusal).
- `backend/tests/featuring/featuringService.test.ts` (extended) — `activateFromPayment` happy / idempotent / unknown / EXPIRED throws cases.
- `backend/tests/config/loadConfig.test.ts` + `loadSecretsThenConfig.test.ts` (extended) — Phase 10 describe blocks for `paymentsProvider` + `chapaProvider` + Chapa secret resolution.
- `backend/tests/appointments/appointmentView.test.ts` — `toCreateAppointmentResponse` cash / Chapa-PENDING / Chapa-FAILED branches + non-leak of internal fields.
- `backend/tests/featuring/featuringView.test.ts` — same shape for `toSubscribeFeaturingResponse`.
- `mobile/test/features/booking/booking_flow_screen_test.dart` (extended) — 4 new online-path cases (PENDING opens redirect + polls + succeeds; launcher returns false → failed; poll budget exhausted → timed-out; CANCELLED appointment surface → failed); 1 wire-shape parse case.
- `mobile/test/features/booking/appointments_repository_test.dart` (extended) — wrapped `_validResponse`; new Chapa PENDING test.
- `mobile/test/features/owner/owner_promote_screen_test.dart` (extended) — online happy-path + launcher-failure + wire-shape parse.
- `mobile/test/features/owner/featuring_repository_test.dart` (extended) — wrapped response + Chapa PENDING test.

## Remaining operator gates

These are the operator-led steps that gate the dev → staging → prod rollout. Each maps to a section in [`docs/operations/runbooks/payments-provider.md`](../operations/runbooks/payments-provider.md).

1. **Chapa account onboarding.** Sign up for a Chapa merchant account, complete the business-document review, generate sandbox + live key pairs.
2. **Secrets Manager population.** Land the Chapa secret key + webhook signing secret in Secrets Manager under per-env names (`ethiolink/${env}/payments/chapa-secret-key` + `ethiolink/${env}/payments/chapa-webhook`).
3. **Terraform apply.** Flip `payments_provider = "chapa"` in the dev env stack first; supply both ARNs + `chapa_return_url`. Plan + apply. Repeat for prod once dev validates.
4. **Chapa webhook registration.** Paste the deployed API Gateway URL + the webhook signing secret into Chapa's dashboard. Verify with their "Test webhook" button.
5. **Dev sandbox smoke.** Run the [runbook's smoke flow](../operations/runbooks/payments-provider.md#dev-sandbox-smoke) — online appointment + featuring purchase + admin reconciliation panel + cross-business endpoint.
6. **Real-device deep-link verification.** TestFlight / Play Store internal-track build: tap Pay now (Chapa) → browser opens → return deep link surfaces the waiting screen success branch on both iOS and Android.
7. **Polling + timeout + failure smokes.** Drive the three branches of the waiting screen against the sandbox.
8. **Admin reconciliation walkthrough.** Confirm the Payments panel renders + the cross-business curl works.
9. **Production cutover.** Swap dev sandbox keys for live keys in Secrets Manager (in-place SecretString update — no Terraform re-apply needed); confirm one real transaction end-to-end with a low-value test booking before opening to customer traffic.
10. **Webhook delivery monitoring.** Add a CloudWatch alarm on the `integrations-chapa-webhook` function's error rate. Above ~5% failures over a 5-minute window should page on-call.

## Deferred follow-ups

Tracked here so we don't lose them.

- **Refunds.** Today there's zero refund automation. The admin SPA's cancel-active flow for featuring clears `featured_until` but the on-chain cash transfer back to the owner is out-of-band. Implementing real refunds needs (a) a Chapa refund API integration (Chapa supports it), (b) a written refund policy alongside it, (c) an admin SPA "Refund" button on each `payment_intents` row, (d) a CANCELLED / REFUNDED transition path. Estimate: 1 sprint paired with the refund policy decision.
- **Receipts / invoices.** Customers + owners can't currently print or email a receipt after a successful purchase. Audit lives in `payment_intents` for engineering / finance only. A future `GET /v1/me/payment-intents/{id}/receipt` PDF endpoint + an "Email receipt" button on the mobile success screen closes the loop. Pairs naturally with the refund work.
- **Payment analytics dashboard.** The admin SPA's Payments panel is the per-business reconciliation view; there's no aggregated view today. Candidate views: daily / weekly revenue by provider, success-rate trend per provider, payment-method mix per business, top-N businesses by online revenue. Lives on a new admin tab over an admin-only `GET /v1/admin/payments/analytics` summary endpoint.
- **Direct Telebirr gateway.** Chapa fronts Telebirr today via aggregation; a direct first-party Telebirr integration cuts Chapa's aggregator fees out of the loop for Telebirr-specific transactions (still the dominant Ethiopian wallet). The `PaymentGateway` port absorbs it without any port-shape change — the `PaymentProvider` enum already includes `TELEBIRR`. Estimate: 1–2 weeks for gateway implementation + Telebirr partner-portal onboarding (longer than Chapa because Telebirr requires certificate-based auth + a partner onboarding gate).
- **Aut-cancel TTL for PENDING online appointments.** The scoping doc flagged a 15-minute TTL on PENDING-payment appointments via a sweep extension so slots reopen if the customer abandons. Not implemented in MVP — the row stays PENDING indefinitely + the slot stays held. Low risk at current volume; medium risk once customer traffic grows. A small sweep-Lambda extension closes it.
- **Payment-status column on `appointments`.** Today the appointment row itself doesn't reflect the payment status — the mobile waiting screen uses a proxy (any non-CANCELLED status post-redirect is treated as success). The cleaner long-term shape is a `payment_status` column on `appointments` that the webhook's `markPaymentSucceeded` writes. Out of MVP scope but worth doing alongside the auto-cancel TTL.

## Final recommendation

Two paths, same as Phase 9's close:

- **If launch is the priority** — execute the operator-led launch checklist above. Ten items; expected wall-clock of one to two weeks for an unblocked operator with the Chapa merchant relationship in place. Engineering's job in this path is on-call for any surprises the operator surfaces; no new code lands unless a regression appears. The runbook at `docs/operations/runbooks/payments-provider.md` is designed to be standalone — every line is operator-actionable without engineering hand-holding.

- **If code is the priority** — Phase 11 starts cleanest with the **refunds + receipts pair**. They're the largest remaining gap in the customer-facing payment experience, the Chapa side already supports refunds, and the work is purely additive (no schema migration, no wire-breaking changes). Estimate: 2 sprints. After that, the natural successors are payment analytics (admin SPA), the direct Telebirr gateway (post-launch optimisation), and the `payment_status` column on appointments (paired with the auto-cancel sweep).

Both paths converge on the same end-state — a marketplace that captures real Ethiopian payment-rail revenue end-to-end with operator-grade reconciliation tooling. The split is purely about which surface ships next.
