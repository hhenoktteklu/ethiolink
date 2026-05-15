# API Specification

REST over HTTPS via API Gateway. All paths are prefixed with `/v1/`. All requests and responses are JSON. All authenticated endpoints require an `Authorization: Bearer <Cognito-JWT>` header.

This document is the contract between mobile, admin, and backend. Detailed OpenAPI/Swagger generation lives in `backend/api/openapi.yaml` (added in Phase 1).

## Conventions

- Identifiers in URLs are UUIDs.
- Timestamps are ISO-8601 with timezone.
- Errors return:
  ```json
  { "error": { "code": "STRING_CODE", "message": "Human readable", "details": {} } }
  ```
- Pagination uses cursor-based: `?limit=20&cursor=<opaque>`. Responses include `nextCursor`.
- Role enforcement is performed by a request authorizer; endpoints below note the required role(s).

## Endpoints

### Auth & profile sync

| Method | Path                 | Roles                                | Purpose                                              |
| ------ | -------------------- | ------------------------------------ | ---------------------------------------------------- |
| POST   | /v1/auth/sync        | any authenticated                    | Idempotently sync Cognito user into `users` table    |
| GET    | /v1/me               | any authenticated                    | Get current user's profile                           |
| PATCH  | /v1/me               | any authenticated                    | Update display name and preferences                  |

### Categories

| Method | Path                       | Roles                | Purpose                          |
| ------ | -------------------------- | -------------------- | -------------------------------- |
| GET    | /v1/categories             | public               | List active categories           |
| GET    | /v1/admin/categories       | ADMIN                | List categories across active + deactivated, with optional `isActive` filter |
| POST   | /v1/admin/categories       | ADMIN                | Create category. Slug unique across all categories. |
| PATCH  | /v1/admin/categories/:id   | ADMIN                | Update category. `isActive` is NOT patched here — use DELETE to deactivate. |
| DELETE | /v1/admin/categories/:id   | ADMIN                | **Soft-delete** — flips `is_active` to `false`; preserves FK chain from `business_profiles.category_id`. |

### Business profiles

| Method | Path                                  | Roles                           | Purpose                                                |
| ------ | ------------------------------------- | ------------------------------- | ------------------------------------------------------ |
| GET    | /v1/businesses                        | public                          | Search/list approved businesses (filters: category, city, query, priceMin/Max, ratingMin) |
| GET    | /v1/businesses/:id                    | public                          | Get business profile (only APPROVED visible publicly)  |
| POST   | /v1/businesses                        | BUSINESS_OWNER                  | Create draft business profile                          |
| PATCH  | /v1/businesses/:id                    | BUSINESS_OWNER (owner) or ADMIN | Update business profile                                |
| POST   | /v1/businesses/:id/submit             | BUSINESS_OWNER (owner)          | Submit DRAFT → PENDING_REVIEW                          |
| GET    | /v1/me/business                       | BUSINESS_OWNER                  | Get current owner's business (any status)              |

### Admin — businesses

Every admin write below persists exactly one row to `admin_actions` (append-only audit log, migration 0012) carrying `admin_user_id`, `action`, `target_type='business_profile'`, `target_id`, and the optional `notes` body field. Failed writes record no row.

| Method | Path                                          | Roles | Purpose                                       |
| ------ | --------------------------------------------- | ----- | --------------------------------------------- |
| GET    | /v1/admin/businesses                          | ADMIN | List businesses, filterable by status. Read-only; no audit row. |
| POST   | /v1/admin/businesses/:id/approve              | ADMIN | PENDING_REVIEW → APPROVED. `APPROVE_BUSINESS` audit row. |
| POST   | /v1/admin/businesses/:id/reject               | ADMIN | PENDING_REVIEW → REJECTED. `REJECT_BUSINESS` audit row (notes are the canonical rejection-reason store; the schema has no dedicated column). |
| POST   | /v1/admin/businesses/:id/suspend              | ADMIN | APPROVED or PENDING_REVIEW → SUSPENDED. `SUSPEND_BUSINESS` audit row. |
| POST   | /v1/admin/businesses/:id/feature              | ADMIN | Set / unset `featured_until` on an APPROVED business. Body's `featuredUntil: ISO-8601 \| null` controls the action: setting emits `FEATURE_BUSINESS`, clearing emits `UNFEATURE_BUSINESS`. |

### Services

| Method | Path                                                | Roles                           | Purpose                  |
| ------ | --------------------------------------------------- | ------------------------------- | ------------------------ |
| GET    | /v1/businesses/:businessId/services                 | public                          | List active services     |
| POST   | /v1/businesses/:businessId/services                 | BUSINESS_OWNER (owner) or ADMIN | Create service           |
| PATCH  | /v1/businesses/:businessId/services/:id             | BUSINESS_OWNER (owner) or ADMIN | Update service           |
| DELETE | /v1/businesses/:businessId/services/:id             | BUSINESS_OWNER (owner) or ADMIN | Deactivate service       |

### Staff

| Method | Path                                                | Roles                           | Purpose                  |
| ------ | --------------------------------------------------- | ------------------------------- | ------------------------ |
| GET    | /v1/businesses/:businessId/staff                    | public                          | List active staff        |
| POST   | /v1/businesses/:businessId/staff                    | BUSINESS_OWNER (owner) or ADMIN | Create staff             |
| PATCH  | /v1/businesses/:businessId/staff/:id                | BUSINESS_OWNER (owner) or ADMIN | Update staff             |
| DELETE | /v1/businesses/:businessId/staff/:id                | BUSINESS_OWNER (owner) or ADMIN | Deactivate staff         |

### Availability

