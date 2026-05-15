# Phase 5 — Admin Dashboard

## Goal

Stand up the React + TypeScript admin dashboard, wire it to Cognito and the backend, and ship the admin write paths: approve/reject/suspend businesses, manage users, manage categories, view bookings, and manually feature listings.

## Scope

In scope:

- React + TypeScript app under `admin/` using Vite, React Router, and TanStack Query.
- Cognito login flow restricted to the `ADMIN` group (rejected at the UI for non-admins, also enforced by API).
- DB migration for `admin_actions` audit log.
- Backend endpoints:
  - `GET /v1/admin/businesses`, `POST /v1/admin/businesses/:id/{approve,reject,suspend,feature}`
  - `GET /v1/admin/users`, `POST /v1/admin/users/:id/{suspend,restore}`
  - `POST /v1/admin/categories`, `PATCH /v1/admin/categories/:id`, `DELETE /v1/admin/categories/:id`
  - `GET /v1/admin/appointments`
- Audit log writes on every admin write action.
- Basic UI screens: login, businesses list/detail, users list/detail, categories, bookings list, dashboard home with counts.

Out of scope:

- Multi-admin roles or fine-grained admin permissions — `ADMIN` is binary in MVP.
- Internationalization — admin dashboard is English-only and not yet structured for Amharic.

## Files involved

- `backend/db/migrations/0012_admin_actions.sql`
- `backend/shared/domains/admin/*`
- `backend/lambdas/admin/businesses/*`
- `backend/lambdas/admin/users/*`
- `backend/lambdas/admin/categories/*`
- `backend/lambdas/admin/appointments/list.ts`
- `admin/package.json`, `admin/vite.config.ts`, `admin/tsconfig.json`, `admin/index.html`
- `admin/src/main.tsx`, `admin/src/App.tsx`
- `admin/src/lib/api.ts`, `admin/src/lib/auth.ts`
- `admin/src/pages/{Login,Dashboard,Businesses,BusinessDetail,Users,Categories,Bookings}.tsx`
- `admin/src/components/*`

## Checklist

