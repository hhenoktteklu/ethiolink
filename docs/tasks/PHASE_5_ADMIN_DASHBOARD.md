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
- [ ] React app initialized; routes set up; protected routes redirect to `/login` if not in `ADMIN` group.
- [ ] Login uses Cognito hosted UI or AWS Amplify Auth.
- [ ] Businesses page: filter by status, click into detail, approve/reject/suspend.<!-- Backend endpoints wired: `GET /v1/admin/businesses` (status filter, limit 1..100 default 50) + `POST /v1/admin/businesses/{id}/{approve,reject,suspend,feature}`. Shared `lambdas/admin/_authz.ts` factors the ADMIN-role + user-sync preflight; each action handler maps `AdminForbiddenError` → 403, `AdminBusinessNotFoundError` → 404, `AdminBusinessInvalidTransitionError` → 409. `BusinessRepository.listForAdmin` extension added (interface + Pg + in-memory fake). OpenAPI: 5 new ops under a new `admin` tag, plus schemas `BusinessOwnerList` / `AdminNotesRequest` / `AdminFeatureRequest`. Dashboard UI lands with the React app. -->
- [ ] Categories page: CRUD.<!-- Backend wired end-to-end: `GET /v1/admin/categories` (isActive filter), `POST /v1/admin/categories`, `PATCH /v1/admin/categories/{id}`, `DELETE /v1/admin/categories/{id}` (soft-delete). `CategoryRepository.listForAdmin(filters, limit)` extension + `AdminCategoryView` projection (extends `CategoryView` with `isActive`). OpenAPI: 4 ops + `AdminCategoryView` / `AdminCategoryList` / `AdminCreateCategoryRequest` / `AdminPatchCategoryRequest` schemas. Slug uniqueness errors map to 409; service-level input errors map to 400 with `details.field`. Dashboard UI lands with the React app. -->
- [ ] Featuring a business sets `featured_until` to a chosen date.<!-- Service-layer in place: `AdminBusinessService.setFeaturedUntil(id, caller, featuredUntil | null, notes?)` writes the column via the new `BusinessRepository.setFeaturedUntil` mutation path (interface + Pg impl + in-memory fake all extended), rejects non-APPROVED targets with `AdminBusinessInvalidTransitionError`, and emits `FEATURE_BUSINESS` / `UNFEATURE_BUSINESS` audit rows. Lambda handler + dashboard UI land in subsequent commits. -->

## Acceptance criteria

- A non-admin attempting to sign in to the admin app is rejected at the UI with a clear message.
- All admin write actions appear in `admin_actions` with the correct `action`, `target_type`, `target_id`, and `admin_user_id`.
- Approving a PENDING_REVIEW business makes it visible on the public listing endpoint.
- Admin dashboard builds with `npm run build` and serves with `npm run preview`.

## Test plan

- Backend unit: admin services (approve, reject, suspend) state-transition rules.<!-- `adminBusinessService.test.ts` shipped: happy paths for approve / reject / suspend (APPROVED + PENDING_REVIEW) / setFeaturedUntil (feature + unfeature); non-ADMIN refused (`AdminForbiddenError`); missing business (`AdminBusinessNotFoundError`); invalid-transition matrix; audit-row contract — exactly one row per success with the right `adminUserId`/`action`/`targetType`/`targetId`/`notes`, zero rows on failure. `adminUserService` + `adminCategoryService` test files are the next test commits. -->
- Frontend unit: route guards, API client error handling.
- Manual: log in as ADMIN, approve a pending business, see it appear on the public listing endpoint.

### Phase 5 unit-test coverage landed so far

- `adminBusinessService.test.ts` — happy paths for approve / reject / suspend (APPROVED + PENDING_REVIEW) / setFeaturedUntil (feature + unfeature), each verifying both the mutation and the audit-row contents (adminUserId / action / targetType / targetId / notes). Authorization matrix over CUSTOMER + BUSINESS_OWNER callers for every method. Not-found (`AdminBusinessNotFoundError`). Invalid-transition matrix (approve / reject / suspend / feature / unfeature from every wrong fromStatus). Audit-row invariant: exactly one row per successful action, zero rows when validation fails before any mutation. Uses `InMemoryBusinessRepository` (already widened with `setFeaturedUntil`) + new `InMemoryAdminActionRepository` (append-only, with `size` / `all` / `rowsForTarget` / `rowsByAdmin` test helpers).
- `adminUserService.test.ts` — happy paths for suspendUser (ACTIVE → SUSPENDED) and restoreUser (SUSPENDED → ACTIVE), each with `notes` set + null, audit-row contents asserted in full. DELETED is terminal — both methods refuse with `AdminUserInvalidTransitionError` carrying the right `fromStatus` and `attemptedAction`. Authorization matrix over CUSTOMER + BUSINESS_OWNER callers (the mutation is verified to not happen). Missing user → `AdminUserNotFoundError`. Same audit invariant — one row per success (with per-admin attribution across a two-action sequence), zero rows on failure. Reuses `InMemoryUserRepository` unchanged (users seeded via `upsertFromAuth` + optional `setStatus`).
- `adminCategoryService.test.ts` — happy paths for createCategory (slug trim, sortOrder default, audit contents), updateCategory (single-field + multi-field + no-op-empty-patch-still-records-audit), and deactivateCategory (flips isActive, audit row). Duplicate-slug pre-check on both create (existing row owns the slug) and update (another row owns the slug, with the self-keep-own-slug case asserted not-collide). Missing category → `AdminCategoryNotFoundError`. Authorization matrix over CUSTOMER + BUSINESS_OWNER callers for all three methods. Service-level input validation parameterized over 16 bad-input cases (empty / whitespace / non-string / oversized slug; non-object / null / array / missing-en / non-string-en / empty-en / whitespace-en / oversized-en name; negative / non-integer / NaN / non-number sortOrder) — each asserts the right `AdminCategoryInvalidInputError.field`. Deactivate-already-inactive refused with `AdminCategoryInvalidTransitionError(attemptedAction, currentIsActive=false)`. Audit invariant: three-action sequence verifies per-admin attribution; five-failure-mode test verifies zero rows on every guard rejection.

## Rollback notes

- Migration forward-only.
- Admin frontend is shipped as a static SPA; rollback is redeploying the prior bundle.
- If a faulty approval misclassifies businesses, admin can use the suspend action to remove from public listings without a code rollback.
