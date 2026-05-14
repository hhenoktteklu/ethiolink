# Phase 3 — Services, Staff, and Availability

## Goal

Let an approved business publish its bookable inventory: services (with duration and price), staff members, and per-staff availability windows. Expose a computed-slots endpoint that customers will consume in Phase 4.

## Scope

In scope:

- DB migrations for `services`, `staff_members`, `staff_availability`.
- Services CRUD per `API_SPEC.md`.
- Staff CRUD per `API_SPEC.md`.
- Availability: weekly schedule replace, ad-hoc overrides, public read endpoint.
- Slot computation: given a staff member, date range, and service, return open slots respecting weekly availability, overrides, existing accepted appointments (which arrive in Phase 4 — wire the query but expect empty for now), and a fixed buffer between bookings.

Out of scope:

- Booking creation and accept/reject flows (Phase 4).
- Multi-staff "any available" search (Phase 4 can extend slot computation).

## Files involved

- `backend/db/migrations/0006_services.sql`
- `backend/db/migrations/0007_staff_members.sql`
- `backend/db/migrations/0008_staff_availability.sql`
- `backend/shared/http/validation.ts` (extracted from Phase 2 `_validators.ts` files as a Phase 3 prerequisite — generic body parsers shared across handler folders)
- `backend/shared/http/pagination.ts` (extracted from Phase 2 `businessService.ts` cursor codec — generic encode/decode/clampLimit for any paginated listing)
- `backend/shared/domains/services/*`
- `backend/shared/domains/staff/*`
- `backend/shared/domains/availability/*`
- `backend/lambdas/services/{list,create,patch,delete}.ts`
- `backend/lambdas/staff/{list,create,patch,delete}.ts`
- `backend/lambdas/availability/{get,replace,addOverride,slots}.ts`
- `backend/tests/services/*`, `backend/tests/staff/*`, `backend/tests/availability/*`

## Pre-implementation cleanup

Done before any Phase 3 domain code lands, to avoid duplicating Phase 2 patterns three more times:

- Generic body parsers (`ValidationFailure`, `UUID_RE`, `parseJsonObjectBody`, `parseRequiredUuid`, `parseRequiredString`, `parseOptionalString`, `parseStringOrNull`, `parseOptionalNonNegInt`) moved to `backend/shared/http/validation.ts`. Phase 2's `lambdas/businesses/_validators.ts` and `lambdas/media/_validators.ts` are now thin shims that re-export the generics and keep only domain-specific helpers (`FieldLimits`, `parseDescriptionOrNull`, `parseLatitude`/`parseLongitude`; `parseOwnerType`, `parseStorageKey`).
- Opaque cursor codec moved to `backend/shared/http/pagination.ts`: `InvalidCursorError`, `encodeCursor<P>(payload)`, `decodeCursor<P>(encoded, isValid)`, `clampLimit(requested, opts)`. `businessService.ts` keeps its business-specific `ParsedCursor` shape, the `isParsedCursor` type guard, and an `encodeBusinessCursor` wrapper; it re-exports `InvalidCursorError` so existing handler/test imports keep working.
- Pure refactor: no API behavior changed; existing Phase 1 + Phase 2 tests continue to cover the cursor codec via `businessService` tests.

## Checklist

- [ ] Migrations 0006–0008 applied to dev.<!-- 0006 + 0007 + 0008 authored; "applied to dev" needs `terraform apply` + run migrations -->
- [x] Services CRUD ownership-gated.
- [x] Staff CRUD ownership-gated.<!-- STAFF media unlock in MediaService still pending. -->
- [x] Weekly availability `PUT` accepts a 7-day schedule with one or more windows per day.
- [x] Override `POST` can mark a day or window closed, or add a special open window.
- [ ] `GET …/slots` returns slots that are inside availability, not within any existing appointment, and not in the past.<!-- schedule read (weekly + overrides) shipped in this commit; slot computation algorithm + handler are a separate focused commit -->

## Acceptance criteria

- Slot computation includes a configurable `slotStepMinutes` (default 15) and `bufferMinutes` (default 5 between bookings).
- Slot computation respects business timezone (default `Africa/Addis_Ababa`).
- Slot computation rejects requested service durations longer than any availability window in range.
- All inputs validated against schema; invalid weekday or impossible time windows return `VALIDATION_ERROR`.

## Test plan

- Unit: slot generation with fixtures covering: empty availability, one window, multiple windows, overrides removing a window, overrides adding a window, service-duration-longer-than-window.
- Unit: timezone handling — slots computed for Addis Ababa local time and returned as UTC ISO strings.
- Integration: create services and staff, replace availability, GET slots, observe a sensible result set.

## Rollback notes

- Migrations forward-only.
- No external systems beyond RDS are affected.
- A faulty availability schedule can be cleared by `PUT` with an empty array; no destructive operation required.
