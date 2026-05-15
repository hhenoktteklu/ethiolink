# Phase 5 — Completion Summary

End of Phase 5 (Admin Dashboard). Every backend endpoint and React page is in place; `npm test` is green; migration 0012 is applied locally. Three remaining items are gated on Phase 7 deploy work, none on Phase 5 code.

Authoritative scope and checklist live in [`PHASE_5_ADMIN_DASHBOARD.md`](./PHASE_5_ADMIN_DASHBOARD.md). This file is the at-a-glance status read on 2026-05-15.

## Completed backend features

**Admin action audit log (migration 0012)**
- `admin_actions` table — append-only audit log, `admin_user_id` FK ON DELETE RESTRICT, no CHECK on `action` (application-layer enum), polymorphic `target_id uuid NOT NULL` paired with `target_type`. Two indexes on `(admin_user_id, created_at DESC)` and `(target_type, target_id, created_at DESC)` back the two documented read paths.
- `PgAdminActionRepository` exposes `insert` / `listByAdmin` / `listForTarget` only — no `update`, no `delete`. The whole-row append-only design is enforced both at the SQL layer (no mutation columns) and at the TypeScript layer (no mutation methods on the interface).
- `AdminAction` and `AdminTargetType` are application-layer unions documented as **additive**: extend, never rename or remove.

**Admin services**
- `AdminBusinessService` — `approveBusiness`, `rejectBusiness`, `suspendBusiness`, `setFeaturedUntil`. Status rules enforced (PENDING_REVIEW for approve/reject; APPROVED *or* PENDING_REVIEW for suspend; APPROVED-only for feature/unfeature). Each success writes exactly one audit row; failures write none. Typed errors: `AdminForbiddenError`, `AdminBusinessNotFoundError`, `AdminBusinessInvalidTransitionError`.
- `AdminUserService` — `suspendUser` (ACTIVE → SUSPENDED), `restoreUser` (SUSPENDED → ACTIVE). `DELETED` is terminal — both methods refuse. Typed errors: `AdminUserNotFoundError`, `AdminUserInvalidTransitionError`.
- `AdminCategoryService` — `createCategory`, `updateCategory`, `deactivateCategory`. Slug uniqueness enforced via pre-check + SQLSTATE 23505 race-loss translation. Service-level input validation across slug / name.en / name.am / sortOrder. Typed errors: `AdminCategoryNotFoundError`, `AdminCategoryInvalidInputError(field)`, `AdminCategorySlugTakenError`, `AdminCategoryInvalidTransitionError`.

**Admin HTTP endpoints (13 operations under the new `admin` OpenAPI tag)**
- Shared `lambdas/admin/_authz.ts` — single preflight that extracts the Cognito principal, refuses non-ADMIN roles, and resolves to internal `users.id`. Returns a tagged-union `AdminAuthorizationResult`.
- Businesses: `GET /v1/admin/businesses` + `POST /v1/admin/businesses/{id}/{approve,reject,suspend,feature}` (5 ops).
- Users: `GET /v1/admin/users` + `POST /v1/admin/users/{id}/{suspend,restore}` (3 ops).
- Categories: `GET /v1/admin/categories` + `POST /v1/admin/categories` + `PATCH /v1/admin/categories/{id}` + `DELETE /v1/admin/categories/{id}` (4 ops — DELETE is soft-delete, flips `is_active` to false).
- Appointments: `GET /v1/admin/appointments` — read-only cross-business listing with five filters (1 op).
- Every write maps the service's typed errors to the documented HTTP codes: `AdminForbiddenError` → 403, `*NotFoundError` → 404, `*InvalidTransitionError` → 409, `AdminCategoryInvalidInputError` → 400 with `details.field`, `AdminCategorySlugTakenError` → 409.

## Completed React admin dashboard features

**Scaffolding** (Vite + React + TypeScript + React Router + TanStack Query)
- `admin/package.json` / `admin/vite.config.ts` / `admin/tsconfig.json` / `admin/index.html` / `admin/src/main.tsx`.
- Required env vars documented: `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_ADMIN_CLIENT_ID`, `VITE_ADMIN_REDIRECT_URI`, `VITE_API_BASE_URL`.

**Auth** (`admin/src/lib/auth.ts`)
- Cognito hosted UI with PKCE — no Amplify dependency. `redirectToHostedUI()` generates the verifier + S256 challenge and navigates to `/oauth2/authorize`; `handleCallbackCode(code)` exchanges at `/oauth2/token` and stores the session in `sessionStorage`; `signOut()` clears local state and hits Cognito's `/logout`.
- `useAdminSession()` hook with cross-tab `storage`-event listener so sign-out in one tab propagates.
- `isAdmin(session)` checks `cognito:groups` includes `'ADMIN'` — the UI gate that complements the server-side authorizer.

