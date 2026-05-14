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
| POST   | /v1/admin/categories       | ADMIN                | Create category                  |
| PATCH  | /v1/admin/categories/:id   | ADMIN                | Update category                  |
| DELETE | /v1/admin/categories/:id   | ADMIN                | Deactivate category              |

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

| Method | Path                                          | Roles | Purpose                                       |
| ------ | --------------------------------------------- | ----- | --------------------------------------------- |
| GET    | /v1/admin/businesses                          | ADMIN | List businesses, filterable by status         |
| POST   | /v1/admin/businesses/:id/approve              | ADMIN | PENDING_REVIEW → APPROVED                     |
| POST   | /v1/admin/businesses/:id/reject               | ADMIN | PENDING_REVIEW → REJECTED                     |
| POST   | /v1/admin/businesses/:id/suspend              | ADMIN | APPROVED → SUSPENDED                          |
| POST   | /v1/admin/businesses/:id/feature              | ADMIN | Set/unset `featured_until`                    |

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
| GET    | /v1/me/appointments                       | CUSTOMER                                  | List own appointments                            |
| GET    | /v1/businesses/:businessId/appointments   | BUSINESS_OWNER (owner) or ADMIN           | List incoming appointments for a business        |
| POST   | /v1/appointments/:id/accept               | BUSINESS_OWNER (owner)                    | REQUESTED → ACCEPTED                             |
| POST   | /v1/appointments/:id/reject               | BUSINESS_OWNER (owner)                    | REQUESTED → REJECTED                             |
| POST   | /v1/appointments/:id/cancel               | CUSTOMER (own) or BUSINESS_OWNER (owner)  | ACCEPTED/REQUESTED → CANCELLED                   |
| POST   | /v1/appointments/:id/reschedule           | CUSTOMER (own)                            | Move starts_at within cancellation window        |
| POST   | /v1/appointments/:id/complete             | BUSINESS_OWNER (owner)                    | ACCEPTED → COMPLETED                             |

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
| GET    | /v1/admin/users               | ADMIN  | List users with filters                |
| POST   | /v1/admin/users/:id/suspend   | ADMIN  | Suspend a user                         |
| POST   | /v1/admin/users/:id/restore   | ADMIN  | Restore a suspended user               |

### Admin — bookings (read-only)

| Method | Path                          | Roles  | Purpose                                |
| ------ | ----------------------------- | ------ | -------------------------------------- |
| GET    | /v1/admin/appointments        | ADMIN  | Read-only view across all bookings     |

## Error codes (initial set)

- `UNAUTHENTICATED` — missing or invalid token.
- `FORBIDDEN` — authenticated but lacks the required role / ownership.
- `NOT_FOUND` — target resource not found.
- `VALIDATION_ERROR` — input failed schema validation; `details` contains field errors.
- `CONFLICT` — state transition not allowed (e.g., approve a non-PENDING business).
- `SLOT_UNAVAILABLE` — requested appointment slot is taken or outside availability.
- `RATE_LIMITED` — too many requests.
- `INTERNAL_ERROR` — unexpected server-side failure.
