# Phase 10 — Real Payments Roadmap

> Phase 9 closed the platform's engineering surface (see [`PHASE_9_COMPLETION_SUMMARY.md`](./PHASE_9_COMPLETION_SUMMARY.md)). Phase 10 turns "the platform is live" into "the platform captures revenue end-to-end" by retiring the `MockOnlineGateway` placeholder with a real Ethiopian payments provider (Chapa) and threading the redirect-then-confirm flow through every consumer.

The scoping deliverable lived in chat; this doc is the executable checklist + commit ledger.

## Goal

Replace `MockOnlineGateway` with a real Ethiopian mobile-money provider so the `ONLINE_PENDING` booking path and paid featuring can complete actual transactions. The `PaymentGateway` port and the discriminated `purpose: 'APPOINTMENT' | 'FEATURING'` input are already in place from Phase 9 — what's missing is one concrete provider implementation plus the webhook half, the secret + IAM plumbing, the mobile checkout surface, and the operator playbook.

## Provider choice — Chapa first

Recommended first provider: **Chapa** (https://chapa.co). Aggregator: under one Chapa account a merchant accepts Telebirr, CBE Birr, Amole, M-Pesa Ethiopia, Visa, and Mastercard. Sandbox is self-serve so the dev → integration → smoke loop closes inside one sprint. The wire shape (initialize → redirect → webhook → verify) matches the redirect-then-confirm flow the `PaymentGateway` port already expects. A direct first-party Telebirr integration becomes the natural Phase 10.5 follow-up if Chapa's aggregator fees ever justify dual-rail.

## Checklist

### Commit 1 — adapter (landed: `eed6885`)

- [x] `backend/shared/adapters/payments/ChapaGateway.ts` — `authorize` + `verify`, injectable transport, AbortController timeout, typed `ChapaInvalidRequestError` / `ChapaUnavailableError` / `ChapaDeclinedError`.
- [x] Widened `PaymentGateway` port with `verify(providerRef)` + `PaymentVerificationUnsupportedError`. `CashGateway` + `MockOnlineGateway` implement `verify` as a typed throw.
- [x] `PaymentAuthorization` gains optional `redirectUrl: string | null`.
- [x] `loadConfig` resolves `PAYMENTS_PROVIDER` + `CHAPA_*` env vars into `AppConfig.chapaProvider` + `AppConfig.paymentsProvider`.
- [x] `loadSecretsThenConfig` resolves `CHAPA_SECRET_KEY_SECRET_ARN` + `CHAPA_WEBHOOK_SECRET_SECRET_ARN` (plain + JSON shapes; bundled-resource shape via the same parser).
- [x] `paymentGatewayFactory` builds `(cash, online)` pair; routes online to `ChapaGateway` when `payments_provider = chapa`, throws `CHAPA_NOT_CONFIGURED` when chapa is selected but credentials are missing.
- [x] Terraform `lambda` module variables + env-block entries + IAM grants on `appointments` / `featuring` / `integrations` roles (gated on the ARN being non-empty).
- [x] `AWS_DEPLOYMENT.md` § "Payments posture" + `SECURITY_REVIEW.md` PCI scope note.
- [x] Tests: adapter happy path (authorize + verify), failure modes (4xx / 5xx / network / declined / missing config), helper coverage (synthesizeTxRef, formatAmountEtb).

**Behaviour at end of commit 1:** Production unchanged. Default `payments_provider = "mock"` keeps the historical Phase 9 behaviour where `ONLINE_PENDING` returns 400.

### Commit 2 — route online appointments + featuring through factory (landed: this commit)

- [x] Migration `0019_payment_intents_provider_ref_idx.sql` — `UNIQUE` partial index on `payment_intents(provider_ref) WHERE provider_ref IS NOT NULL`.
- [x] Appointment Lambdas (8 — `create`, `accept`, `reject`, `cancel`, `complete`, `reschedule`, `listMine`, `listForBusiness`) switch from `new CashGateway()` + `new MockOnlineGateway()` to `createPaymentGateways(config)`.
- [x] Featuring `subscribe` Lambda switches from a hand-built `CashGateway` to `paymentGatewayFactory.online` (or `cash` when `payments_provider = mock`).
- [x] `AppointmentService.create` already returned `{ appointment, payment }`; the `create` handler now surfaces the payment via the new `CreateAppointmentResponse` wire shape (wraps `AppointmentView` with a `payment: PaymentSummary` block).
- [x] `FeaturingService.subscribe` widened to return `{ subscription, authorization }`; the `subscribe` handler returns the new `SubscribeFeaturingResponse` wire shape.
- [x] OpenAPI `POST /v1/appointments` response → `CreateAppointmentResponse`. OpenAPI `POST /v1/businesses/{id}/featuring/subscribe` response → `SubscribeFeaturingResponse`. Both reference a new shared `PaymentSummary` schema.
- [x] `DATABASE_SCHEMA.md` updated with the new index.
- [x] Tests: view-layer coverage for cash + Chapa-PENDING + Chapa-FAILED branches on both wrappers; service-level `SubscribeResult` shape assertions.

**Behaviour at end of commit 2:** Production unchanged. The wire shape is widened additively — clients ignoring the new `payment` block still see the appointment / subscription. Mobile clients are not updated; they continue to call `POST /v1/appointments` with `paymentMethod = CASH` only. Once `payments_provider = chapa` is flipped in an env, online bookings will return `payment.redirectUrl` but the mobile UI doesn't open it yet — that's commit 4.

### Commit 3 — Chapa webhook handler (landed: this commit)

- [x] `backend/lambdas/integrations/chapaWebhook.ts` — `POST /v1/integrations/chapa/webhook`. Validates HMAC-SHA256 signature against the webhook secret with `crypto.timingSafeEqual`. Tolerates the `sha256=` prefix some Chapa SDKs include. Looks up `payment_intents` by `provider_ref`, re-fetches canonical status via `paymentGateway.verify(tx_ref)` (defense-in-depth — webhook body is only trusted for the tx_ref), branches on SUCCEEDED / FAILED / PENDING.
- [x] New `backend/shared/domains/payments/paymentIntentsRepository.ts` — Postgres + in-memory implementations. `findByProviderRef`, `insertOrFindByProviderRef` (upsert via `ON CONFLICT (provider_ref) DO NOTHING`), `markSucceeded` + `markFailed` with CAS updates that refuse to downgrade SUCCEEDED rows.
- [x] On SUCCEEDED + APPOINTMENT path → `appointmentService.markPaymentSucceeded(appointmentId)` (logs-only today; future commit flips `appointment.payment_status` + fires the booking-requested notification gated on payment success).
- [x] On SUCCEEDED + FEATURING path → new `featuringService.activateFromPayment(subscriptionId)`. Idempotent — already-ACTIVE rows return unchanged; EXPIRED / CANCELLED / REFUNDED rows throw `InvalidActivationStateError` which the handler swallows. Recomputes `featured_until` on activation.
- [x] On FAILED path → `payment_intents.status = 'FAILED'`. For appointments calls `appointmentService.markPaymentFailed`. Featuring subscriptions stay PENDING_PAYMENT for the existing 10-minute sweep to GC.
- [x] On PENDING (Chapa's own state hasn't settled) → 200 + `handled: false`. Chapa retries.
- [x] Idempotency: replayed webhook against an already-SUCCEEDED row is a no-op (CAS update refuses to flip; activate is also idempotent). Test pins both directions including the "late FAILED retry against SUCCEEDED row" downgrade-refusal case.
- [x] OpenAPI route documented: `POST /v1/integrations/chapa/webhook`, public security, `Chapa-Signature` header, `ChapaWebhookPayload` request body, `ChapaWebhookAck` response with `handled` + `reason` + `txRef` + `status` fields.
- [x] Terraform: new `integrations-chapa-webhook` Lambda function in the lambda module + new `v1/integrations/chapa/webhook` path + `POST_v1_integrations_chapa_webhook` route in the API Gateway module (public, application-side auth). The Chapa-secret IAM grants from commit 1 already include the `integrations` role — no new IAM resources needed.
- [x] Tests: 18 cases across `paymentIntentsRepository.test.ts` (idempotent CAS contract) + `chapaWebhookHandler.test.ts` (signature mismatch, missing signature, `sha256=` prefix accepted, 503 when not configured, malformed body, missing tx_ref, nested tx_ref, unknown tx_ref, SUCCEEDED-featuring, SUCCEEDED-appointment, FAILED-appointment, FAILED-featuring-stays-PENDING, NoActive / InvalidActivationState swallowed, verify PENDING, ChapaUnavailable → 500, ChapaInvalidRequest → 200, replay-SUCCEEDED idempotent, FAILED-against-SUCCEEDED downgrade-refused).

### Commit 4 — persist pending payment intents at authorize time (landed: this commit)

- [x] `AppointmentService` deps widened with optional `paymentIntentsRepo: PaymentIntentsRepository`. `create()` calls `insertOrFindByProviderRef` whenever the gateway authorization comes back as `PENDING` with a non-null `providerRef`. Cash + synchronous SUCCEEDED outcomes do NOT write — the schema doc explicitly says cash bookings skip `payment_intents`.
- [x] `FeaturingService` deps widened with optional `paymentIntentsRepo` + `logger`. `subscribe()` mirrors the same insert at the PENDING branch.
- [x] Persist failures bubble up so the handler 500s and Chapa retries — leaving an orphan row would silently break the webhook lookup. The two services log `payment_intent_persist_failed` before re-throwing.
- [x] `payment_intent_repo_missing` is logged loudly (error level) when an online gateway returns PENDING + a providerRef but no repo is wired. The subscription / appointment is already inserted; we don't roll it back, but the operator sees the misconfig in CloudWatch and either wires the repo or rolls back to `payments_provider = mock`.
- [x] Lambda handlers wire `new PgPaymentIntentsRepository(pool)` in `backend/lambdas/appointments/create.ts` + `backend/lambdas/featuring/subscribe.ts`. Other appointment Lambdas (accept / reject / cancel / etc.) do NOT need the repo — they only run the lifecycle state machine.
- [x] Tests pin: PENDING online inserts a single row keyed by the right target id with `status = PENDING` + provider + amount + providerRef; cash gateway inserts nothing; duplicate providerRef under retry collapses to one row; missing repo + PENDING + providerRef logs `payment_intent_repo_missing` without throwing; PENDING + null providerRef neither inserts nor warns.

### Commit 5 — mobile online checkout

- [ ] Booking flow on the Flutter customer app — toggle `paymentMethod` between cash / online; on online confirm, open `data.payment.redirectUrl` via `url_launcher`; transition to `PaymentWaitingScreen` polling `GET /v1/me/appointments/{id}` every 3s up to 90s.
- [ ] Owner featuring screen — same dance on the Promote screen. After return, poll `GET /v1/businesses/{id}/featuring/active`.
- [ ] Deep-link handling for `ethiolink://payments/return` (Android intent filter + iOS `CFBundleURLSchemes`).
- [ ] Mobile tests for the online + waiting screens (loading / success / failure / timeout branches).

### Commit 5 — admin reconciliation surface

- [ ] Admin SPA: per-business `payment_intents` listing under `BusinessDetailPage`.
- [ ] Admin endpoint `GET /v1/admin/payment-intents?from=&to=` for reconciliation export (CSV-shaped JSON).
- [ ] CloudWatch dashboard extension: pending count, success rate per provider, mean authorize→succeed latency.

### Commit 6 — operator runbook

- [ ] `docs/operations/runbooks/payments-provider.md` — provider onboarding, Secrets Manager shapes, Terraform apply, sandbox → live key swap, mobile QA, webhook QA (manual invoke with sample signed payload + curl test), rollback (flip `payments_provider = mock`).

## Open product decisions tracked in scoping

- **Owner notifications on PENDING online bookings.** Decision: gate booking-requested notifications on `payment.status = SUCCEEDED` for online bookings. Cash bookings keep the existing immediate-notification path.
- **Auto-cancel TTL for PENDING online appointments.** Decision: 15-minute TTL via an extension to the existing scheduled sweep. Slot reopens for other customers.
- **Refund policy.** Decision: no automated refunds in Phase 10. The admin SPA's existing manual cancel flow stays the operator escape hatch; refund automation is a Phase 10.5 follow-up paired with a written refund policy.

## Rollout / rollback

Operator-led, opt-in per env. Flip `payments_provider = "chapa"` and supply the two Secrets Manager ARNs to activate; revert to `payments_provider = "mock"` to deactivate. Existing data is intact through either flip — the gateway pair is reconstructed at Lambda cold start.
