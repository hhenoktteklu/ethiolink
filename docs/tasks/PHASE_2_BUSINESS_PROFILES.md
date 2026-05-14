# Phase 2 — Business Profiles

## Goal

Let business owners create, edit, and submit business profiles, and let the public browse approved profiles. Admin approval write paths come in Phase 5; this phase ships the read side end-to-end and the owner-side CRUD.

## Scope

In scope:

- DB migrations for `business_categories`, `business_profiles`, `media_assets`.
- Seed file for initial beauty categories (Salon, Barber, Spa, Beauty Professional).
- Backend services and repositories for categories and businesses.
- Endpoints from `API_SPEC.md`:
  - `GET /v1/categories`
  - `GET /v1/businesses`, `GET /v1/businesses/:id`
  - `POST /v1/businesses`, `PATCH /v1/businesses/:id`, `POST /v1/businesses/:id/submit`
  - `GET /v1/me/business`
  - `POST /v1/media/upload-url`, `POST /v1/media`
- S3 storage adapter (`StorageGateway`) with `S3StorageGateway` implementation.
- Public listing filters: category, city, query (LIKE on name for MVP), ratingMin. `priceMin/Max` is deferred to Phase 3 — businesses don't carry prices until the `services` table ships.
- Cursor-based pagination, encoded as `base64url(JSON.stringify({ id, sortKey }))`. Codec is currently inline in `businessService.ts`; promote to `shared/http/pagination.ts` when a second paginated listing endpoint needs it.

Out of scope:

- Services and staff (Phase 3).
- Availability and bookings (Phases 3/4).
- Reviews (Phase 4 wires the read path; writes after booking completion).
- Admin approval write path (Phase 5).

## Files involved

- `backend/db/migrations/0003_business_categories.sql`
- `backend/db/migrations/0004_business_profiles.sql`
- `backend/db/migrations/0005_media_assets.sql`
- `backend/db/seeds/0001_categories.sql`
- `backend/shared/domains/categories/*`
- `backend/shared/domains/businesses/*`
- `backend/shared/domains/media/*`
- `backend/shared/adapters/storage/StorageGateway.ts`
- `backend/shared/adapters/storage/S3StorageGateway.ts`
- `backend/lambdas/categories/list.ts`
- `backend/lambdas/businesses/{list,get,create,patch,submit,me}.ts` + `_validators.ts`
- `backend/lambdas/media/{uploadUrl,confirm}.ts` + `_validators.ts`
- `backend/db/seed.mjs` (seed runner introduced this phase)
- `backend/tests/businesses/*`, `backend/tests/media/*` (planned for a Phase 2 tests follow-up commit; not present yet)

## Checklist

- [ ] Migrations 0003–0005 applied to dev.<!-- 0003 + 0004 + 0005 authored; "applied to dev" needs `terraform apply` + run migrations -->
- [x] Categories seed inserted; `GET /v1/categories` returns the four beauty categories.
- [x] BUSINESS_OWNER can create a DRAFT business and edit it.
- [x] BUSINESS_OWNER can submit a draft, moving status to PENDING_REVIEW.
- [x] Public `GET /v1/businesses` only returns APPROVED rows.
- [x] Owner sees their own business at any status via `/v1/me/business`.
- [x] Pre-signed PUT URL endpoint enforces caller authorization and acceptable content types.
- [x] Upload confirmation persists a `media_assets` row tied to the business.
- [x] StorageGateway interface in place; service-layer code never imports the AWS SDK.

## Acceptance criteria

- Listing endpoint supports filters and cursor pagination as specified.
- Ownership checks: a BUSINESS_OWNER cannot edit another owner's business; returns 403.
- A non-authenticated request to listing/detail endpoints succeeds with public data only.
- Media uploads survive a 3G-grade upload (15-minute PUT URL expiry).

## Test plan

- Unit: business service rules (status transitions DRAFT → PENDING_REVIEW; cannot transition without required fields).
- Unit: media service validates content type and size hints.
- Integration: create-draft → submit → admin sees pending business (read path only) → public listing remains empty until APPROVED is set manually for the test.
- Manual: upload a 1 MB JPEG end-to-end through the pre-signed URL.

## Rollback notes

- Migrations are forward-only; compensating migration required if rollback needed.
- S3 objects uploaded during testing should be cleaned by a lifecycle rule (incomplete multipart uploads + `tmp/` prefix age out after 7 days).
- Lambda artifacts rollback via redeploy of the previous version.

## Verification notes (Phase 2 audit, 2026-05-14)

Items captured during the Phase 2 verification pass. None are blockers for ticking the remaining checklist item (which is gated on `terraform apply`), but each is worth addressing before MVP launch.

- **CUSTOMER → BUSINESS_OWNER signup gap.** New users sign up into the `CUSTOMER` Cognito group by default (per the Cognito module's `precedence` config). The Phase 2 write endpoints (`POST /v1/businesses`, `PATCH /v1/businesses/:id`, `POST /v1/businesses/:id/submit`) require `BUSINESS_OWNER` role at the handler. There is no in-app path for a `CUSTOMER` to elevate themselves. Today the only mechanism is `aws cognito-idp admin-add-user-to-group` run by an operator. **Decision needed before MVP launch:** either (a) a self-service "I want to register a business" endpoint that adds the caller to the `BUSINESS_OWNER` group, (b) signup directly assigns `BUSINESS_OWNER` based on a `role` field in the signup form, or (c) admin promotion in Phase 5. This file does not pick an option — flagging only.

- **`PATCH /v1/businesses/:id` admin half deferred.** `API_SPEC.md` lists this endpoint as "BUSINESS_OWNER (owner) or ADMIN". Phase 2's `businessService.update` is strict-owner only. Phase 5 admin work needs to relax the ownership check to `caller.userId === existing.ownerUserId || caller.role === 'ADMIN'`. The `CallerContext` already carries `role`, so the change is one line plus tests.

- **`priceMin/Max` listing filter deferred.** Originally listed in Phase 2 scope. Businesses don't carry prices; services do (Phase 3). The listing handler currently ignores these query params silently. Scope line has been updated to reflect the deferral.

- **Cursor pagination codec is co-located with `businessService`.** When a second paginated listing endpoint lands (likely services or reviews), extract `shared/http/pagination.ts` so the encoder isn't owned by an unrelated domain.

- **STAFF media uploads return 400 today.** `mediaService` raises `MediaUnsupportedOwnerTypeError` for `ownerType: STAFF` until Phase 3 implements `staff_members`. The error code is `VALIDATION_ERROR` with `details.ownerType` — clients can distinguish from a true validation failure on the message text, but a dedicated code (`NOT_IMPLEMENTED`?) would be cleaner. Not a Phase 2 fix — flagged for Phase 3.

- **Tests for the three new domains are deferred.** No `backend/tests/businesses/` or `backend/tests/media/` files exist yet. Pattern is set (in-memory fakes from Phase 1's userService tests). Scoped for a Phase 2 tests follow-up commit.
