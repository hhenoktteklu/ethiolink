# Phase 9 — Post-MVP Roadmap

> Phase 8 closed the production-hardening track and left the platform code-complete for v1 (see [`PHASE_8_COMPLETION_SUMMARY.md`](./PHASE_8_COMPLETION_SUMMARY.md)). Phase 9 covers everything required to turn "MVP-ready backend + admin SPA" into "MVP that real customers use": real notification providers, the Flutter mobile app, customer-managed encryption, localization, and the first wave of marketplace growth features. The phase deliberately does not pretend to ship all of these — it scopes the work, picks a first implementation track, and leaves the others as recommended workstreams to schedule.

> **Customer-surface complete.** Track 3 customer-side milestone closed across seven implementation commits + one summary commit. Full status read in [`PHASE_9_MOBILE_CUSTOMER_SUMMARY.md`](./PHASE_9_MOBILE_CUSTOMER_SUMMARY.md). End-to-end on the mobile app: login → browse → category → business → service → slot → confirm → see in history → cancel before cutoff OR review after completion. Six operator-led gates remain before TestFlight / Play Store internal-tester upload (Android + iOS deep-link verification on real devices, store record creation + signed-build upload, real-device Cognito smoke, real booking + SMS smoke). Next Track 3 candidate: business-owner mobile flows (Track 3.5) OR Telegram bot (Track 2), depending on launch-time signal.
>
> **Track 3.5 polish — owner profile editor landed.** One follow-up commit "Phase 9: add owner profile editor" closes the last dashboard SnackBar stub. `OwnerProfileScreen` wraps `PATCH /v1/businesses/{id}` over a new `BusinessActionsRepository.updateBusiness` + `PatchBusinessRequest` value object that supports per-field "clear this column" flags (encoded as explicit `null` on the wire). Form pre-fills from the loaded `OwnerBusinessView`; validators mirror the create-business wizard; 403/409/5xx render the same inline-banner pattern. Every owner-side dashboard card now opens a real screen.
>
> **Track 3.5 (business-owner mobile flows) complete.** Six implementation commits + one completion-summary commit closed the milestone. Full status read in [`PHASE_9_MOBILE_OWNER_SUMMARY.md`](./PHASE_9_MOBILE_OWNER_SUMMARY.md). End-to-end on the mobile app for a `BUSINESS_OWNER` session: sign in → My Business tab → create business → submit for review → admin approves → manage services + staff + weekly availability + closed-date overrides → bookings inbox → accept/reject/cancel/complete from the phone. Four operator-led gates remain before TestFlight / Play Store internal-tester upload alongside the customer surface (real-device deep-link verification for owner accounts, signed-build upload, real booking + SMS smoke from owner POV, owner role refresh after admin approval). Next workstream candidate: Profile / edit-business polish (the last dashboard SnackBar stub) OR Telegram bot provider (Track 2), depending on launch-time signal.
>
> **Track 3.5 detail.** First implementation commit "Phase 9: add owner mobile tab" landed the role-gated "My Business" bottom-nav tab (visible only when `session.role == 'BUSINESS_OWNER'`), `OwnerBusinessView` model + `OwnerBusinessRepository` over `GET /v1/me/business`, four `OwnerBusinessLoadFailureKind` error branches (`notFound` → CreateBusiness CTA placeholder, `forbidden` → sign-out/sign-back-in copy, `network` → retry, `serverError`/`other` → generic retry), and `OwnerDashboard` placeholder with five entry cards (Profile / Services / Staff / Availability / Bookings — each currently SnackBar-stubs). Status banners cover the non-APPROVED branches: DRAFT/REJECTED show a "submit for review" banner; PENDING_REVIEW/SUSPENDED show an "awaiting review" / "contact support" banner.
>
> Second commit "Phase 9: add owner create-business flow" landed the multi-step `CreateBusinessFlow` wizard reached from the 404 branch (basics → contact → description → review → create → optionally submit-for-review), the `BusinessActionsRepository` over `POST /v1/businesses` + `POST /v1/businesses/{id}/submit` with a `BusinessActionFailureKind` enum (`validation`, `forbidden`, `unauthenticated`, `conflict`, `notFound`, `network`, `serverError`, `malformedResponse`, `other`), and the working "Submit for review" button on the DRAFT/REJECTED banner so an already-existing draft can be submitted without re-running the wizard. The owner-mobile happy path is now end-to-end up to the admin approval gate: sign in as BUSINESS_OWNER → My Business tab → Create your business → fill basics/contact/description → review → Create → Submit for review → admin approves in the admin SPA → status flips to APPROVED → 5-card dashboard activates.
>
> Third commit "Phase 9: add owner services CRUD" landed `OwnerServicesScreen` (list with FAB → create modal sheet; tap a row → edit sheet; trash icon → confirm-then-DELETE), `OwnerServicesRepository` over `GET / POST / PATCH / DELETE /v1/businesses/{id}/services[/{sid}]` with an `OwnerServicesFailureKind` enum mirroring the create-business surface, and a shared modal `_ServiceFormSheet` used by both create and edit. The Services dashboard card now opens the real screen; the remaining four cards (Profile / Staff / Availability / Bookings) still SnackBar-stub. The `ApiClient` gained `patchJson` + `deleteJson` helpers — the PATCH helper unblocks future edit screens and the DELETE helper handles the soft-delete return-the-deactivated-row contract the API uses for services + staff. Validation: name required, duration > 0 + ≤ 720, price ≥ 0 when present.
>
> Fourth commit "Phase 9: add owner staff CRUD" landed `OwnerStaffScreen` + `OwnerStaffRepository` over `GET / POST / PATCH / DELETE /v1/businesses/{id}/staff[/{sid}]`, mirroring the services-CRUD shape almost field-for-field (same `OwnerStaffFailureKind` enum, same shared modal-sheet pattern, same confirm-then-DELETE flow). Staff form: displayName (required, max 200), role (optional, max 100). PATCH supports `clearRole: true` so the owner can blank out a role — the body encodes as `role: null`. The Staff dashboard card now opens the real screen; three cards remain (Profile / Availability / Bookings). With staff and services both real, the customer-side booking flow can now be exercised end-to-end against an owner-managed roster (the "Staff" wizard step that the customer-mobile commit shipped earlier was effectively dormant until the owner could create staff).
>
> Fifth commit "Phase 9: add owner availability editor" landed `OwnerAvailabilityScreen` + `AvailabilityRepository` over `GET / PUT /v1/businesses/{id}/staff/{sid}/availability` + `POST /v1/.../availability/override`, plus the `availability.dart` model module (`AvailabilityWindow` / `AvailabilitySchedule` / `WeeklyDayInput` / `WeeklyWindowInput` / `AvailabilityOverrideRequest`). Editor UI: staff dropdown sourced from the existing staff repo, seven weekday cards each with `HH:MM` start/end TextFields per interval and an "Add interval" / delete affordance, a Save button issuing one PUT with all 7 days, and an overrides section with an "Add closed date" button that opens a `showDatePicker` and POSTs a closed-day OVERRIDE (`isClosed: true`, 00:00–23:59). Validation: `HH:MM` regex, "end must be after start" lexicographic check, "both required" for empty fields. The `ApiClient` gained a `putJson` helper alongside the existing `postJson` / `patchJson` / `deleteJson`. Open-date overrides + per-override delete land in a follow-up commit; this one ships closed-day overrides only, which is enough for the customer-side slot picker to compute real slots.
>
> Sixth commit "Phase 9: add owner bookings inbox" landed `OwnerBookingsScreen` + `OwnerAppointmentDetailScreen` + `OwnerBookingsRepository` over `GET /v1/businesses/{id}/appointments` (with `status` / `from` / `to` query params) and the four action POSTs (`/accept`, `/reject`, `/cancel`, `/complete`). The list screen has Requested / Accepted / All filter chips; each row shows status badge + local start time + customer/service/staff IDs + price. The detail screen renders status-keyed actions (REQUESTED → Accept + Reject; ACCEPTED → Cancel + Mark complete; other states → read-only) with optional-reason dialogs for Reject and Cancel. `OwnerBookingsFailureKind` carries an `action` label so 409 CONFLICT banners can render action-specific copy ("Cannot accept — pull to refresh and check the latest status"). No no-show action — the backend doesn't expose one yet; lands when the endpoint does. Only one dashboard card remains (Profile). With bookings landed, the owner-mobile MVP loop is fully end-to-end: create business → submit → admin approves → add services + staff + availability → customer books → owner accepts → service performed → owner marks complete → customer reviews. Next: track-completion summary doc.
>
> **In progress.** Track 1 (real SMS provider) — gateway, factory, secret resolution, IAM scoping, per-recipient channel selection on both the appointment lifecycle AND the scheduled reminder path, plus the operator runbook, shipped across five commits. (1) "Phase 9: add SMS provider gateway" — gateway + config types + tests. (2) "Phase 9: wire SMS provider into dispatcher" — `loadSecretsThenConfig` resolves `SMS_PROVIDER_API_KEY_SECRET_ARN`, `notificationServiceFactory` selects between `MockNotificationGateway` and `GenericSmsGateway`, 9 handlers refactored onto the factory, Lambda IAM grants the SMS-secret read only to `appointments`+`scheduled` roles. (3) "Phase 9: route eligible notifications through SMS" — `AppointmentService.pickNotificationChannel` picks SMS when the recipient has a phone AND `smsRoutingEnabled` is set. (4) "Phase 9: route reminder notifications through SMS" — same selection rules applied to `runReminderBatch` via `ReminderBatchDeps.smsRoutingEnabled` + a `pickReminderChannel` helper that reuses the preloaded customer row to avoid a redundant fetch. (5) "Phase 9: add SMS provider runbook" — full operator playbook at `docs/operations/runbooks/sms-provider.md` covering provider selection, env-var wiring, secret shape, deployment, smoke test, rollback, troubleshooting, and key rotation. **Production routing is now end-to-end across every booking-lifecycle event AND the daily reminder dispatch** once the operator (a) sets the env vars + secret ARN in the env stacks AND (b) flips `notifications_provider` to `sms`. With both unset, every notification continues to route through `MOCK` exactly as before — the new code paths are no-ops without explicit opt-in.

