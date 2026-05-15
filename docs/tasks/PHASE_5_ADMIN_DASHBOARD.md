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
- [ ] All admin write endpoints persist an `admin_actions` row.<!-- Repository in place: `backend/shared/domains/admin/adminActionRepository.ts` exposes `insert` + `listByAdmin` + `listForTarget` only (append-only, no `update` / `delete`). `AdminAction` and `AdminTargetType` unions are application-layer enums — additive contract; no DB CHECK. View module (`adminActionView.ts`) returns JSON with ISO-8601 timestamps. All three admin write services now wired: `AdminBusinessService` (approve / reject / suspend / setFeaturedUntil), `AdminUserService` (suspend / restore), `AdminCategoryService` (create / update / deactivate). Each records exactly one audit row per success and none on failure. Lambda handler wiring is the next code commit. -->
- [ ] React app initialized; routes set up; protected routes redirect to `/login` if not in `ADMIN` group.
- [ ] Login uses Cognito hosted UI or AWS Amplify Auth.
- [ ] Businesses page: filter by status, click into detail, approve/reject/suspend.
- [ ] Categories page: CRUD.<!-- Service-layer in place: `AdminCategoryService.createCategory` / `.updateCategory` / `.deactivateCategory`. `CategoryRepository` now has `insert` / `update` / `setIsActive` (interface + Pg impl + in-memory fake with `PgUniqueViolationError` simulation). Slug uniqueness enforced via pre-check + SQLSTATE 23505 race-loss translation to `AdminCategorySlugTakenError`. Service-level input guards on slug / name.en / sortOrder via `AdminCategoryInvalidInputError`. Lambda handlers + dashboard UI are the next commits. -->
- [ ] Featuring a business sets `featured_until` to a chosen date.<!-- Service-layer in place: `AdminBusinessService.setFeaturedUntil(id, caller, featuredUntil | null, notes?)` writes the column via the new `BusinessRepository.setFeaturedUntil` mutation path (interface + Pg impl + in-memory fake all extended), rejects non-APPROVED targets with `AdminBusinessInvalidTransitionError`, and emits `FEATURE_BUSINESS` / `UNFEATURE_BUSINESS` audit rows. Lambda handler + dashboard UI land in subsequent commits. -->

## Acceptance criteria

- A non-admin attempting to sign in to the admin app is rejected at the UI with a clear message.
- All admin write actions appear in `admin_actions` with the correct `action`, `target_type`, `target_id`, and `admin_user_id`.
- Approving a PENDING_REVIEW business makes it visible on the public listing endpoint.
- Admin dashboard builds with `npm run build` and serves with `npm run preview`.

## Test plan

- Backend unit: admin services (approve, reject, suspend) state-transition rules.
- Frontend unit: route guards, API client error handling.
- Manual: log in as ADMIN, approve a pending business, see it appear on the public listing endpoint.

## Rollback notes

- Migration forward-only.
- Admin frontend is shipped as a static SPA; rollback is redeploying the prior bundle.
- If a faulty approval misclassifies businesses, admin can use the suspend action to remove from public listings without a code rollback.