**Pages** (under `admin/src/pages/`)
- `LoginPage` — sign-in button + `?code=...` callback handling. Strict-Mode double-mount guarded via `useRef`.
- `DashboardPage` — two-card landing: Pending-review tile (whole card is a link to `/businesses`) + Shortcuts panel.
- `BusinessesPage` + `BusinessDetailPage` — status-filtered list table + per-row navigation to the detail page; detail page has status-aware approve / reject / suspend / feature / unfeature cards with optional notes.
- `CategoriesPage` — single-page CRUD with isActive filter, create form, per-row Edit (inline form) and Deactivate. `AdminCategoryInvalidInputError.details.field` is wired to inline field-level error messages.
- `UsersPage` — status + role filters, per-row Suspend / Restore with optional notes captured via `window.prompt`. DELETED rows show no action.
- `AppointmentsPage` — read-only cross-business listing with five filters (status, businessId, customerId, from, to) using `<input type="datetime-local">` for date pickers. Short-UUID cells with hover-full-UUID `title` attributes.

**Navigation** (`admin/src/components/AdminLayout.tsx`)
- Top bar: brand + email + sign-out. Secondary nav row with `NavLink`s for the five pages; active route renders with a coloured background. `end: true` on the Dashboard link prevents prefix-match against every nested route.

**API client** (`admin/src/lib/api.ts`)
- Typed `ApiError(status, code, message, details)` with `details.field` exposed for inline form errors.
- One helper per admin endpoint the dashboard actually calls — 12 total: `listAdminBusinesses`, `approveBusiness`, `rejectBusiness`, `suspendBusiness`, `featureBusiness`, `unfeatureBusiness`, `listAdminCategories`, `createCategory`, `patchCategory`, `deactivateCategory`, `listAdminUsers`, `suspendUser`, `restoreUser`, `listAdminAppointments`. Each attaches the Cognito `id_token` as `Authorization: Bearer …` automatically.

## Migrations applied locally

| Migration                       | Highlights                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `0012_admin_actions.sql`        | Append-only audit log (no `updated_at` / `deleted_at`), `admin_user_id` FK ON DELETE RESTRICT, no CHECK on `action`, two listing indexes. |

Applied on 2026-05-15 via `npm run db:migrate` against docker-compose Postgres; `schema_migrations` shows the row. The AWS-hosted dev RDS apply is gated on Phase 7's Terraform RDS module (same gate as 0009–0011 from Phase 4 — see [`PHASE_4_MIGRATION_RUN.md`](./PHASE_4_MIGRATION_RUN.md) for the remote-RDS env-var pattern that will apply unchanged once RDS is up).

## Tests passing locally

`npm test` exercises 17 test files and passes locally as of 2026-05-15.

| Phase 5 test file                                       | Coverage                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/admin/adminBusinessService.test.ts`              | approve / reject / suspend (both APPROVED + PENDING_REVIEW) / setFeaturedUntil (feature + unfeature) happy paths with audit-row contents; non-ADMIN refused; missing business; invalid-transition matrix; audit invariant (one row per success, zero on failure).                                                       |
| `tests/admin/adminUserService.test.ts`                  | suspend / restore happy paths with audit-row contents; DELETED is terminal for both; non-ADMIN refused; missing user; per-admin attribution; audit invariant.                                                                                                                                                          |
| `tests/admin/adminCategoryService.test.ts`              | create / update / deactivate happy paths; duplicate-slug pre-check on create + cross-row on update + self-keep-own-slug case; no-op-empty-patch records audit; 16-case invalid-input matrix asserting `details.field`; `DEACTIVATE_CATEGORY` refused on already-inactive rows; audit invariant.                          |
| `tests/_fakes/InMemoryAdminActionRepository.ts`         | Append-only fake mirroring `PgAdminActionRepository`. Test helpers `size` / `all` / `rowsForTarget` / `rowsByAdmin`. Shared by all three admin service tests.                                                                                                                                                            |

Existing Phase 1–4 test files (14 of them) still pass — no regressions during the Phase 5 work. The staff-ordering test fix from commit `f7fcbbc` keeps the suite deterministic.

## Remaining Phase 7 deploy gates

None of these block Phase 5 completion; each closes as part of the Phase 7 deploy pipeline.

- **Migration 0012 applied to the AWS-hosted dev RDS.** Same gate as 0009–0011: today's `infra/terraform/environments/dev/main.tf` provisions only Cognito. The `module "rds"` block lands in Phase 7; once that's `terraform apply`-ed, `npm run db:migrate` runs against the RDS endpoint with the `PG_*` env vars set (the runbook in `PHASE_4_MIGRATION_RUN.md` covers the exact env-var pattern).
- **Cognito admin app client `callback_urls` / `logout_urls`.** The admin app's `VITE_ADMIN_REDIRECT_URI` (`http://localhost:5173/login` in dev, `https://admin.ethiolink.app/login` in prod) needs to be registered on the Cognito app client — a Terraform Cognito-module update. Without it, the hosted-UI redirect is rejected by Cognito.
- **Admin frontend deploy pipeline.** `admin/` builds with `tsc --noEmit && vite build` to `admin/dist/`. The Phase 7 deploy module wires that output to S3 + CloudFront (or similar static-hosting target). Until then the admin app runs only on `npm run dev` locally.