## Current MVP status

The backend + admin + infrastructure surfaces are code-complete for v1:

- **Backend**: 49 Lambda handlers, 13 SQL migrations, 50 service-layer test groups, full booking state machine, admin actions audit trail, notification dispatcher + template registry + scheduled reminders.
- **Admin SPA**: 5 React pages, PKCE auth, protected routing, deployed behind CloudFront + OAC.
- **Infrastructure**: 12 Terraform modules wired into dev + prod, 50 Lambdas/env, RDS Postgres 15 Multi-AZ + Proxy in prod, Cognito with 12-char password policy, strict CloudFront security-headers policy, layered WAFv2 rate-based rules.
- **Observability**: X-Ray on every Lambda, AsyncLocalStorage correlation-id scope, 5 CloudWatch dashboards (including the route-family `${env}-endpoints` dashboard), 9 alarms (7 infra + 2 SLO-burn), 4 SLOs with documented error-budget policy.
- **CI/CD**: OIDC-trusted per-env deploy roles; `deploy-dev.yml` on push-to-`main`; `deploy-prod.yml` on tag-push + manual approval; `backup-verify.yml` monthly.

The one MVP scope item not yet implemented is the Flutter mobile app — captured below as a Phase 9 workstream rather than a Phase 8 gap because it postdates the infrastructure work and gates real customer launch in any meaningful sense.