- [ ] Migration 0012 applied.<!-- `0012_admin_actions.sql` authored: append-only audit log (no updated_at / deleted_at / no UPDATE or DELETE paths), `admin_user_id` FK ON DELETE RESTRICT, no CHECK on `action` (app layer owns the enum), polymorphic `target_id uuid NOT NULL` paired with `target_type`. Indexes on `(admin_user_id, created_at DESC)` and `(target_type, target_id, created_at DESC)` back the two documented read paths. "Applied" needs `npm run db:migrate` locally and `terraform apply` + RDS-side run for AWS-hosted dev (Phase 7). -->
- [ ] All admin write endpoints persist an `admin_actions` row.<!-- Repository in place: `backend/shared/domains/admin/adminActionRepository.ts` exposes `insert` + `listByAdmin` + `listForTarget` only (append-only, no `update` / `delete`). `AdminAction` and `AdminTargetType` unions are application-layer enums — additive contract; no DB CHECK. View module (`adminActionView.ts`) returns JSON with ISO-8601 timestamps. All three admin write services wired (`AdminBusinessService`, `AdminUserService`, `AdminCategoryService`). HTTP handlers wired for every Phase 5 admin endpoint: businesses (5 ops), users (3 ops), categories (4 ops including DELETE-as-deactivate), appointments (1 read-only listing). The read-only appointments endpoint records no audit row — only writes do. -->
- [x] React app initialized; routes set up; protected routes redirect to `/login` if not in `ADMIN` group.<!-- Scaffolded under `admin/` (Vite + React + TypeScript + React Router + TanStack Query). `App.tsx` declares three route groups: `/login`, a protected layout wrapping `AdminLayout` + `<Outlet />`, and a catch-all → `/`. `ProtectedRoute` reads `useAdminSession()` and redirects to `/login` if absent or if `cognito:groups` doesn't include `ADMIN`. Dashboard wired against `GET /v1/admin/businesses?status=PENDING_REVIEW`; the remaining pages (Businesses / Users / Categories / Bookings) are follow-up commits. -->
- [x] Login uses Cognito hosted UI or AWS Amplify Auth.<!-- Cognito hosted UI with PKCE — no Amplify dependency. `admin/src/lib/auth.ts` implements the full flow: `redirectToHostedUI()` generates the PKCE pair and navigates to `${VITE_COGNITO_DOMAIN}/oauth2/authorize?...`; `handleCallbackCode()` exchanges the code at `/oauth2/token` and stores the resulting session in `sessionStorage` keyed by `ethiolink.adminSession`; `signOut()` clears local state and hits Cognito's `/logout`. The `LoginPage` guards against React Strict-Mode double-mount via a `useRef` so the one-shot authorization code is exchanged exactly once. Required env vars: `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_ADMIN_CLIENT_ID`, `VITE_ADMIN_REDIRECT_URI`, `VITE_API_BASE_URL`. -->
- [x] Businesses page: filter by status, click into detail, approve/reject/suspend.<!-- React UI shipped: `admin/src/pages/BusinessesPage.tsx` (status-filter dropdown defaulting to PENDING_REVIEW, table of rows with name / city / status badge / rating / created-date, row click → `/businesses/:id`) + `admin/src/pages/BusinessDetailPage.tsx` (status-aware action cards for approve / reject + notes / suspend + notes / feature + datetime + notes / unfeature). `admin/src/lib/api.ts` extended with `approveBusiness` / `rejectBusiness` / `suspendBusiness` / `featureBusiness` / `unfeatureBusiness`. Mutations invalidate `['adminBusinesses']` on success; errors render the typed `ApiError.code`/`message` inline. Backend was already in place from the earlier handler commits. -->
- [x] Categories page: CRUD.<!-- React UI shipped: `admin/src/pages/CategoriesPage.tsx` — single-page CRUD with `All / Active only / Inactive only` filter, "New category" form (slug + name.en + optional name.am + optional sortOrder), table of categories with per-row Edit (inline form replaces the row) and Deactivate buttons (active rows only; native `window.confirm` for the destructive action). Reactivation is deliberately not exposed — backend has no path. `admin/src/lib/api.ts` extended with `listAdminCategories` / `createCategory` / `patchCategory` / `deactivateCategory`. Backend `AdminCategoryInvalidInputError`'s `details.field` surfaces inline under the rejected input ("slug must be 64 characters or fewer", "name.en must not be empty", etc.); non-field errors render below the action button. Mutations invalidate `['adminCategories']` on success. -->
- [x] Featuring a business sets `featured_until` to a chosen date.<!-- End-to-end: `AdminBusinessService.setFeaturedUntil` (service-layer guard on APPROVED-only, audit rows distinguish FEATURE vs UNFEATURE), `POST /v1/admin/businesses/{id}/feature` handler with required-and-nullable `featuredUntil` body, and the React `FeatureCard` in `BusinessDetailPage.tsx` (datetime-local picker, default 2 weeks ahead, separate Feature / Unfeature buttons when already featured). -->

## Acceptance criteria

- A non-admin attempting to sign in to the admin app is rejected at the UI with a clear message.
- All admin write actions appear in `admin_actions` with the correct `action`, `target_type`, `target_id`, and `admin_user_id`.
- Approving a PENDING_REVIEW business makes it visible on the public listing endpoint.
- Admin dashboard builds with `npm run build` and serves with `npm run preview`.

## Test plan

- Backend unit: admin services (approve, reject, suspend) state-transition rules.<!-- `adminBusinessService.test.ts` shipped: happy paths for approve / reject / suspend (APPROVED + PENDING_REVIEW) / setFeaturedUntil (feature + unfeature); non-ADMIN refused (`AdminForbiddenError`); missing business (`AdminBusinessNotFoundError`); invalid-transition matrix; audit-row contract — exactly one row per success with the right `adminUserId`/`action`/`targetType`/`targetId`/`notes`, zero rows on failure. `adminUserService` + `adminCategoryService` test files are the next test commits. -->
- Frontend unit: route guards, API client error handling.
- Manual: log in as ADMIN, approve a pending business, see it appear on the public listing endpoint.

### Phase 5 React pages landed so far

