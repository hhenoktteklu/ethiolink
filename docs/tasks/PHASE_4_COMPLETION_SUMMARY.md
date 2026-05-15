# Phase 4 — Completion Summary

End of Phase 4 (Booking). The booking flow is feature-complete behind the local Postgres / in-memory test surface. Two acceptance-criteria items remain gated on shared infrastructure that Phase 7 ships.

Authoritative scope and checklist live in [`PHASE_4_BOOKING.md`](./PHASE_4_BOOKING.md). This file is the at-a-glance status read on 2026-05-15.

## Completed features

**Booking flow (customer + business)**
- `POST /v1/appointments` — `CUSTOMER`-only. Validates slot via `SlotService`, snapshots `price_etb`, authorizes payment, INSERTs.
- `GET /v1/me/appointments` — any authenticated caller; returns their customer-side bookings.
- `GET /v1/businesses/:businessId/appointments` — business owner or ADMIN.
- `POST /v1/appointments/:id/{accept,reject,cancel,reschedule,complete}` — state-machine-gated transitions. CANCEL accepted from CUSTOMER (cutoff-bound), BUSINESS_OWNER, and ADMIN. RESCHEDULE is CUSTOMER-only by design.
- `POST /v1/appointments/:id/review` — `CUSTOMER` review on a `COMPLETED` appointment; refreshes `business_profiles.rating_avg` / `rating_count`.
- `GET /v1/businesses/:id/reviews` — public, newest-first, soft-deleted filtered.

**State machine** (`appointmentStateMachine.ts`)
- Data-driven `APPOINTMENT_TRANSITIONS` matrix covering ACCEPT / REJECT / CANCEL / RESCHEDULE / COMPLETE for the allowed actor combinations. Typed `InvalidAppointmentTransitionError` mapped to 409 `CONFLICT` at the handler layer. NO_SHOW reserved for forward compatibility (no public endpoint in MVP).

**Concurrency strategy**
- Migration 0009 `EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status IN ('REQUESTED','ACCEPTED'))` is the authoritative double-booking guard. SQLSTATE 23P01 translated to `AppointmentSlotUnavailableError` → 409 `SLOT_UNAVAILABLE` by the service. No application-level row locking.

**Payment abstraction**
- `PaymentGateway` port + `CashGateway` (no-op SUCCEEDED) + `MockOnlineGateway` (throws `OnlinePaymentsUnavailableError` with stable code `ONLINE_PAYMENTS_UNAVAILABLE`). Routed by `paymentMethod` in `AppointmentService.create`. Future Telebirr / Chapa / CBE Birr providers plug behind the same port.

**Cancellation policy**
- `BookingConfig.cancelCutoffMinutes` (env `BOOKING_CANCEL_CUTOFF_MINUTES`, default 240). Customer cancels inside the cutoff return 409 `CONFLICT`; BUSINESS and ADMIN bypass the cutoff per spec.

**Reviews + aggregate**
- `PgReviewRepository.recomputeBusinessRatingAggregate(businessId)` is a single UPDATE that re-derives `rating_avg` / `rating_count` from a fresh `AVG`/`COUNT` over live reviews. Idempotent, self-healing.

## Migrations applied locally

Applied on 2026-05-15 via `npm run db:migrate` against docker-compose Postgres. `schema_migrations` shows all three rows; `\d` confirms the constraints/indexes documented in each migration header.

| Migration                       | Highlights                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0009_appointments.sql`         | `btree_gist` extension, `appointments` table, four indexes, `appointments_no_overlap_excl` EXCLUDE constraint, `set_updated_at()` trigger.            |
| `0010_reviews.sql`              | `reviews` table, UNIQUE on `appointment_id`, two listing indexes, `set_updated_at()` trigger.                                                          |
| `0011_payment_intents.sql`      | `payment_intents` table, two indexes, `set_updated_at()` trigger. `ON DELETE CASCADE` from `appointments`.                                             |

Operational runbook for the local apply (and the future AWS-hosted dev apply): [`PHASE_4_MIGRATION_RUN.md`](./PHASE_4_MIGRATION_RUN.md).

## Tests passing locally

`npm test` passes locally as of 2026-05-15.

| Test file                                                    | Coverage                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/appointments/appointmentStateMachine.test.ts`         | Matrix walk over every allowed (action, actor, fromStatus) row, terminal sealing, disallowed sample, integrity invariants (no NO_SHOW target in MVP).                    |
| `tests/appointments/appointmentService.test.ts`              | Cash create (REQUESTED + SUCCEEDED), online → `OnlinePaymentsUnavailableError`, slot misalignment + 23P01 race-loss both → `AppointmentSlotUnavailableError`, accept / reject / complete transitions, cancel cutoff matrix (customer-before / customer-after / admin-override), reschedule resets ACCEPTED → REQUESTED, invalid transitions, non-owner rejection. |
| `tests/payments/paymentGateways.test.ts`                     | `CashGateway` SUCCEEDED contract + idempotency-key ignored; `MockOnlineGateway` throws typed error with code `ONLINE_PAYMENTS_UNAVAILABLE`.                              |
| `tests/reviews/reviewService.test.ts`                        | Happy-path create + recompute-trigger, `ReviewAppointmentNotFoundError` (missing + soft-deleted), `ReviewNotOwnedError`, `ReviewAppointmentNotCompletedError` (all five non-COMPLETED statuses), `ReviewAlreadyExistsError` via pre-check + 23505 race-loss, `ReviewInvalidRatingError` matrix, listing soft-delete filter + limit + clamp. |
| Phase 1–3 tests                                              | Still pass (existing coverage unchanged).                                                                                                                                |