| Method | Path                                                            | Roles                           | Purpose                                                          |
| ------ | --------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| GET    | /v1/businesses/:businessId/staff/:staffId/availability          | public                          | Get weekly schedule + overrides                                  |
| PUT    | /v1/businesses/:businessId/staff/:staffId/availability          | BUSINESS_OWNER (owner) or ADMIN | Replace weekly schedule                                          |
| POST   | /v1/businesses/:businessId/staff/:staffId/availability/override | BUSINESS_OWNER (owner) or ADMIN | Add an override (closed day or special window)                   |
| GET    | /v1/businesses/:businessId/staff/:staffId/slots                 | public                          | Computed bookable slots for a given date range and service       |

### Appointments

| Method | Path                                      | Roles                                     | Purpose                                          |
| ------ | ----------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| POST   | /v1/appointments                          | CUSTOMER                                  | Create appointment in REQUESTED status           |
| GET    | /v1/me/appointments                       | any authenticated                         | List the caller's customer-side appointments (BUSINESS_OWNER / ADMIN see only rows where they were the customer — typically empty) |
| GET    | /v1/businesses/:businessId/appointments   | BUSINESS_OWNER (owner) or ADMIN           | List incoming appointments for a business        |
| POST   | /v1/appointments/:id/accept               | BUSINESS_OWNER (owner) or ADMIN           | REQUESTED → ACCEPTED                             |
| POST   | /v1/appointments/:id/reject               | BUSINESS_OWNER (owner) or ADMIN           | REQUESTED → REJECTED (optional `reason` logged, not persisted in MVP) |
| POST   | /v1/appointments/:id/cancel               | CUSTOMER (own), BUSINESS_OWNER (owner), or ADMIN | ACCEPTED/REQUESTED → CANCELLED. CUSTOMER actor obeys `BOOKING_CANCEL_CUTOFF_MINUTES`; BUSINESS_OWNER and ADMIN bypass the cutoff. |
| POST   | /v1/appointments/:id/reschedule           | CUSTOMER (own)                            | Customer-only. Re-validates the new slot through the same `SlotService`; ACCEPTED rows reset to REQUESTED so the business must re-accept. |
| POST   | /v1/appointments/:id/complete             | BUSINESS_OWNER (owner) or ADMIN           | ACCEPTED → COMPLETED                             |

### Reviews

| Method | Path                                  | Roles            | Purpose                                |
| ------ | ------------------------------------- | ---------------- | -------------------------------------- |
| POST   | /v1/appointments/:id/review           | CUSTOMER (own)   | Submit a review (one per appointment)  |
| GET    | /v1/businesses/:id/reviews            | public           | List reviews for a business            |

### Media uploads

| Method | Path                          | Roles                                 | Purpose                                                |
| ------ | ----------------------------- | ------------------------------------- | ------------------------------------------------------ |
| POST   | /v1/media/upload-url          | any authenticated                     | Issue an S3 pre-signed PUT URL for a known content type|
| POST   | /v1/media                     | any authenticated                     | Confirm a successful upload, persist `media_assets`    |

### Admin — users

| Method | Path                          | Roles  | Purpose                                |
| ------ | ----------------------------- | ------ | -------------------------------------- |
| GET    | /v1/admin/users               | ADMIN  | List users with optional `status` (ACTIVE / SUSPENDED / DELETED) and `role` (CUSTOMER / BUSINESS_OWNER / ADMIN) filters. Returns `AdminUserView` (adds `status`). Read-only; no audit row. |
| POST   | /v1/admin/users/:id/suspend   | ADMIN  | ACTIVE → SUSPENDED. `SUSPEND_USER` audit row. DELETED users are terminal and refused with 409. |
| POST   | /v1/admin/users/:id/restore   | ADMIN  | SUSPENDED → ACTIVE. `RESTORE_USER` audit row. DELETED users cannot be restored through this endpoint. |

### Admin — bookings (read-only)

| Method | Path                          | Roles  | Purpose                                |
| ------ | ----------------------------- | ------ | -------------------------------------- |
| GET    | /v1/admin/appointments        | ADMIN  | Cross-business read across all bookings. Optional filters: `status`, `businessId`, `customerId`, `from` (inclusive lower bound on `startsAt`), `to` (exclusive upper bound on `startsAt`), `limit` (1..100, default 50). Sort: `starts_at DESC, id DESC`. Returns standard `AppointmentView` items. |

## Error codes (initial set)

- `UNAUTHENTICATED` — missing or invalid token.
- `FORBIDDEN` — authenticated but lacks the required role / ownership.
- `NOT_FOUND` — target resource not found.
- `VALIDATION_ERROR` — input failed schema validation; `details` contains field errors.
- `CONFLICT` — state transition not allowed (e.g., approve a non-PENDING business, customer cancel past the cancellation cutoff, accept a non-REQUESTED appointment, second review for the same appointment).
- `SLOT_UNAVAILABLE` — requested appointment slot is taken or outside availability. Surfaced both pre-INSERT (when the requested instant isn't in the computed slot list) and post-INSERT (when the migration-0009 EXCLUDE constraint loses a race; SQLSTATE 23P01 translated by the service).
- `RATE_LIMITED` — too many requests.
- `INTERNAL_ERROR` — unexpected server-side failure.

### Sub-codes inside `details.code`

Some responses carry a more specific identifier nested in `details.code` underneath one of the top-level codes above. Clients should switch on `details.code` when present for localized copy.

- `ONLINE_PAYMENTS_UNAVAILABLE` (under `VALIDATION_ERROR`, 400) — `paymentMethod: ONLINE_PENDING` is currently refused by `MockOnlineGateway`. Real online providers (Telebirr / Chapa / CBE Birr) ship post-MVP behind the same gateway port; until then, customers must select `CASH`.