## Remaining operator-led launch checklist

Carried over verbatim from `PHASE_8_COMPLETION_SUMMARY.md`. None require new code; each is a discrete operator action measured in hours-to-days.

- [ ] **Prod first apply.** Tag `v0.1.0`, trigger `deploy-prod.yml`, approve the manual gate, watch apply + migrator + smoke complete (~25 min wall-clock).
- [ ] **DR tabletop exercise.** Walk `DR_RUNBOOK.md` end-to-end against a scratch account; validate the 43-minute wall-clock estimate; record findings.
- [ ] **k6 capture + tuning.** Run `infra/k6/browse.js` + `book.js` against dev with realistic env vars; capture p50 / p95 / p99 + error rate; tune WAF + SLO + RDS / Lambda thresholds from real numbers in one or more Terraform-var-only commits.
- [ ] **MFA enrollment for every `ADMIN`.** Each admin enrolls TOTP via the hosted UI's Account Settings flow. Once universal, flip `mfa_configuration` from `OPTIONAL` to `ON`.
- [ ] **SNS alarm email confirmation.** Set `alarm_email` in the prod env stack, apply, click the AWS confirmation link.

These five gates are independent of Phase 9 code work — they can be completed in parallel with the workstreams below.

## Goal

Turn the launch-ready platform into a launched platform. The phase has three concurrent goals:

1. **Make notifications real.** The mock notification gateway is a credibility issue the moment a real customer receives (or fails to receive) a reminder. The first Phase 9 commit replaces it for the SMS channel; the second adds Telegram.
2. **Ship the mobile client.** The backend has no first-class customer-facing client today. The admin SPA covers internal operations only. The Flutter app is the gating item for any meaningful launch; without it the MVP scope-doc's clause 1 ("a customer can install the app, sign up, find a salon, and book") remains unmet.
3. **Lay the groundwork for sustainable growth.** Localization, customer-managed KMS encryption, and the first marketplace-growth features (paid featuring, search improvements, business analytics) all unlock post-launch trajectory but are not gating. They schedule once the first two goals are underway.

## Scope

In scope (recommended workstreams, in rough priority order):

- **Real SMS provider integration.** Replace `MockNotificationGateway` for the `SMS` channel with a concrete provider gateway (AfroMessage or similar Ethiopian REST provider). Provider credentials in Secrets Manager; per-domain `notifications` Lambda role gains scoped `secretsmanager:GetSecretValue`; dispatcher swaps the gateway when `NOTIFICATIONS_PROVIDER=production`. **First recommended implementation track — see dedicated section below.**
- **Telegram bot provider integration.** Provision a BotFather bot, add `users.telegram_chat_id` via migration 0014, add `/v1/me/link-telegram` linking endpoint, ship `TelegramBotGateway` implementing `NotificationGateway`. Routes through the dispatcher when the user has a linked chat id.
- **Flutter mobile scaffold + customer-side MVP.** `mobile/` directory at the repo root; `flutter create` scaffold + workspace integration; `flutter_appauth` PKCE wiring against the existing Cognito mobile app-client; OpenAPI-generated Dart client; customer browse + booking + history flows; business sign-up + service / staff CRUD + accept-reject-complete flow. Push notifications via FCM/APNs remain deferred per `MVP_SCOPE.md`. Lint + test workflow at `.github/workflows/lint-test-mobile.yml`.
- **KMS-managed encryption migration.** New `infra/terraform/modules/kms/` with one CMK per consuming service (rds, s3-media-public, s3-media-private, secrets, lambda-env). Each consumer module gains a `kms_key_id` input defaulting to `null` (= AWS-managed). Re-encryption at rest in a maintenance window: RDS snapshot + restore-with-CMK; S3 `cp --recursive --sse aws:kms`; Secrets Manager `update-secret --kms-key-id`. Per-domain Lambda roles gain `kms:Decrypt` (+ `kms:GenerateDataKey*` for write paths) scoped to the relevant key ARNs.
- **Amharic / native localization.** Migration 0015 adds `users.locale` with default `'en'` + CHECK in `('en', 'am')`. `PATCH /v1/me` accepts `locale`. Template registry grows `.am` variants for every customer-facing template. Flutter app ships with both ARB bundles. Admin SPA gets `react-i18next` scaffolding (lower priority — operator surface).
- **Marketplace growth features.** Each is a separate workstream with its own commit cadence:
  - **Search / discovery improvements.** GIN index on `business_profiles.description` for full-text search; optional PostGIS lat/lon radius search; new `search` query param on `GET /v1/businesses`.
  - **Paid featuring.** `featuring_subscriptions` table + checkout flow + daily expiration sweep + business-side self-service featuring UI. Gated on the online-payment provider landing first.
  - **Online payments (Telebirr first).** Replace `MockOnlineGateway` with `TelebirrGateway`. The `payment_intents` table + the `paymentMethod = 'ONLINE_PENDING'` placeholder are already in place; the gateway port exists. The `ONLINE_PAYMENTS_UNAVAILABLE` sub-code goes away on the day the real gateway lands.
  - **Reviews v2.** Per-staff ratings, photo uploads on reviews, owner responses.
  - **Business analytics.** Read-only dashboard for business owners (booking volume, revenue, top services, repeat-customer rate). No migrations needed; reads from existing tables.