The earlier flaky `staffService.test.ts "returns active staff in created-order"` was fixed in commit `f7fcbbc` by seeding two rows with explicit `createdAt` timestamps instead of relying on `service.create` × 2 (whose `new Date()` calls could collapse to the same millisecond).

## Remaining Phase 7 deploy / integration items

These are blocked on infrastructure rather than code. Each will close as part of Phase 7's deploy pipeline.

- **Migrations 0009–0011 applied to the AWS-hosted dev RDS.** Today's `infra/terraform/environments/dev/main.tf` only provisions Cognito; the `module "rds"` block lands in Phase 7. Once provisioned, `npm run db:migrate` is rerun with `PG_*` env vars pointing at the RDS endpoint (see addendum in [`PHASE_4_MIGRATION_RUN.md`](./PHASE_4_MIGRATION_RUN.md)).
- **Concurrency dev smoke (`POST /v1/appointments` × 2 parallel).** Acceptance-criteria item: "Two concurrent requests for the same slot result in exactly one success and one `SLOT_UNAVAILABLE`." Unit-level proxy in `appointmentService.test.ts` covers the 23P01 translation; a real two-process curl against the deployed API confirms end-to-end. Can also run locally as a small `backend/scripts/double-book-smoke.ts` (SQL-level, two parallel INSERTs against docker-compose Postgres) — quickest win if you want a green tick before Phase 7.
- **Integration full flow.** Acceptance-criteria item: create draft business → seed approved row → add service / staff / availability → book → accept → complete → review → confirm `rating_avg` updates. Runnable locally via curl against `sam local`-style Lambdas; canonical run is against the Phase 7 dev API.
- **API Gateway + Lambda wiring for the 10 new Phase 4 endpoints.** Handlers are authored; their Terraform Lambda + route definitions land with the Phase 7 deploy module.

## Known follow-ups for Phase 5

Phase 5 (admin dashboard) inherits a few small items called out during the Phase 4 audit. None are blockers; each fits naturally alongside the admin work.

- **Admin write paths on services, staff, availability.** `API_SPEC.md` lists them as "owner or ADMIN", but the current services / staff / availability services only allow the owner. One-line relaxation per service (per the Phase 3 verification notes); will be batched alongside the admin business approval flow that Phase 5 ships anyway.
- **Reject reason persistence.** Today `lambdas/appointments/reject.ts` parses the optional `reason` body and logs it via `logger.info`; the schema has no `reject_reason` column. If Phase 5's admin tooling wants to surface rejection reasons in dashboards, add a migration `0013_reject_reason.sql` and grow `AppointmentService.reject(id, caller, { reason })` to persist.
- **Promote `ONLINE_PAYMENTS_UNAVAILABLE` to a top-level error code.** Currently nested in `details.code` under `VALIDATION_ERROR`. Two-line change to the `ApiErrorCode` union in `responses.ts` + the OpenAPI `Error.code` enum if Phase 5 admin clients want to switch on it without unpacking details. Documented in API_SPEC.md.
- **Cursor pagination for appointment + review listings.** MVP returns all rows up to 100. The opaque-cursor codec already exists in `shared/http/pagination.ts` (extracted in Phase 3). When admin dashboards need to page through bookings for a busy business, slot it in.
- **Real online payment provider (Telebirr / Chapa / CBE Birr).** Out of MVP scope but the gateway port is ready. The first integration also closes the `randomUUID()` placeholder for `PaymentAuthorizationInput.appointmentId` — real providers want the actual appointment id, which means generating the UUID app-side and passing it as `appointments.id` on insert. Documented in `AppointmentService.create`.
- **Atomic insert + aggregate.** Review insert and `recomputeBusinessRatingAggregate` are two writes today. If Phase 5+ surfaces fine-grained rating analytics, wrap both in `withTransaction`. The current self-healing recompute already covers MVP correctness needs.
- **Single insert + status update on reschedule.** Merging `repo.reschedule(...)` + `repo.setStatus('REQUESTED')` into one SQL statement is a small optimization that becomes easier to justify if Phase 5 tooling triggers reschedules at higher volume.

## Next recommended phase

**Phase 5 — Admin Dashboard.** Booking is the last customer-facing primary flow; admin tooling is the next gate to opening the platform to real businesses. Phase 5's scope (admin approve / reject / suspend / feature, audit log, basic dashboard UI) builds directly on the Phase 2–4 surface and unblocks pilot onboarding.

If a deployment gate is more urgent than admin tooling — e.g., a stakeholder wants to demo the customer flow against a real AWS environment — **Phase 7 (AWS Deployment)** is the alternative. Phase 7 closes the two remaining Phase 4 acceptance criteria as a side effect.

Phase 6 (Notifications) is naturally sequenced after Phase 5: confirmation + reminder messages depend on the admin-approved-business surface being live.