- `AdminLayout` — top bar (brand + email + sign-out) plus a secondary nav row of `NavLink`s for Dashboard / Businesses / Categories / Users / Bookings. Active route renders with a coloured background; `end: true` on the Dashboard link prevents `/` from matching every nested route.
- `LoginPage` — Cognito hosted-UI redirect + PKCE callback handling.
- `DashboardPage` — two-card landing page: a Pending-review tile (the whole card is a link into `/businesses`) and a Shortcuts panel linking to Categories / Users / Bookings. Adapts the original single-tile design now that nav is in place.
- `BusinessesPage` + `BusinessDetailPage` — status-filtered list + per-row approve / reject / suspend / feature / unfeature with optional notes.
- `CategoriesPage` — single-page CRUD with isActive filter, create form, per-row Edit / Deactivate. Field-level errors via `details.field`.
- `UsersPage` — status + role filters, per-row Suspend (ACTIVE only) / Restore (SUSPENDED only); DELETED rows show no action. Optional notes captured via `window.prompt`.
- `AppointmentsPage` — read-only cross-business listing. Five filters (status, businessId, customerId, from, to) using `<input type="datetime-local">` for the date inputs (local → UTC via `.toISOString()` in the API helper). Table renders short-UUID columns with `title` tooltips for the full id, locale-formatted dates, status / payment badges, and ETB price. Caps at 100 rows with an inline hint when the cap is hit.

### Phase 5 unit-test coverage landed so far

- `adminBusinessService.test.ts` — happy paths for approve / reject / suspend (APPROVED + PENDING_REVIEW) / setFeaturedUntil (feature + unfeature), each verifying both the mutation and the audit-row contents (adminUserId / action / targetType / targetId / notes). Authorization matrix over CUSTOMER + BUSINESS_OWNER callers for every method. Not-found (`AdminBusinessNotFoundError`). Invalid-transition matrix (approve / reject / suspend / feature / unfeature from every wrong fromStatus). Audit-row invariant: exactly one row per successful action, zero rows when validation fails before any mutation. Uses `InMemoryBusinessRepository` (already widened with `setFeaturedUntil`) + new `InMemoryAdminActionRepository` (append-only, with `size` / `all` / `rowsForTarget` / `rowsByAdmin` test helpers).
- `adminUserService.test.ts` — happy paths for suspendUser (ACTIVE → SUSPENDED) and restoreUser (SUSPENDED → ACTIVE), each with `notes` set + null, audit-row contents asserted in full. DELETED is terminal — both methods refuse with `AdminUserInvalidTransitionError` carrying the right `fromStatus` and `attemptedAction`. Authorization matrix over CUSTOMER + BUSINESS_OWNER callers (the mutation is verified to not happen). Missing user → `AdminUserNotFoundError`. Same audit invariant — one row per success (with per-admin attribution across a two-action sequence), zero rows on failure. Reuses `InMemoryUserRepository` unchanged (users seeded via `upsertFromAuth` + optional `setStatus`).
- `adminCategoryService.test.ts` — happy paths for createCategory (slug trim, sortOrder default, audit contents), updateCategory (single-field + multi-field + no-op-empty-patch-still-records-audit), and deactivateCategory (flips isActive, audit row). Duplicate-slug pre-check on both create (existing row owns the slug) and update (another row owns the slug, with the self-keep-own-slug case asserted not-collide). Missing category → `AdminCategoryNotFoundError`. Authorization matrix over CUSTOMER + BUSINESS_OWNER callers for all three methods. Service-level input validation parameterized over 16 bad-input cases (empty / whitespace / non-string / oversized slug; non-object / null / array / missing-en / non-string-en / empty-en / whitespace-en / oversized-en name; negative / non-integer / NaN / non-number sortOrder) — each asserts the right `AdminCategoryInvalidInputError.field`. Deactivate-already-inactive refused with `AdminCategoryInvalidTransitionError(attemptedAction, currentIsActive=false)`. Audit invariant: three-action sequence verifies per-admin attribution; five-failure-mode test verifies zero rows on every guard rejection.

## Rollback notes

- Migration forward-only.
- Admin frontend is shipped as a static SPA; rollback is redeploying the prior bundle.
- If a faulty approval misclassifies businesses, admin can use the suspend action to remove from public listings without a code rollback.