Out of scope (carried from `MVP_SCOPE.md` "explicitly deferred"):

- Event ticketing, product marketplace, car dealership listings.
- In-app chat between customers and businesses.
- Loyalty programs, vouchers, discount codes (post-Phase-9 candidate alongside paid featuring).
- Multi-currency beyond ETB.
- Cryptocurrency payments (never).
- Reviews not tied to a completed booking (never).

## First recommended implementation track — real SMS provider integration

Sequenced first because it's small, well-scoped, fits inside the existing notification architecture, and produces customer-visible value the moment the mobile app exists. Shipping it before the mobile app means real SMS reminders are already going out by the time customers can install the app — no second roll-out, no mock-to-real cutover after-the-fact.

### Commit shape

1. **Provider decision.** Operator picks the SMS provider (recommended starting point: AfroMessage for the documented REST API + Telco-direct routing). The codebase doesn't bind to a specific provider — the gateway is the seam. The recommendation is a non-blocking suggestion; any provider with a documented REST API works.
2. **`AfroMessageSmsGateway`** at `backend/shared/adapters/notifications/AfroMessageSmsGateway.ts` implementing the existing `NotificationGateway` port. HTTP-only via `fetch`; honors the provider's per-account rate limit; parses the provider's response into the dispatcher's `DeliveryReceipt` shape.
3. **Provider credentials.** New Secrets Manager secret `ethiolink/${env}/sms-provider/api-key` with the API key + sender id JSON shape. The per-domain `notifications` Lambda IAM role gains `secretsmanager:GetSecretValue` scoped to that single secret ARN — no `*` wildcard.
4. **Config wiring.** New `SMS_PROVIDER_API_KEY`, `SMS_PROVIDER_SENDER_ID`, `SMS_PROVIDER_BASE_URL` entries in `loadConfig.ts` + the loader's secret-resolution surface (`loadSecretsThenConfig`). The values resolve from the new secret on cold start; warm containers cache via the existing module-scope cache.
5. **Dispatcher wiring.** `backend/shared/adapters/notifications/dispatcherFactory.ts` selects `AfroMessageSmsGateway` for the `SMS` channel when `NOTIFICATIONS_PROVIDER=production`, falling back to `MockSmsGateway` otherwise. Existing tests (`notificationDispatcher.test.ts`) verify the dispatcher-level behavior; the gateway-level tests are new in this commit.
6. **Tests** in `backend/tests/adapters/notifications/AfroMessageSmsGateway.test.ts`: 1 happy path + 4 failure modes (invalid number → 4xx, rate-limited → 429, provider 5xx → retry-eligible failure, network timeout → fast-fail with a clear error code). The test suite mocks `fetch` per the existing pattern.
7. **Operator runbook** at `docs/operations/runbooks/sms-provider.md` covering: how to rotate the API key (Secrets Manager `put-secret-value`), how to read the provider's delivery dashboard, what `provider_ref` formats look like in `notification_logs`, what to do when a sustained `FAILED` rate appears.
8. **Phase 9 commit** "Phase 9: wire real SMS provider".

### Files touched

- New: `backend/shared/adapters/notifications/AfroMessageSmsGateway.ts`, `backend/tests/adapters/notifications/AfroMessageSmsGateway.test.ts`, `docs/operations/runbooks/sms-provider.md`.
- Modified: `backend/shared/config/loadConfig.ts`, `backend/shared/config/loadSecretsThenConfig.ts`, `backend/shared/adapters/notifications/dispatcherFactory.ts`, `infra/terraform/modules/lambda/*` (env vars + `notifications` role secret scope), env stacks (`function_env_overrides` and the new secret ARN passthrough), `docs/architecture/AWS_DEPLOYMENT.md`, `docs/tasks/PHASE_9_POST_MVP.md` (this file — flip checklist).
- No app-handler code changes — every booking-lifecycle handler still calls `dispatcher.dispatch(...)` exactly as it does today.

