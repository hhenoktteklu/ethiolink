# Phase 9 — Post-MVP Roadmap

> Phase 8 closed the production-hardening track and left the platform code-complete for v1 (see [`PHASE_8_COMPLETION_SUMMARY.md`](./PHASE_8_COMPLETION_SUMMARY.md)). Phase 9 covers everything required to turn "MVP-ready backend + admin SPA" into "MVP that real customers use": real notification providers, the Flutter mobile app, customer-managed encryption, localization, and the first wave of marketplace growth features. The phase deliberately does not pretend to ship all of these — it scopes the work, picks a first implementation track, and leaves the others as recommended workstreams to schedule.

> **In progress.** Track 3 (Flutter mobile scaffold) — three commits landed: (1) "Phase 9: scaffold Flutter mobile app" — project structure, placeholder screens, `FakeAuthService`. (2) "Phase 9: add Flutter Cognito auth" — real `CognitoAuthService` via `flutter_appauth` + secure-storage token cache + on-near-expiry refresh + working sign-out. (3) "Phase 9: add mobile categories fetch" — Dio-backed `ApiClient` with an `AuthTokenInterceptor` (reads `idToken` from secure storage; attaches `Authorization: Bearer ...` when present; public endpoints work without one; one-shot 401 retry), `Category` model + `HttpCategoriesRepository`, BrowseScreen wired to live `GET /v1/categories` with loading / success / empty / error states + pull-to-refresh + retry button. Test seam: every screen accepts repository overrides so widget tests stay network-free. Next mobile commit: businesses search behind the category cards.
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
- [ ] Migration 0014 adds `users.telegram_chat_id text NULL`.
- [ ] `POST /v1/me/link-telegram` handler accepts a one-time linking token and writes `users.telegram_chat_id`.
- [ ] `TelegramBotGateway` implements `NotificationGateway` against the Telegram Bot API's `sendMessage`.
- [ ] Dispatcher routes through the gateway when the recipient has a linked chat id; falls back to SMS when not.
- [ ] Operator runbook at `docs/operations/runbooks/telegram-bot.md`.

### Track 3 — Flutter mobile scaffold

- [x] `mobile/` directory scaffolded; `flutter analyze` + `flutter test` clean. *(Phase 9 commit "scaffold Flutter mobile app". Working `pubspec.yaml` + `analysis_options.yaml` + `.gitignore` + `lib/` tree with `core/{config,api,auth}/` + `features/{auth,browse,bookings,profile}/` + boot widget smoke test. Per-platform scaffolding (`android/`, `ios/`, ...) regenerated locally via `flutter create .`; deliberately uncommitted. Placeholder screens render end-to-end without any backend running thanks to a `FakeAuthService` stub. See `mobile/README.md` for the setup playbook.)*
- [x] `flutter_appauth` PKCE wiring against the Cognito mobile app-client; deep-link callback on `ethiolink://auth/callback`. *(Phase 9 commit "add Flutter Cognito auth". `CognitoAuthService` implements `AuthService` (`signIn` / `signOut` / `currentSession`) driving `flutter_appauth.authorizeAndExchangeCode` against `https://${cognitoDomain}/oauth2/{authorize,token,logout}` with PKCE; tokens persist in `flutter_secure_storage` (Keychain / Keystore); on-near-expiry refresh built into `currentSession`. `FakeAuthService` retained for tests + offline demo via `LoginScreen.authServiceOverride`. Platform deep-link setup (Android intent filter + iOS `CFBundleURLSchemes`) documented in `mobile/README.md`.)*
- [ ] OpenAPI-generated Dart client lands at `mobile/lib/api/generated/` and rebuilds on every API change. *(Hand-written `Category` model + `HttpCategoriesRepository` shipped in commit "add mobile categories fetch" as the first concrete API call. The OpenAPI codegen swap stays a future follow-up — the hand-written model is a 1:1 mirror of the `CategoryView` schema and migrates mechanically.)*
- [ ] Customer browse + book + history flows light up against the dev API.
- [ ] Business sign-up + service / staff CRUD + accept-reject-complete flows light up against the dev API.
- [ ] `.github/workflows/lint-test-mobile.yml` runs on every push.
- [ ] Sub-phase completion doc at `docs/tasks/PHASE_9_MOBILE_APP.md`.

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
