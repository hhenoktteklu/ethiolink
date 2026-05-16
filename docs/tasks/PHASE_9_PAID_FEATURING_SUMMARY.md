# Phase 9 — Paid Featuring Completion Summary

Phase 9 Track 6's paid-featuring sub-bullet is feature-complete on the engineering side. This document captures the shipped surface, the open operator gates, and the deferred follow-ups so the next-track conversation has a single source of truth.

The companion operator playbook lives at [`docs/operations/runbooks/paid-featuring.md`](../operations/runbooks/paid-featuring.md).

## Completed commits

Four commits make up the paid-featuring workstream, all on `main`:

| Hash       | Message                                       | Scope                                                                                                                         |
| ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ea5b8c8`  | Phase 9: add featuring subscriptions foundation | Migration 0018; `FeaturingService` (subscribe / comp / cancel / expireSweep / listHistory); `FeaturingConfig`; 20-case test.   |
| `5b3bd31`  | Phase 9: add featuring endpoints and sweep    | 7 HTTP routes; scheduled-featuring-sweep Lambda; Terraform wiring; OpenAPI schema additions; handler test suite.              |
| `386a32b`  | Phase 9: add owner featuring UI               | Flutter `OwnerPromoteScreen` + `OwnerFeaturingHistoryScreen`; `HttpFeaturingRepository`; Promote card on the owner dashboard. |
| `303100b`  | Phase 9: add admin featuring panel            | Admin SPA `FeaturingHistoryPanel` + comp + cancel forms; admin API client extension; manual feature/unfeature card preserved. |

## Completed backend

- **Schema** (`backend/db/migrations/0018_featuring_subscriptions.sql`): `featuring_subscriptions` table with the partial unique index `featuring_subscriptions_one_active_per_business` (enforces at most one ACTIVE per business), the `(status, ends_at)` index that powers the sweep, and the `(business_id, created_at DESC)` index that powers history reads. `payment_intents` widened to make `appointment_id` nullable and to carry `featuring_subscription_id` with a XOR `CHECK` constraint ensuring exactly one FK is populated.
- **Service** (`backend/shared/domains/featuring/featuringService.ts`): `listPackages`, `subscribe` (with idempotency-key dedupe + PENDING / SUCCEEDED / FAILED gateway-result branching + already-active rejection), `comp` (admin path, source `ADMIN_COMP`, price 0, duration validation 1–365), `cancel` (active → CANCELLED, recompute `featured_until`), `expireSweep` (ACTIVE → EXPIRED for past-`endsAt`, PENDING_PAYMENT GC past 10-minute TTL, recompute `featured_until` per touched business), `listHistoryForBusiness` (newest-first, capped at limit).
- **Payment gateway abstraction** (`backend/shared/integrations/payments/paymentGateway.ts`): `PaymentAuthorizationInput` widened to a discriminated union of `purpose: 'APPOINTMENT'` / `purpose: 'FEATURING'`. Existing booking-side callers updated to set `purpose: 'APPOINTMENT'`; `CashGateway` and `MockOnlineGateway` require no logic change. The seam is ready for a real `TelebirrGateway` to drop in.
- **HTTP handlers** (`backend/lambdas/featuring/` and `backend/lambdas/admin/featuring/`): 4 owner endpoints (`GET packages`, `POST subscribe`, `GET active`, `GET history`) gated by the `_authz.ts` BUSINESS_OWNER + business-ownership helper; 3 admin endpoints (`GET history`, `POST comp`, `POST cancel`) gated by the existing `authorizeAdmin` helper; the `FEATURING_ENABLED` env-flag short-circuits the owner-facing routes with `503 FEATURING_DISABLED` when off.
- **Sweep Lambda** (`backend/lambdas/scheduled/featuringSweep.ts`): runs `FeaturingService.expireSweep`; returns `{ expired, pendingPurged, featuredUntilRecomputed }`. Idempotent — repeat invocations are no-ops until new data lands.
- **Infrastructure** (`infra/terraform/modules/lambda/` + `infra/terraform/modules/eventbridge/`): 8 new Lambda function blocks; new `featuring` IAM area; 7 new API Gateway routes; EventBridge `featuring-sweep` rule at `rate(15 minutes)` cadence (count-gated on the Lambda being wired); three new env vars (`FEATURING_ENABLED`, `FEATURING_7D_PRICE_ETB`, `FEATURING_30D_PRICE_ETB`) defaulting to opt-in-off / 500 ETB / 1500 ETB.
- **OpenAPI** (`backend/api/openapi.yaml`): 7 endpoints (4 owner-side, 3 admin-side) and 7 schemas (`FeaturingPackage`, `FeaturingPackageList`, `FeaturingSubscription`, `FeaturingSubscriptionList`, `SubscribeFeaturingRequest`, `AdminCompFeaturingRequest`, `AdminCancelFeaturingRequest`).
- **Tests**: `featuringService.test.ts` (20 cases — package listing, subscribe under FakeGateway + CashGateway, already-active conflict, gateway-throw / -FAILED / -PENDING, comp + duration validation, cancel + no-active error, expireSweep idempotency + PENDING TTL purge + featured_until recompute, history listing); `featuringHandlers.test.ts` (handler-level coverage for the same scenarios plus the disabled-env short-circuit).

## Completed mobile owner UI

- **Models** (`mobile/lib/features/owner/models/featuring.dart`): `FeaturingPackage` + `FeaturingSubscription` value objects with defensive `fromJson` factories that throw `FormatException` on missing / mistyped fields. `FeaturingSubscription` carries `isActive` / `isPending` / `isComp` convenience getters.
- **Repository** (`mobile/lib/features/owner/data/featuring_repository.dart`): `FeaturingRepository` port + `HttpFeaturingRepository` over `ApiClient` covering all four owner endpoints. `FeaturingFailureKind` enum with 10 values (`disabled` / `unavailable` / `alreadyActive` / `paymentRequired` / `unauthenticated` / `forbidden` / `notFound` / `validation` / `network` / `other`) + `FeaturingFailure.fromApi` classifier translating each backend error code to a typed failure.
- **Screens**: `OwnerPromoteScreen` parallel-loads active + packages; renders not-featured / featured branches; tapping Purchase calls `subscribe` and surfaces success via SnackBar + header refresh; error states for FEATURING_DISABLED (full-page "Not yet available"), ALREADY_ACTIVE (inline banner), PAYMENT_REQUIRED (inline banner), and network / 5xx (retry banner). `OwnerFeaturingHistoryScreen` renders the newest-first list with status chips and PURCHASED / COMPED source chips; empty / network / error states match the rest of the owner-side surface.
- **Dashboard integration**: `OwnerDashboard` gains a Promote card between Profile and Services (`Icons.campaign`, label `l10n.ownerCardPromote`). `OwnerTab` threads a `featuringRepositoryOverride` test seam through to the dashboard.
- **Localization**: ARB key `ownerCardPromote` (English + Amharic) lands in both bundles.
- **Tests**: `featuring_repository_test.dart` (request shapes + 503-FEATURING_DISABLED / 503-ONLINE_PAYMENTS_UNAVAILABLE / 409 / 402 / 401 / 403 / 400 / 500 / 404 classification); `owner_promote_screen_test.dart` (loading / not-featured / featured / comp-badge / purchase-success / busy-spinner / disabled / already-active / payment-required / network states); `owner_featuring_history_screen_test.dart` (empty / populated / cancelled-reason / network); `owner_tab_test.dart` extended to assert the Promote card renders + navigates.

## Completed admin SPA

- **API client** (`admin/src/lib/api.ts`): `getAdminFeaturingHistory`, `compAdminFeaturing`, `cancelAdminFeaturing` helpers plus the full `FeaturingSubscriptionView` / `FeaturingSubscriptionListResponse` / `FeaturingPackageCode` / `FeaturingSubscriptionStatus` / `FeaturingSubscriptionSource` / `AdminCompFeaturingInput` / `AdminCancelFeaturingInput` type surface.
- **Business Detail page** (`admin/src/pages/BusinessDetailPage.tsx`): new `FeaturingHistoryPanel` mounted next to the existing manual `FeatureCard` for APPROVED businesses. The panel ships:
  - A TanStack-Query-backed table of every subscription newest-first with columns for status (colour-coded badge: ACTIVE green / PENDING_PAYMENT amber / EXPIRED grey / CANCELLED / REFUNDED red), source, packageCode, priceEtb, startsAt, endsAt, paymentIntentId (renders as "—" — the public OpenAPI schema doesn't carry the FK today; column ships for forward-compat), and cancelledReason.
  - Two admin actions: "Comp featuring" (`durationDays` 1–365 + required `reason`) and "Cancel active subscription" (required `reason`, disabled when no ACTIVE row exists).
  - Loading / error (with Try-again) / empty states wired through the same `ApiError` formatter the rest of the page uses.
  - Successful comp / cancel invalidates both `['adminFeaturingHistory', businessId]` (panel refresh) and `['adminBusinesses']` (parent metadata `featured_until` chip refresh).
- **Manual feature/unfeature card preserved.** The original `FeatureCard` (`POST /v1/admin/businesses/{id}/feature` with `{ featuredUntil, notes }`) still works alongside the new panel. It stays as the operator escape hatch for cases where a subscription row isn't desired (dev / staging smoke tests, one-off audit experiments). The two paths coexist; operators pick per-need.
- **No admin-side test setup yet.** `admin/package.json` has the `test` script stubbed for a follow-up commit. Manual QA covers the four scenarios captured in the runbook (empty business, comp-then-history-refresh, cancel-active-then-history-refresh, duplicate-ACTIVE 409).

## Remaining operator gates

These are the operator-led steps that gate the dev → staging → prod rollout. Each is one-shot per env.

1. **Flip `featuring_enabled = true`** in the target env's Terraform stack. Plan + apply. The runbook walks the apply step-by-step.
2. **Confirm `featuring_sweep_enabled = true`** in the EventBridge module of the same env stack. Dev already has this set; staging / prod need an explicit confirmation pass.
3. **Smoke-check** the deployed endpoints (`curl` packages as an authenticated owner; expect `200` with two packages).
4. **Pre-seed comp subscriptions for launch partners (optional)** via the admin SPA's `FeaturingHistoryPanel` before opening to owners. This populates the "Featured" sort with curated content before paid traffic exists.
5. **Owner mobile QA against the deployed env** via TestFlight / internal-track build. See the runbook's "Owner mobile QA" section for the exact steps.
6. **Admin SPA QA against the deployed env**. See the runbook's "Admin QA" section.
7. **Sweep Lambda QA** — manual invoke + EventBridge rule verification. The runbook's "Sweep Lambda QA" section captures the exact `aws lambda invoke` + `aws events describe-rule` commands.

## Deferred follow-ups

Tracked here so we don't lose them.

- **Real payment provider (Telebirr / Chapa).** The `PaymentGateway` abstraction is ready; what's missing is the concrete gateway implementation against a real Ethiopian provider's API, plus the rotation / secret-management story for its credentials. When this lands, `ONLINE_PAYMENTS_UNAVAILABLE` (503) becomes a real wire condition (the mobile client already handles it) and `PAYMENT_REQUIRED` (402) gains real-world meaning beyond the current CashGateway-always-succeeds shape. Estimate: 1–2 weeks of integration + secret-rotation work.
- **Receipt / invoice surface.** Owners can't currently print or email a receipt after a successful purchase. Audit lives in `featuring_subscriptions` + `payment_intents` for engineering / finance reconciliation only. Future scope: add a `GET /v1/businesses/{id}/featuring/subscriptions/{subId}/receipt` PDF endpoint plus an "Email receipt" button on the owner mobile featured-header.
- **Featuring revenue dashboard.** No operator dashboard summarises featuring revenue; operators query Postgres directly. Candidate views: revenue by month split by source (OWNER_PURCHASE vs ADMIN_COMP — comp revenue is intentionally zero), top-N businesses by purchased featuring days, average days-between-purchase per business, churn rate (purchased once vs. repeat). Lives as a new tab on the admin SPA over an admin-only `GET /v1/admin/featuring/revenue` summary endpoint.
- **Refund policy + UI.** Currently zero refund automation. Admins can `cancel` an ACTIVE subscription, which clears `featured_until`, but the on-chain cash transfer back to the owner is out-of-band. A real refund path needs (a) a `REFUNDED` terminal state on `featuring_subscriptions` (the column already exists in the enum — the service layer just doesn't write to it yet), (b) provider-side refund API integration once Telebirr lands, and (c) an admin-SPA "Refund subscription" button that records `cancelledReason` + emits an audit row.

## Next recommended workstream

Two viable next steps; pick based on Phase 9 stakeholder priority.

1. **`TelebirrGateway` (or `ChapaGateway`) — replace `MockOnlineGateway`.** The highest-impact follow-up. Closes the largest known gap in the paid-featuring surface, retires the `ONLINE_PAYMENTS_UNAVAILABLE` placeholder, and unblocks real revenue capture. Estimate: 1–2 weeks (gateway implementation + Secrets Manager rotation playbook + handler integration tests + a paired dev-smoke). Once it ships, the entire paid-featuring flow runs end-to-end against a real Ethiopian payment rail.
2. **Phase 9 completion summary.** If Track 6's paid-featuring is the last open commit on Phase 9's plan (alongside the open Track 4 / Track 5 operator gates tracked in their own summaries), author `docs/tasks/PHASE_9_COMPLETION_SUMMARY.md` to close the phase out and unblock the Phase 10 scoping conversation. Smaller commit, but it formally retires Phase 9 from the active-work list and surfaces the post-MVP backlog cleanly to whoever picks up Phase 10.

The runbook is the artefact that unblocks operator rollout in either path — both Telebirr integration and the Phase 9 completion summary can ship without touching the runbook again.