## Files involved

The list spans the recommended workstreams. Files marked *(new)* don't exist today; files marked *(extended)* gain new sections or new resources.

### Real SMS provider

- `backend/shared/adapters/notifications/AfroMessageSmsGateway.ts` *(new)*
- `backend/shared/adapters/notifications/dispatcherFactory.ts` *(extended)*
- `backend/shared/config/{loadConfig,loadSecretsThenConfig}.ts` *(extended)*
- `backend/tests/adapters/notifications/AfroMessageSmsGateway.test.ts` *(new)*
- `infra/terraform/modules/lambda/*` *(extended — env vars + per-role secret ARN)*
- `docs/operations/runbooks/sms-provider.md` *(new)*

### Telegram bot

- `backend/shared/adapters/notifications/TelegramBotGateway.ts` *(new)*
- `backend/lambdas/me/linkTelegram.ts` *(new)*
- `backend/db/migrations/0014_users_telegram_chat_id.sql` *(new)*
- `infra/terraform/modules/api-gateway/main.tf` *(extended — new route)*
- `infra/terraform/modules/lambda/*` *(extended — new function + bot-token secret scope)*
- `docs/operations/runbooks/telegram-bot.md` *(new)*

### Flutter mobile scaffold

- `mobile/` *(new tree; `flutter create` scaffold + customer / business app shell)*
- `mobile/lib/api/generated/*` *(generated from `backend/api/openapi.yaml` via `openapi-generator-cli`)*
- `.github/workflows/lint-test-mobile.yml` *(new — Flutter analyze + test)*
- `docs/tasks/PHASE_9_MOBILE_APP.md` *(new sub-phase doc when the work starts)*

### KMS migration

- `infra/terraform/modules/kms/{main,variables,outputs}.tf` *(new module)*
- `infra/terraform/modules/{rds,s3,secrets,lambda}/*` *(extended — accept `kms_key_id` inputs)*
- `infra/terraform/environments/{dev,prod}/main.tf` *(extended — wire the new module)*
- `docs/operations/runbooks/kms-migration.md` *(new — re-encryption procedure)*

### Localization

- `backend/db/migrations/0015_users_locale.sql` *(new)*
- `backend/shared/domains/users/userService.ts` *(extended)*
- `backend/shared/domains/notifications/templateRegistry.ts` *(extended — per-locale entries)*
- `mobile/lib/i18n/{en,am}.arb` *(new — Flutter ARB bundles)*
- `admin/src/i18n/{en,am}.json` *(new — admin SPA bundles, lower priority)*

### Marketplace growth

- `backend/db/migrations/0016_business_description_gin.sql` *(new — search index)*
- `backend/db/migrations/0017_featuring_subscriptions.sql` *(new — paid featuring)*
- `backend/shared/adapters/payments/TelebirrGateway.ts` *(new — replaces `MockOnlineGateway`)*
- Various extended handlers + service layers per feature.

## Checklist

The first track is sequenced; the rest are recommended workstreams to schedule against post-launch priorities.

### Track 1 — Real SMS provider (first recommended implementation)

