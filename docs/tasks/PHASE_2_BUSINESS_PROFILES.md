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
- Public listing filters: category, city, query (LIKE on name for MVP), priceMin/Max, ratingMin.
- Cursor-based pagination helper.

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
- `backend/lambdas/businesses/{list,get,create,patch,submit,me}.ts`
- `backend/lambdas/media/{uploadUrl,confirm}.ts`
- `backend/tests/businesses/*`, `backend/tests/media/*`

## Checklist

- [ ] Migrations 0003–0005 applied to dev.<!-- 0003 + 0004 + 0005 authored; "applied to dev" needs `terraform apply` + run migrations -->
- [ ] Categories seed inserted; `GET /v1/categories` returns the four beauty categories.<!-- seed file + runner authored; categories domain (`shared/domains/categories/*`) authored; "inserted" against dev needs `terraform apply`; `GET /v1/categories` handler pending -->
- [ ] BUSINESS_OWNER can create a DRAFT business and edit it.
- [ ] BUSINESS_OWNER can submit a draft, moving status to PENDING_REVIEW.
- [ ] Public `GET /v1/businesses` only returns APPROVED rows.
- [ ] Owner sees their own business at any status via `/v1/me/business`.
- [ ] Pre-signed PUT URL endpoint enforces caller authorization and acceptable content types.
- [ ] Upload confirmation persists a `media_assets` row tied to the business.
- [ ] StorageGateway interface in place; service-layer code never imports the AWS SDK.

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
