# Phase 4 — Booking

## Goal

Deliver the headline feature: a customer can pick a service and a slot and create an appointment; the business can accept or reject; either party can cancel within the policy window; the customer can reschedule; the customer can review a completed appointment.

## Scope

In scope:

- DB migrations for `appointments`, `reviews`, `payment_intents`.
- Booking service with state machine: REQUESTED → ACCEPTED → COMPLETED, with REJECTED, CANCELLED, NO_SHOW as terminal branches.
- Endpoints from `API_SPEC.md`:
  - `POST /v1/appointments`
  - `GET /v1/me/appointments`, `GET /v1/businesses/:businessId/appointments`
  - `POST /v1/appointments/:id/{accept,reject,cancel,reschedule,complete}`
  - `POST /v1/appointments/:id/review`, `GET /v1/businesses/:id/reviews`
- Payment abstraction: `PaymentGateway` interface, `CashGateway` and `MockOnlineGateway` implementations.
- Concurrency-safe slot reservation: `SELECT … FOR UPDATE` inside the booking transaction to prevent double-booking.
- Cancellation policy: hardcoded 4-hour cutoff in MVP, configurable via env.<!-- `BookingConfig.cancelCutoffMinutes` wired in loadConfig from `BOOKING_CANCEL_CUTOFF_MINUTES` (non-negative int, default 240); .env.example already documents the var. Service-layer cutoff check + admin override land with the appointment service. -->
- Denormalized `rating_avg` / `rating_count` updates on review insert.

Out of scope:

- Notifications (Phase 6).
- Real online payments — `MockOnlineGateway` immediately fails any online attempt.
- In-app chat.

## Files involved

- `backend/db/migrations/0009_appointments.sql`
- `backend/db/migrations/0010_reviews.sql`
- `backend/db/migrations/0011_payment_intents.sql`
- `backend/shared/domains/appointments/*`
- `backend/shared/domains/reviews/*`
- `backend/shared/adapters/payments/PaymentGateway.ts`
- `backend/shared/adapters/payments/CashGateway.ts`
- `backend/shared/adapters/payments/MockOnlineGateway.ts`
- `backend/lambdas/appointments/{create,listMine,listForBusiness,accept,reject,cancel,reschedule,complete,review}.ts`
- `backend/lambdas/reviews/listForBusiness.ts`
- `backend/tests/appointments/*`, `backend/tests/reviews/*`

## Checklist

- [ ] Migrations 0009–0011 applied to dev.<!-- 0009 (appointments — `btree_gist` + EXCLUDE for double-booking prevention) + 0010 (reviews — UNIQUE on `appointment_id` for one-review-per-appointment, denormalized `customer_id`/`business_id`, soft-delete) + 0011 (payment_intents — ON DELETE CASCADE from appointments, provider MOCK/TELEBIRR/CHAPA/CBE_BIRR default MOCK, status PENDING/SUCCEEDED/FAILED/CANCELLED default PENDING) authored; "applied to dev" needs `terraform apply` + run migrations -->
- [ ] Booking transaction acquires row-level locks on overlapping windows to prevent double-booking.<!-- Strategy is the migration-0009 EXCLUDE constraint, not row-level locks. `PgAppointmentsRepository` is in place (`insert`, `findById`, `listForCustomer`, `listForBusiness`, `setStatus`, `reschedule`, `listConflictsForStaff`) and now backs the slots handler. `AppointmentService.create` / `.reschedule` catch SQLSTATE 23P01 and translate to `AppointmentSlotUnavailableError`. -->
- [ ] State machine rejects invalid transitions with `CONFLICT`.<!-- Pure-function module `appointmentStateMachine.ts` + matrix `APPOINTMENT_TRANSITIONS` + typed `InvalidAppointmentTransitionError` in place, with full unit-test coverage of every allowed row, terminal sealing, and a representative disallowed sample. `AppointmentService` re-exports the error so handlers can catch it; CONFLICT (409) mapping lands with the Lambda handlers. -->
- [ ] Cash booking succeeds end-to-end; online booking attempt returns 400 with a clear message.<!-- `PaymentGateway` port + `CashGateway` (no-op SUCCEEDED) + `MockOnlineGateway` (throws typed `OnlinePaymentsUnavailableError` with code `ONLINE_PAYMENTS_UNAVAILABLE`) in place. `AppointmentService.create` routes by `paymentMethod` (CASH → cashGateway, ONLINE_PENDING → onlineGateway) and authorizes pre-INSERT. `POST /v1/appointments` handler maps the error to a 400 with `field: 'paymentMethod'`. End-to-end verification waits on `terraform apply` + handler tests. -->
- [ ] Cancel respects 4-hour cutoff; admin override allowed.<!-- `AppointmentService.cancel` enforces `cancelCutoffMinutes` against CUSTOMER actor only; BUSINESS and ADMIN bypass per spec. Cutoff check uses an injectable `now` for deterministic tests; `0` disables the cutoff. `AppointmentCancellationCutoffError(cutoffMinutes)` typed for the handler 409 mapping. -->
- [ ] Review insertion requires a COMPLETED appointment and updates business `rating_avg`/`rating_count`.

## Acceptance criteria

- Two concurrent requests for the same slot result in exactly one success and one `SLOT_UNAVAILABLE`.
- All endpoints enforce role and ownership.
- Cancellation by customer past cutoff returns `CONFLICT`.
- A review can be left at most once per appointment.

## Test plan

- Unit: state machine transitions matrix.
- Unit: slot-conflict detection helpers.
- Concurrency: spawn two parallel `POST /v1/appointments` requests targeting the same slot in a dev test script; assert exactly one wins.
- Integration: full flow — create draft business → seed approved row → add service/staff/availability → book → accept → complete → review → confirm `rating_avg` updates.

## Rollback notes

- Migrations forward-only. Any compensating migration that drops `appointments` must also drop `reviews` and `payment_intents` first (FK chain).
- The cancellation cutoff is config-driven — adjusting it does not require redeploy.