- [ ] Provider chosen and credentials in Secrets Manager (`ethiolink/${env}/sms-provider/api-key`). *(Pending operator decision. The gateway is provider-agnostic so this can be a single env-var change in the env stack once chosen.)*
- [x] `GenericSmsGateway` implements `NotificationGateway` with happy-path + 4 failure-mode tests passing. *(Phase 9 commit "add SMS provider gateway". Provider-agnostic skeleton; subclassing for vendor-specific wire-shape quirks is the operator-side follow-up once a provider is chosen.)*
- [x] `notificationServiceFactory.ts` selects the real gateway when `NOTIFICATIONS_PROVIDER=sms` (or `production`) AND `config.smsProvider` is non-null; mock retained as the always-wired fallback. *(Phase 9 commit "wire SMS provider into dispatcher". The 9 appointment + scheduled-reminder handlers now consume the factory instead of hand-building the service. Production routing still passes `channel: 'MOCK'` in `appointmentService.notify` — see the in-progress note above; flipping that default is the next-commit follow-up.)*
- [x] Lambda `appointments` + `scheduled` IAM roles grant `secretsmanager:GetSecretValue` scoped to the SMS secret ARN only. *(Phase 9 commit "wire SMS provider into dispatcher". The IAM resource is created only when `var.sms_provider_api_key_secret_arn` is non-empty — env stacks that haven't wired SMS see no IAM drift. Other domains continue to lack the permission.)*
- [x] `loadConfig.ts` resolves `SMS_PROVIDER_*` env vars on cold start, and `loadSecretsThenConfig.ts` resolves `SMS_PROVIDER_API_KEY_SECRET_ARN` from Secrets Manager. *(Phase 9 commits "add SMS provider gateway" + "wire SMS provider into dispatcher". The SecretString accepts either a plain key string or a JSON object with an `apiKey` field. An explicit `SMS_PROVIDER_API_KEY` env value (local-dev path) bypasses the resolver. Cache lives at module scope alongside the RDS one.)*
- [x] Operator runbook at `docs/operations/runbooks/sms-provider.md` covers rotation, dashboard, troubleshooting. *(Phase 9 commit "add SMS provider runbook". Provider-selection note + required env vars + Secrets Manager secret shape (plain or JSON) + Terraform wiring steps for dev/prod + deployment procedure + end-to-end smoke (booking + reminder + log inspection) + two rollback paths + 6-case troubleshooting table + key rotation procedure + dashboards section + 3 follow-up items recorded. Reads as a self-contained playbook; the operator's first task post-merge is to pick the vendor + provision the secret.)*
- [ ] One end-to-end test SMS sent from dev to a real phone, recorded in `notification_logs` with `status=DELIVERED`. *(Final acceptance gate for the track. Requires provider chosen + dispatcher flipped + IAM scope + runbook.)*

### Track 2 — Telegram bot

- [ ] BotFather bot provisioned; token in Secrets Manager.
- [x] Migration 0014 adds `users.telegram_chat_id text NULL` + partial index. *(Phase 9 commit "add Telegram linking foundation". `UserRepository.setTelegramChatId` is the dedicated mutation path; `notificationService.buildRecipient` now reads the column so the future Telegram gateway sees the linked chat id automatically.)*
- [x] Migration 0015 adds `users_telegram_link_codes` table + `PgTelegramLinkCodeRepository` + `InMemoryTelegramLinkCodeRepository`. *(Phase 9 commit "add Telegram linking foundation". Short-lived per-user codes; service layer enforces single-use + per-user invalidation on re-issue.)*
- [x] `TelegramLinkService` (start / redeem / unlink) with typed errors. *(Phase 9 commit "add Telegram linking foundation". 12-test suite covering deep-link generation, TTL, single-use, expiry, empty-chatid rejection, unlink-when-not-linked.)*
- [x] `GenericTelegramGateway` implements `NotificationGateway` against the Telegram Bot API `sendMessage`. *(Phase 9 commit "add Telegram linking foundation". Eight-case test suite over `FakeTelegramHttpTransport`: 2xx, 400 chat-not-found, 403 bot-blocked, 429 rate-limited, 5xx unavailable, network timeout, missing chat id, factory null-config guard. Provider tag `'TELEGRAM_BOT'`. Existing `TelegramNotificationGateway` stub remains as the default "not configured" gateway.)*
- [x] `loadConfig` resolves `TELEGRAM_*` env vars into `AppConfig.telegramProvider`; `loadSecretsThenConfig` resolves `TELEGRAM_BOT_TOKEN_SECRET_ARN` + `TELEGRAM_WEBHOOK_SECRET_ARN` from Secrets Manager (both plain-string and JSON shapes). *(Phase 9 commit "add Telegram linking foundation".)*
- [x] `POST /v1/me/link-telegram/start` + `GET /v1/me/telegram-status` + `DELETE /v1/me/link-telegram` Lambda handlers + OpenAPI routes. *(Phase 9 commit "add Telegram link endpoints". Three new handlers under `backend/lambdas/me/linkTelegram*.ts`. The `me` area was also added to `lambda_areas` (it had been missing since the Phase 8 IAM split — latent bug). Each handler returns 503 when the operator hasn't wired Telegram in this env, so the routes are safe to deploy ahead of provisioning. Tests cover happy path / 401 / 404 / 503 branches.)*
- [x] `POST /v1/integrations/telegram/webhook` Lambda + secret-header guard. *(Phase 9 commit "add Telegram link endpoints". New `integrations` Lambda area + IAM role; scoped reads on the bot-token + webhook secret ARNs. Constant-time secret comparison; permissive on every non-secret-mismatch branch so Telegram doesn't retry (200 even on unknown / expired codes; we reply via the bot with a failure message). 9-case test suite covers secret-header rejection, happy /start, unknown code, expired code, malformed body, non-/start updates, no-message updates, 503 when unwired, and reply-hook failure being non-fatal.)*
- [x] `notificationServiceFactory` wires `TELEGRAM` when `config.telegramProvider` is non-null and `notificationsProvider` is `'telegram'` or `'production'`. *(Phase 9 commit "route notifications through Telegram". `NotificationsProvider` enum widened to include `'telegram'`; `'production'` now opts in to BOTH SMS and Telegram. New `shouldWireTelegramGateway(config)` helper mirrors the SMS one. Five-case test group verifies SMS-only / telegram-only / production / unconfigured combinations.)*
- [x] Channel selection in `AppointmentService.pickNotificationChannel` + `pickReminderChannel` prefers Telegram when the recipient has a linked chat id; falls back to SMS / MOCK. *(Phase 9 commit "route notifications through Telegram". Priority order: TELEGRAM > SMS > MOCK. New `telegramRoutingEnabled` flag on both surfaces; all eight appointment Lambdas + the reminder Lambda updated to thread `shouldWireTelegramGateway(config)` alongside the SMS flag. Five new appointment-service tests + three new reminder tests cover the priority + fallback paths. Terraform `notifications_provider` variable now accepts `'telegram'`; the bot-token IAM grant extends to `appointments` + `scheduled` roles when the secret ARN is set.)*
- [ ] Mobile `LinkTelegramScreen` (Profile-tab entry point on both customer + owner surfaces).
- [ ] Operator runbook at `docs/operations/runbooks/telegram-bot.md`.

### Track 3 — Flutter mobile scaffold

- [x] `mobile/` directory scaffolded; `flutter analyze` + `flutter test` clean. *(Phase 9 commit "scaffold Flutter mobile app". Working `pubspec.yaml` + `analysis_options.yaml` + `.gitignore` + `lib/` tree with `core/{config,api,auth}/` + `features/{auth,browse,bookings,profile}/` + boot widget smoke test. Per-platform scaffolding (`android/`, `ios/`, ...) regenerated locally via `flutter create .`; deliberately uncommitted. Placeholder screens render end-to-end without any backend running thanks to a `FakeAuthService` stub. See `mobile/README.md` for the setup playbook.)*
- [x] `flutter_appauth` PKCE wiring against the Cognito mobile app-client; deep-link callback on `ethiolink://auth/callback`. *(Phase 9 commit "add Flutter Cognito auth". `CognitoAuthService` implements `AuthService` (`signIn` / `signOut` / `currentSession`) driving `flutter_appauth.authorizeAndExchangeCode` against `https://${cognitoDomain}/oauth2/{authorize,token,logout}` with PKCE; tokens persist in `flutter_secure_storage` (Keychain / Keystore); on-near-expiry refresh built into `currentSession`. `FakeAuthService` retained for tests + offline demo via `LoginScreen.authServiceOverride`. Platform deep-link setup (Android intent filter + iOS `CFBundleURLSchemes`) documented in `mobile/README.md`.)*
- [ ] OpenAPI-generated Dart client lands at `mobile/lib/api/generated/` and rebuilds on every API change. *(Hand-written `Category` model + `HttpCategoriesRepository` shipped in commit "add mobile categories fetch" as the first concrete API call. The OpenAPI codegen swap stays a future follow-up — the hand-written model is a 1:1 mirror of the `CategoryView` schema and migrates mechanically.)*
- [x] Customer browse + book + history flows light up against the dev API. *(All three complete — Phase 9 commits "add mobile categories fetch" + "add mobile businesses listing" + "add mobile business detail" + "add mobile booking flow" + "add mobile appointment history". End-to-end customer loop: browse → category → business → service → slot → confirm → history → cancel/review.)*
- [ ] Business sign-up + service / staff CRUD + accept-reject-complete flows light up against the dev API.
- [ ] `.github/workflows/lint-test-mobile.yml` runs on every push.
- [x] Sub-phase completion doc at [`docs/tasks/PHASE_9_MOBILE_CUSTOMER_SUMMARY.md`](./PHASE_9_MOBILE_CUSTOMER_SUMMARY.md). *(Phase 9 commit "add mobile customer summary". Captures the seven mobile commits with hashes, the eight end-to-end customer flows now working, ~75 tests across 14 suites, the six remaining operator-led gates (Android + iOS deep-link verification, TestFlight + Play Store internal-track uploads, real-device Cognito + booking smokes), and the recommended next workstream (business-owner mobile flows OR Telegram bot, depending on launch priority).)*

### Track 4 — KMS migration

- [ ] `infra/terraform/modules/kms/` module created with one `aws_kms_key` per consuming service.
- [ ] Each consumer module accepts a `kms_key_id` input defaulting to `null` (= AWS-managed; no behavior change when unset).
- [ ] Env stacks wire the new module's key ARNs to the consumer modules.
- [ ] Per-domain Lambda IAM roles gain `kms:Decrypt` (+ `kms:GenerateDataKey*` for write paths) scoped to the relevant key ARNs.
- [ ] Re-encryption procedure documented in `docs/operations/runbooks/kms-migration.md`; one dev maintenance window completed end-to-end.

### Track 5 — Amharic / localization

- [ ] Migration 0015 adds `users.locale` with `CHECK in ('en', 'am')`.
- [ ] `PATCH /v1/me` accepts `locale`; the notification dispatcher reads `recipient.locale` when picking templates.
- [ ] Template registry has `.am` variants for every customer-facing template.
- [ ] Flutter app ships with both `en` and `am` ARB bundles; locale picker in app settings.
- [ ] Admin SPA i18n scaffolding (lower priority).

### Track 6 — Marketplace growth (independent commits)

- [ ] Migration 0016 adds GIN index on `business_profiles.description`; `GET /v1/businesses` accepts `search` param.
- [ ] Migration 0017 adds `featuring_subscriptions` table + daily expiration sweep Lambda + business-side self-service featuring UI.
- [ ] `TelebirrGateway` replaces `MockOnlineGateway`; `ONLINE_PAYMENTS_UNAVAILABLE` sub-code retired.
- [ ] Reviews v2: per-staff ratings, photo uploads, owner responses.
- [ ] Business analytics: read-only dashboard for owners (booking volume, revenue, top services, repeat-customer rate).

## Acceptance criteria

- A real SMS reaches a real phone via the new gateway in dev, recorded in `notification_logs` with `status=DELIVERED` and a non-null `provider_ref`.
- The Flutter app's customer flow completes a booking end-to-end against the dev API: sign-up → browse → service / staff / slot pick → confirm → real SMS reminder received.
- KMS migration in dev: every at-rest surface (RDS, S3 buckets, Secrets Manager, Lambda env vars) reads encrypted data correctly via the smoke workflow after the maintenance window.
- Localization: a user with `locale='am'` receives Amharic-language reminders + sees the mobile app in Amharic.
- Marketplace growth: search returns relevant results in < 200 ms p95; paid featuring drives a measurable lift in business detail views; online payment integration completes a TEL_BIRR flow end-to-end.

Each track has its own acceptance line — they're independent and don't gate each other except where called out.

## Test plan

- **SMS provider**: 1 happy path + 4 failure-mode unit tests on the gateway; 1 end-to-end smoke from dev to a real phone before declaring the track complete.
- **Telegram bot**: 1 linking-flow integration test (mock the Bot API) + 1 end-to-end smoke linking a real account in dev.
- **Mobile app**: Flutter widget tests for each customer + business flow; integration tests against the dev API using `flutter_driver`; manual UAT against a TestFlight / internal-track build before TestFlight invite-only rollout.
- **KMS migration**: dry-run in dev first; verify smoke workflow passes against re-encrypted RDS + S3; confirm Secrets Manager reads continue to work after `kms_key_id` swap.
- **Localization**: snapshot tests for the Flutter app's Amharic bundle; manual review of every template by an Amharic-speaking reviewer; round-trip test of `PATCH /v1/me { locale: 'am' }` followed by a reminder dispatch.
- **Marketplace growth**: feature-by-feature unit + integration tests per commit; k6 scenarios extended where the feature adds a new hot path (e.g. `search.js` for the search endpoint).

## Rollout / rollback notes

- **SMS provider**: roll out behind the `NOTIFICATIONS_PROVIDER` env var. Setting it to `production` flips the gateway; reverting to `mock` instantly restores the mock behavior with no schema or state changes. The provider's API key in Secrets Manager can be rotated independently via Secrets Manager.
- **Telegram bot**: linking is opt-in per user; the bot token in Secrets Manager can be revoked instantly via BotFather + secret rotation. Users without a linked chat id fall back to SMS automatically.
- **Mobile app**: TestFlight + Play Store internal-track first; gradual rollout (1% → 10% → 50% → 100%) via the store's staged-release knob. The app talks to the same API surface the admin SPA + future web client use, so a rollback to the previous app version is non-coupled to the backend.
- **KMS migration**: each consumer's `kms_key_id` defaults to `null` (= AWS-managed). Reverting the input value to `null` re-encrypts new writes with the AWS-managed key; existing at-rest data remains under the CMK until a follow-up re-encryption pass. Multi-step rollback path documented in the runbook.
- **Localization**: additive; the `am` templates ship alongside `en`. Reverting is a config-only change (set `users.locale` defaults back to `'en'` for all rows).
- **Marketplace growth**: each feature is behind its own flag where reasonable. Migrations are forward-only per the project convention; a compensating migration is the rollback path for any schema change.

## Risks and product decisions

- **SMS provider lock-in risk.** The gateway-port architecture mitigates this — swapping providers means writing a new gateway class, not refactoring the dispatch layer. The recommendation is to ship one provider first and add a second if the first becomes unreliable, rather than designing a multi-provider failover from day one.
- **Telegram dependency.** Telegram is widely adopted in Ethiopia but the Bot API depends on Telegram's service availability + their geo-availability decisions. The dispatcher's fallback chain (Telegram → SMS → log-only) is the mitigation.
- **Flutter mobile app sizing risk.** A working customer + business app is 4–6 weeks for the customer side and 2–3 more for the business side under optimistic conditions. Realistic scope creep (push notifications, complex availability picker UX, edge-case offline handling) makes 10–12 weeks total a more honest estimate. Worth scoping a phase 9.5 if the app track stretches.
- **KMS migration window risk.** Re-encrypting an RDS instance requires a snapshot + restore-with-CMK, which is a maintenance window. The DR runbook's restore procedure is the reusable mechanism. Plan a Saturday-morning window in dev first, then prod after the dev exercise succeeds end-to-end.
- **Amharic template review bottleneck.** Native Amharic translation requires a native-speaking reviewer. Without one in the loop, the translation pass risks shipping with copy errors that hurt customer trust more than English-only would. Identify the reviewer before opening the localization track.
- **Payment provider integration cost.** Telebirr's developer onboarding is documented but slow; a single provider integration may take 2–3 weeks of calendar time for credentials + sandbox + production cutover, even when the gateway code itself is a few hundred lines. Sequence the engineering work to fit the operator-side timeline.
- **"Mobile first" vs. "operations first" sequencing decision.** The recommendation in this phase doc is operations-first (SMS → Telegram → Mobile), based on the argument that real SMS reminders should pre-date real customer signups. The alternative (mobile-first, mock notifications until first customer cohort) ships customer value faster but creates a credibility issue on the day the first real reminder doesn't arrive. The operator team makes the final call; the architecture supports either order.