## Verification notes (Phase 5 audit, 2026-05-15)

Captured during the Phase 5 backend verification pass. None block ticking the remaining checklist items (gated on the React app + Phase 7 RDS); each is worth addressing in the appropriate later phase.

- **Admin mutation + audit insert are sequential, not transactional.** Each of `AdminBusinessService` / `AdminUserService` / `AdminCategoryService` runs the domain mutation first and the `admin_actions.insert` second, as two independent statements. Between them, the row is committed but the audit row hasn't landed — a vanishingly small window in MVP, but a real correctness gap if the audit insert fails after a successful mutation. The canonical fix is `withTransaction` from `pgClient.ts` threading a `PoolClient` through both repos; the same pattern is also deferred for the review-insert + rating-recompute flow (see `PHASE_4_BOOKING.md` verification notes). The follow-up commit converts every admin service + the review service in one pass.

- **React admin app still pending.** Every Phase 5 backend endpoint is wired (business / user / category writes + cross-business appointment read = 13 operations under the new `admin` OpenAPI tag). The dashboard UI under `admin/` is the last Phase 5 deliverable — login flow, route guards, business/user/category/bookings pages — and lands as a separate commit set. The four UI-side checklist items (React init, Cognito login, Businesses page, Categories page) remain unticked until that work lands.

- **AWS-hosted dev migrations still wait for Phase 7.** Migration 0012 (`admin_actions`) has been applied locally against docker-compose Postgres; the AWS-hosted dev RDS apply is blocked on the Phase 7 Terraform module that provisions RDS. Same gate as 0009–0011 from Phase 4 — see [`PHASE_4_MIGRATION_RUN.md`](./PHASE_4_MIGRATION_RUN.md) for the "remote dev RDS" addendum that explains the env-var override flow once RDS is up.

- **Admin write paths on services / staff / availability are still owner-only.** `API_SPEC.md` lists those endpoints as "owner or ADMIN" but the Phase 3 services / staff / availability services enforce strict-owner — flagged in the Phase 3 verification notes and again in the Phase 4 completion summary's "follow-ups". Relaxing each is a one-line change inside the per-service ownership helper (`caller.userId === existing.ownerUserId || caller.role === 'ADMIN'`). Deliberately deferred so the React admin app can ship first against the actual admin-only surface; the relaxation lands once that's wired and the dashboard's "edit this business's services on the owner's behalf" flow needs the path open.

- **Reject reason persistence still pending** (carried over from Phase 4). `appointments` has no `reject_reason` column; the appointment reject handler logs it but doesn't persist. For Phase 5 business rejections the situation is different and **fully handled** — `REJECT_BUSINESS` audit rows carry the rejection reason in `admin_actions.notes`, which is the canonical store. The dashboard reads the most-recent `REJECT_BUSINESS` row's `notes` to render "why rejected" inline with the business.

- **`AdminAction` and `AdminTargetType` are application-layer enums, not DB CHECKs.** Migration 0012's `admin_actions.action` is an unconstrained `text`. Adding a new admin action ships as a code-only change (extend the union in `adminActionRepository.ts`). The contract documented in that file: "additive — extend by appending new variants, never rename or remove. Removing would break deserialization of historical rows."

- **No cursor pagination on any admin listing in MVP.** All four admin reads (`/admin/businesses`, `/admin/users`, `/admin/categories`, `/admin/appointments`) cap rows by `limit` (default 50–100) but don't expose `nextCursor`. Admin volume in MVP is small; the cursor codec already exists in `shared/http/pagination.ts` if a future audit dashboard surfaces a busy-business case.

- **Phase 5 backend unit-test coverage is complete.** Three test files (`adminBusinessService` / `adminUserService` / `adminCategoryService`) plus the in-memory fakes (`InMemoryAdminActionRepository`, plus widened `InMemoryBusinessRepository` / `InMemoryUserRepository` / `InMemoryCategoryRepository`) cover every documented invariant: state-transition matrix, authorization matrix, not-found, invalid-input matrix (categories), slug-uniqueness pre-check (categories on create + cross-row on update), and the universal audit-row invariant (exactly one row per success, zero on failure, correct payload). `npm test` passes locally as of 2026-05-15.
