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

- [ ] Migration 0012 applied.
- [ ] All admin write endpoints persist an `admin_actions` row.
- [ ] React app initialized; routes set up; protected routes redirect to `/login` if not in `ADMIN` group.
- [ ] Login uses Cognito hosted UI or AWS Amplify Auth.
- [ ] Businesses page: filter by status, click into detail, approve/reject/suspend.
- [ ] Categories page: CRUD.
- [ ] Featuring a business sets `featured_until` to a chosen date.

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
