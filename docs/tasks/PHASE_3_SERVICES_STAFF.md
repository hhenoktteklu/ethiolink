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
- `backend/shared/domains/services/*` (repository, service, view)
- `backend/shared/domains/staff/*` (repository, service, view)
- `backend/shared/domains/availability/*` — `availabilityRepository.ts`, `availabilityService.ts`, `availabilityView.ts`, plus the slot-computation pair: `slotComputer.ts` (pure function) and `slotService.ts` (orchestrator)
- `backend/shared/domains/appointments/appointmentsRepository.ts` (Phase 3 stub; Phase 4 ships the Pg implementation against the new `appointments` table)
- `backend/lambdas/services/{list,create,patch,delete}.ts` + `_validators.ts`
- `backend/lambdas/staff/{list,create,patch,delete}.ts` + `_validators.ts`
- `backend/lambdas/availability/{get,replace,addOverride,slots}.ts` + `_validators.ts`
- `backend/shared/config/loadConfig.ts` — extended with `BookingConfig` (`slotStepMinutes`, `bufferMinutes`, `defaultTimezone`)
- `backend/package.json` — `luxon ^3.4.4` runtime dep + `@types/luxon` dev dep added for timezone-aware slot computation
- `backend/tests/services/*`, `backend/tests/staff/*`, `backend/tests/availability/*` (planned for a Phase 3 tests follow-up commit; not present yet)

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
- [x] `GET …/slots` returns slots that are inside availability, not within any existing appointment, and not in the past.<!-- appointment-conflict check wired against a stub `StubAppointmentsRepository`; Phase 4 swaps in the real implementation against the `appointments` table -->

## Acceptance criteria

- Slot computation includes a configurable `slotStepMinutes` (default 15) and `bufferMinutes` (default 5 between bookings).
- Slot computation respects business timezone (default `Africa/Addis_Ababa`) — every `HH:MM:SS` clock value is interpreted in the business zone via Luxon before conversion to UTC.
- Slot computation returns an empty `items` list when the requested service duration exceeds every open window in the date range — clients render "no times available" rather than a typed validation error. (Phase 3 chose the soft-empty path; tightening to an explicit error is a Phase 5 polish item if customer-facing UX warrants it.)
- All inputs validated against schema; invalid weekday, impossible time windows, malformed dates, and ranges > 31 days return `VALIDATION_ERROR`.

## Test plan

- Unit: slot generation with fixtures covering: empty availability, one window, multiple windows, overrides removing a window, overrides adding a window, service-duration-longer-than-window.
- Unit: timezone handling — slots computed for Addis Ababa local time and returned as UTC ISO strings.
- Integration: create services and staff, replace availability, GET slots, observe a sensible result set.

## Rollback notes

- Migrations forward-only.
- No external systems beyond RDS are affected.
- A faulty availability schedule can be cleared by `PUT` with all-empty windows for every weekday; the schema requires the seven-day shape so an empty array body is rejected by validation.

## Verification notes (Phase 3 audit, 2026-05-14)

Captured during the Phase 3 verification pass. None are blockers for ticking the remaining checklist item (gated on `terraform apply`); each is worth addressing in the appropriate later phase.

- **STAFF media unlock still pending.** `mediaService.assertOwnership` rejects `ownerType: STAFF` with `MediaUnsupportedOwnerTypeError`. Phase 3 now has the `StaffRepository` that the unlock needs: the change is wiring `StaffRepository` into `MediaService` as a third constructor dep and replacing the STAFF branch with a `staffRepo.findById(ownerId) → business → ownerUserId === caller.userId` check. Worth a small follow-up commit so staff portraits can flow. Flagged once in the Phase 3 staff-domain commit; surfacing here as the canonical record.

- **`AppointmentsRepository` is a stub until Phase 4.** `StubAppointmentsRepository.listConflictsForStaff` always returns `[]`. The slot computer threads the result through correctly — emitted slots already respect the conflict shape, so Phase 4 swaps in a `PgAppointmentsRepository` (against the new `appointments` table) without touching `slotComputer.ts` or `slotService.ts`. The seam is fully ready.

- **Admin write paths still owner-only.** `API_SPEC.md` lists services / staff / availability writes as "owner or ADMIN". Phase 3 implements strict-owner only, same as Phase 2 business writes. The `CallerContext.role` carries the role today; the relaxation in each service is `caller.userId === existing.ownerUserId || caller.role === 'ADMIN'` — one line per check. Phase 5 batches all admin write paths in one pass.

- **Slot computation max range = 31 days.** Hard cap in `computeSlots` to avoid pathological scans. Customers typically look 7–14 days ahead; the cap is generous. If a real use case hits it, raise via config rather than removing.

- **Tests for the new domains:**
  - `slot computer` — in place (`backend/tests/availability/slotComputer.test.ts`). The pure function is exercised directly with deterministic `now` injection; no DB, no fakes. Covers empty inputs, weekly windows, override add/remove/merge/clip, duration-vs-window math, past filter, timezone correctness (09:00 Addis → 06:00 UTC), 31-day range cap, `24:00:00` end-of-day sentinel, appointment conflicts with buffer.
  - `services` — in place (`backend/tests/services/serviceService.test.ts` + `_fakes/InMemoryServiceRepository.ts`). Create + missing-business 404 + non-owner refusal, update + empty-patch no-op + missing-target 404, deactivate, listing-active-only, `priceEtb` round-trip.
  - `staff` — in place (`backend/tests/staff/staffService.test.ts` + `_fakes/InMemoryStaffRepository.ts`). Same matrix as services with `role` null-clearing in place of the price round-trip.
  - `availabilityService`, `slotService` (orchestrators) — still deferred.

- **Luxon was added as a runtime dep.** Justification: IANA timezone math is brittle to hand-roll (DST transitions, zone-changing dates, edge cases around `24:00:00`). Luxon is pure JS, ~70 KB minified+gzipped, zero transitive deps. Scoped to slot computation only — no other file imports it.

- **Pre-implementation extraction paid for itself.** The `shared/http/validation.ts` and `shared/http/pagination.ts` files extracted at the start of Phase 3 are used by every Phase 3 handler folder. The `lambdas/staff/_validators.ts` is just 19 lines because of the extraction.