## Known follow-ups

Non-blocking design tightening or polish items called out during the Phase 5 audits. Each is small and self-contained; none gate Phase 6.

- **`withTransaction` for admin mutation + audit-row insert.** Every admin service (`AdminBusinessService`, `AdminUserService`, `AdminCategoryService`) runs the domain mutation and the `admin_actions.insert` as two sequential statements. A small window exists where the mutation commits but the audit row never lands. The canonical fix threads a `PoolClient` through both repos via `withTransaction` from `backend/shared/db/pgClient.ts`. The same pattern is also deferred for the review-insert + rating-recompute flow (see `PHASE_4_BOOKING.md` verification notes). One follow-up commit can convert every admin service + the review service in a single pass.
- **Admin write relaxation for services / staff / availability.** `API_SPEC.md` lists those endpoints as "owner or ADMIN" but the Phase 3 services / staff / availability services enforce strict-owner. Relaxing each is a one-line change inside the per-service ownership helper (`caller.userId === existing.ownerUserId || caller.role === 'ADMIN'`). Deferred so the React admin app could ship first against the actual admin-only surface; the relaxation lands when the dashboard surfaces "edit this business's services on the owner's behalf" flows.
- **Cursor pagination on admin listings.** All four admin reads (`/admin/businesses`, `/admin/users`, `/admin/categories`, `/admin/appointments`) cap rows by `limit` (default 50–100) but don't expose `nextCursor`. The cursor codec already exists in `shared/http/pagination.ts` (extracted in Phase 3). When a busy marketplace surfaces a >100-row admin queue, the change is per-endpoint and bounded.
- **Custom modals instead of `window.confirm` / `window.prompt`.** Categories' Deactivate uses `window.confirm`; Users' Suspend / Restore use `window.prompt` for the optional notes. Native dialogs are functional but visually inconsistent with the rest of the app. A small `<ConfirmDialog>` + `<NotesDialog>` component would replace both. Polish, not correctness.
- **Cognito redirect-back-to-original-page polish.** `ProtectedRoute` already passes `state={{ from: location }}` when redirecting to `/login`, but `LoginPage` always navigates to `/` after sign-in. Reading `state.from` and navigating there on success closes the loop — useful when a deep link (e.g. a bookmarked business-detail URL) needs the admin to re-authenticate.
- **Single-row admin business detail endpoint.** `BusinessDetailPage` fetches the unfiltered list (`limit: 100`) and finds the row by id. Acceptable for MVP marketplace size; if a busier era pushes the admin queue past 100, a `GET /v1/admin/businesses/{id}` endpoint becomes worthwhile. The Lambda is a thin wrapper around `BusinessRepository.findById`; the page swaps `useQuery(['adminBusinesses'])` for `useQuery(['adminBusiness', id])` in one fetch-call change.

## Next recommended phase

**Phase 6 — Notifications.** The customer / business communication layer (SMS, email, Telegram) is the natural next block. Booking confirmations, accept/reject notifications, and cancellation receipts all depend on Phase 4's appointment flow being live, which it is. Phase 5 admin notifications (new pending review, etc.) reuse the same notification adapter.

The Phase 6 doc (`PHASE_6_NOTIFICATIONS.md`) already exists and scopes a `NotificationsService` behind a `NotificationProvider` adapter port — `MockNotificationProvider` in MVP, real Ethiopian SMS / Telegram providers as a separate phase. Schema lands as migration 0013 (`notification_logs`).

**Alternative — Phase 7 (AWS Deployment).** If a stakeholder demo on a real AWS environment is the more pressing need, jumping straight to Phase 7 closes the three Phase 5 deploy gates above as a side effect. Phase 6 then follows once the platform is reachable end-to-end. Either order is defensible — the question is which gate the next milestone wants on its critical path: more functionality (Phase 6 first) or more demoability (Phase 7 first).

Phase 8 (Production Hardening) sits naturally after both — security review, performance tuning, monitoring depth, runbooks for on-call.
