# Phase 9 — Mobile Owner Surface Completion Summary

End of the Track 3.5 business-owner milestone. The Flutter mobile app now supports the full owner loop end-to-end against the dev API: sign in as `BUSINESS_OWNER` → see the role-gated **My Business** tab → create a DRAFT business → submit for review → once admin approves, manage services, staff, weekly availability and closed-date overrides → see customer bookings come in → accept, complete (or reject / cancel) right from the phone. The owner side of the marketplace no longer needs the admin SPA for routine day-to-day operations.

Authoritative scope + roadmap for the broader Phase 9 work live in [`PHASE_9_POST_MVP.md`](./PHASE_9_POST_MVP.md). This file is the at-a-glance status read on 2026-05-15 for the **owner-side** Flutter app specifically. The customer-side companion lives in [`PHASE_9_MOBILE_CUSTOMER_SUMMARY.md`](./PHASE_9_MOBILE_CUSTOMER_SUMMARY.md). Tracks still open across Phase 9: Telegram bot, KMS, Amharic, marketplace growth — see the master doc.

## Completed owner features

- **Role-gated My Business tab.** Fourth bottom-nav destination, visible only when `session.role == 'BUSINESS_OWNER'`. CUSTOMER and ADMIN sessions see the same three-tab nav as before. `OwnerBusinessRepository` over `GET /v1/me/business` with a typed `OwnerBusinessLoadFailureKind` enum drives the branch picker: 200 APPROVED → dashboard; 200 DRAFT/REJECTED → submit banner above the dashboard; 200 PENDING_REVIEW/SUSPENDED → read-only banner; 404 → CreateBusiness CTA; 403 → "Sign out and back in" copy; network → retry.
- **Create-business wizard.** Multi-step `CreateBusinessFlow` reached from the 404 CTA: basics (name, category dropdown over `HttpCategoriesRepository`, city), contact (address, phone with loose validation, telegram handle, whatsapp number), description (`LocalizedText.en`), review. Posts to `POST /v1/businesses`. Working "Submit for review" button on both the wizard's draft-success step and the dashboard's DRAFT/REJECTED banner — both hit `POST /v1/businesses/{id}/submit`. `BusinessActionFailureKind` enum classifies create + submit failures (validation / forbidden / conflict / network / serverError).
- **Services CRUD.** `OwnerServicesScreen` pushed when the Services dashboard card is tapped. List → `GET /v1/businesses/{id}/services`; FAB → modal create sheet posting to `POST /v1/.../services`; tap row → same sheet for `PATCH /v1/.../services/{sid}`; trash icon → confirm-then-`DELETE /v1/.../services/{sid}` (soft-delete). Form: name (required, `LocalizedText.en`), duration in minutes (required, 1–720), price ETB (optional, ≥ 0), description (optional). The `ApiClient` gained `patchJson` + `deleteJson` helpers in this commit.
- **Staff CRUD.** `OwnerStaffScreen` mirrors the services surface field-for-field over `GET / POST / PATCH / DELETE /v1/businesses/{id}/staff[/{sid}]`. Form: displayName (required, max 200), role (optional, max 100). PATCH supports `clearRole: true` so the owner can blank out a role. Rows show an avatar initial, the role under the name, and the ACTIVE/INACTIVE chip.
- **Availability editor.** `OwnerAvailabilityScreen` with a staff dropdown + seven weekday cards (Sunday → Saturday) each carrying `HH:MM` start/end `TextField`s per interval and an "Add interval" / delete affordance. Save → one `PUT /v1/businesses/{id}/staff/{sid}/availability` with all 7 days as a single transaction (empty `windows[]` ⇒ "closed all day"). Bottom section: existing OVERRIDE rows + "Add closed date" button → `showDatePicker` → POSTs a closed-day override (`isClosed: true`, 00:00–23:59). Inline validators: `HH:MM` regex, "end after start", "both required". The `ApiClient` gained a `putJson` helper here.
- **Bookings inbox.** `OwnerBookingsScreen` with Requested / Accepted / All filter chips over `GET /v1/businesses/{id}/appointments` (with optional `status` / `from` / `to` query params). Each row shows status badge + local start time + customer/service/staff IDs + price. `OwnerAppointmentDetailScreen` with status-keyed actions: REQUESTED → Accept + Reject; ACCEPTED → Cancel + Mark complete; other states → read-only "No further actions available" copy. Reject + Cancel open a confirmation dialog with an optional reason `TextField`. 409 CONFLICT renders an action-keyed inline banner ("Cannot accept — pull to refresh and check the latest status").
- **Test seam everywhere.** Every owner screen accepts repository overrides so widget tests stay platform-channel-free + network-free; every repository is exercised by a `_RecordingAdapter` test that captures the request shape and replays canned responses.

## Completed commits

Six commits, all on `main`, shipped across the Track 3.5 owner-surface milestone.

| # | Hash      | Title                                       |
| - | --------- | ------------------------------------------- |
| 1 | `e134f15` | Phase 9: add owner mobile tab               |
| 2 | `6a10724` | Phase 9: add owner create business flow     |
| 3 | `5d1419f` | Phase 9: add owner services CRUD            |
| 4 | `2de50a3` | Phase 9: add owner staff CRUD               |
| 5 | `cf7a65b` | Phase 9: add owner availability editor      |
| 6 | `729b7bc` | Phase 9: add owner bookings inbox           |

Each commit is independently summarised at the commit-message + file-listing level. Per-commit narrative breakdowns are appended to the top-of-doc progress notes in `PHASE_9_POST_MVP.md`.

## End-to-end flows now working

The six commits chain into the following end-to-end flows on a real device pointed at the dev API, signed in as a `BUSINESS_OWNER`:

1. **Sign in as BUSINESS_OWNER.** Tap "Sign in" → Cognito hosted UI in the system browser → token exchange via `flutter_appauth` → tokens persist in `flutter_secure_storage` → app lands on the Browse tab. The `cognito:groups` claim resolves to `BUSINESS_OWNER` via the role-precedence rules in `core/auth/jwt_claims.dart`.
2. **View My Business.** The bottom navigation now shows four tabs (Browse / Bookings / My Business / Profile). Tap **My Business** → the tab loads `GET /v1/me/business`. First-time owners see the 404 CTA branch with a "Create your business" button.
3. **Create business.** Tap **Create your business** → multi-step wizard (basics → contact → description → review) → tap **Create** → `POST /v1/businesses` → DRAFT confirmation. The OwnerTab refreshes on pop and now shows the 5-card dashboard with the DRAFT banner.
4. **Submit for review.** From the DRAFT/REJECTED banner on the dashboard (or directly from the wizard's draft-success step) → tap **Submit for review** → `POST /v1/businesses/{id}/submit` → the banner flips to "Awaiting review" + status → PENDING_REVIEW. The admin SPA picks up the row in its pending queue.
5. **Manage services.** Once the admin approves and the row flips to APPROVED → the dashboard banner clears → tap the **Services** card → `OwnerServicesScreen`. Tap **Add service** to create; tap a row to edit; tap the trash icon to deactivate. Each action issues the matching REST call and the list re-renders.
6. **Manage staff.** Tap the **Staff** card → `OwnerStaffScreen`. Same modal-sheet shape as services. Create staff, edit their display name + role, deactivate them.
7. **Manage weekly availability.** Tap the **Availability** card → `OwnerAvailabilityScreen` → pick a staff member from the dropdown → seven day cards render (showing existing windows if any) → tap **Add interval** to add `HH:MM` start/end pairs per weekday → tap **Save weekly schedule** → one PUT replaces the full week in a single transaction. The customer-side slot picker on the same staff member now reflects the new schedule on its next fetch.
8. **Add closed-date override.** Scroll to the **Date overrides** section → tap **Add closed date** → date picker → confirm → `POST /v1/.../availability/override` with `isClosed: true` (00:00–23:59). The override appears in the list; the customer-side slot picker stops returning slots on that date.
9. **View bookings.** Tap the **Bookings** card → `OwnerBookingsScreen` → all incoming appointments render with status badges. Use the Requested / Accepted filter chips to narrow.
10. **Accept / Reject / Cancel / Complete.** Tap any row → `OwnerAppointmentDetailScreen`. From REQUESTED → tap **Accept** (instant) or **Reject** (dialog with optional reason). From ACCEPTED → tap **Mark complete** when the appointment is done, or **Cancel** with optional reason. Each issues the matching `POST /v1/appointments/{id}/{action}` and the detail badge updates in place; pop back to the list to see the row re-render. 409 CONFLICT on a stale transition renders an action-keyed banner ("Cannot accept — pull to refresh and check the latest status").

With all ten flows working, the owner-mobile MVP loop is fully end-to-end: create business → submit → admin approves → add services + staff + availability → customer books → owner accepts → service performed → owner marks complete → customer reviews. None of this requires the admin SPA after the initial approval — the operator can run the business from the phone.

## Tests + expected status

The Track 3.5 commits add 119 unit + widget tests across 14 owner-side test suites, plus three role-gating tests appended to `browse_screen_test.dart`. The breakdown:

- `features/owner/owner_business_view_test.dart` — `OwnerBusinessView` parsing + predicates (4 tests).
- `features/owner/owner_business_repository_test.dart` — `getMine` URL + 404/403/401/500 classification (5 tests).
- `features/owner/owner_tab_test.dart` — loading / APPROVED dashboard / status banners / 404 CTA / 403 / network branches + DRAFT-banner submit + 404 CTA → CreateBusinessFlow navigation (9 tests).
- `features/owner/business_actions_repository_test.dart` — create/submit URL + body shape + 400/403/409/500 classification (9 tests).
- `features/owner/create_business_flow_test.dart` — wizard happy-path create-then-submit + validation (empty / missing category / phone) + 409 conflict / 403 forbidden / 500 server-error banners (7 tests).
- `features/owner/owner_services_repository_test.dart` — list/create/patch/delete URLs + clear-description / clear-price PATCH semantics + 400/403/404/409/500 classification (11 tests).
- `features/owner/owner_services_screen_test.dart` — list / empty / error / create-happy-path / edit-happy-path / deactivate-confirmation / create-validation / 403 banner (10 tests).
- `features/owner/owner_staff_repository_test.dart` — list/create/patch/delete URLs + clearRole PATCH semantics + 400/403/404/409/500 classification (11 tests).
- `features/owner/owner_staff_screen_test.dart` — list / empty / error / create-happy-path / edit-happy-path / clear-role-on-edit / deactivate-confirmation / create-validation / 403 banner (9 tests).
- `features/owner/availability_models_test.dart` — `AvailabilityWindow` + `AvailabilitySchedule` parsing + `weeklyByDay` grouping + `WeeklyDayInput` / `AvailabilityOverrideRequest` encoding (9 tests).
- `features/owner/availability_repository_test.dart` — get/put/post-override URLs + request body shape + 400/403/404 classification (6 tests).
- `features/owner/owner_availability_screen_test.dart` — no-staff prompt / staff-load error / pick-staff-loads-schedule / add+remove weekly window / save PUTs 7 days / end ≤ start validation / empty-fields validation / add closed-date override / initial-overrides render (9 tests).
- `features/owner/owner_bookings_repository_test.dart` — list URL + query params + accept/reject/cancel/complete URLs + reject/cancel body (with and without reason) + 403/409 classification with action label (10 tests).
- `features/owner/owner_bookings_screen_test.dart` — list / empty / error / filter chips refetch / detail Accept / Reject (with reason dialog) / Cancel (with reason dialog) / Mark complete / 409 conflict banner / read-only hint on terminal statuses (10 tests).

Plus `features/browse/browse_screen_test.dart` was extended with three role-gating tests verifying the **My Business** tab is visible for `BUSINESS_OWNER` and hidden for CUSTOMER / ADMIN.

Expected run:

```bash
cd mobile
flutter pub get
flutter test
# Expected: ~195 tests passing (75 customer-side + 119 owner-side + 1 boot), 0 failures.

flutter analyze
# Expected: No issues found.
```

The owner-side suites use the same patterns as the customer-side ones — no live network, no platform-channel calls, no Cognito interaction. `_RecordingAdapter` captures the outbound `RequestOptions` for repository tests; in-memory `_FakeRepo` classes drive the widget tests. The full suite remains deterministic + fast.

## Remaining operator / mobile gates

Four manual / device-led items before the owner surface can ship to TestFlight + Play Store internal testing. None require new code; each is a discrete operator action.

1. **Android / iOS deep-link verification for business-owner accounts.** The Cognito hosted-UI flow is identical for CUSTOMER and BUSINESS_OWNER users — the per-platform deep-link wiring is the same as the customer-side gate. Open question to verify with a real owner account: does the `cognito:groups` claim land in the id token correctly so the role-precedence resolver returns `BUSINESS_OWNER`? Boot a real device, sign in as a test owner, confirm the **My Business** tab appears in the bottom nav. If the tab is missing, the `cognito:groups` claim is empty / mis-mapped — see the `cognito_groups` mapping in the Terraform `cognito` module.
2. **TestFlight / Play Store internal-track upload.** Operator creates / extends the existing iOS App Store Connect + Play Console app records (same record as the customer-side TestFlight gate). Upload the first signed `.ipa` / `.aab` that includes the Track 3.5 commits. Invite the internal QA list — at least one BUSINESS_OWNER persona plus one CUSTOMER persona for a paired end-to-end smoke. The TestFlight build can drive the same `env/dev.json` config; the prod env stack flip is a future commit.
3. **Real booking + SMS smoke from owner POV.** Sign in as a real test owner; book a real appointment from a paired test-customer device; on the owner phone open Bookings → confirm the row appears with REQUESTED status → tap **Accept**. Verify the customer receives the SMS accept notification once the SMS provider is wired per the Track 1 operator gates in `PHASE_9_POST_MVP.md`. Wait for the appointment time → tap **Mark complete** → confirm the customer-side detail screen now exposes the review action.
4. **Owner role refresh after admin approval.** The `cognito:groups` claim is fixed at id-token issue. If a user signs up as CUSTOMER, the operator promotes them to BUSINESS_OWNER via the admin SPA (or `aws lambda invoke` for now), and the user is already signed in, the **My Business** tab won't appear until they sign out and back in to refresh the id token. The `OwnerBusinessLoadFailureKind.forbidden` branch on the OwnerTab already surfaces "Sign out and back in to refresh your role." copy — verify on a real device that the prompt is clear enough that owners actually follow it. Push notifications (out of scope) would later trigger an automatic re-auth; for now it's user-driven.

After all four pass, the owner surface is approved for invite-only soft launch alongside the customer surface.

## Known follow-ups

Six items recorded for visibility. None gate the owner-surface launch; each is a polish or post-MVP track.

- **Profile / edit-business screen.** The Profile dashboard card is the last remaining SnackBar stub. The screen wraps `PATCH /v1/businesses/{id}` (already supported by the backend) and lets the owner update name, description, contact channels, address, and category. Optional photo upload follows via the existing `media` flow. Small commit, parallel scope to the create-business wizard fields.
- **Richer bookings rows with display names instead of UUIDs.** The current owner bookings inbox shows raw `customerId`, `serviceId`, `staffId` UUIDs because the listing endpoint is denormalized. Two paths: (a) backend extension — embed customer name + service name + staff name into `AppointmentView`; (b) mobile side — issue parallel lookups against the existing services / staff listings + a new `GET /v1/me/customers` (admin-side) endpoint and project the names client-side. Path (a) is cleaner; either one is a follow-up commit.
- **Open-date availability override editor.** The current availability editor only adds **closed-date** overrides. Open-date overrides (a custom open window on a specific date, e.g. extended hours on a Saturday) use the same `POST /availability/override` endpoint with `isClosed: false` + real start/end times. Adding it is one new screen / sheet — same shape as the closed-date affordance. Also pending: a delete-override action.
- **No-show action.** The backend doesn't expose a `/v1/appointments/{id}/no-show` endpoint yet (the customer-side `AppointmentStatus` enum has `NO_SHOW` but no transition handler). Once the backend lands the endpoint, the owner bookings inbox grows a "Mark no-show" affordance on ACCEPTED rows that have passed their `startsAt` by > 30 min.
- **Push notifications (FCM / APNs).** Owners benefit even more than customers — incoming bookings need an immediate notification, not an in-app refresh. Out of MVP scope per `MVP_SCOPE.md`. Once it lands, pairs cleanly with the existing notification dispatcher on the backend (new `PUSH` channel in the gateway map) and resolves the owner-role-refresh gate above (a push to existing owners on group change can trigger a silent re-auth).
- **Business analytics.** Read-only dashboard for the owner (booking volume, revenue, top services, repeat-customer rate). Pairs with the marketplace-growth track in `PHASE_9_POST_MVP.md`. No backend migrations needed — reads from existing tables.

## Next recommended workstream

Two viable candidates depending on launch priorities. The operator picks based on real-traffic feedback after the owner surface lands in TestFlight / Play Store internal testing alongside the customer surface.

### Option A — Profile / edit-business polish

Close the last dashboard SnackBar stub. A `OwnerProfileScreen` (or modal sheet, mirroring services + staff) wrapping `PATCH /v1/businesses/{id}`. The owner can edit every field surfaced on the create wizard plus the optional photo upload via the existing `media` flow. Estimated ~2–3 days. The path that completes the owner-mobile surface to feature-parity with what the admin SPA exposes for owners — meaning the admin SPA can deprecate its owner-edit affordances and focus on admin-only review / suspension flows.

Pick this when the soft launch surfaces owners frustrated about not being able to edit their profile from the phone, or when the lack of a Profile screen blocks the App Store / Play Store review process.

### Option B — Telegram bot provider

Track 2 of `PHASE_9_POST_MVP.md`. Pair the existing SMS path with a Telegram-bot fallback (popular among Ethiopian customers and owners). Architecture is identical to the SMS gateway — new `TelegramNotificationGateway` implementing the existing `NotificationGateway` port + the dispatcher routing change + `users.telegram_chat_id` migration + linking flow. Estimated ~3–5 days. Owners benefit immediately: Telegram has push-style real-time delivery without requiring the FCM/APNs infrastructure that's still out of MVP scope.

Pick this when notification reliability is the bottleneck — owners missing bookings because SMS reminders arrive late, or customers who prefer Telegram.

### The third option

Neither — if the soft launch surfaces no urgent polish or notification-channel friction, the next track is **localization (Amharic)** or **KMS encryption migration** per the master Phase 9 doc. The owner surface itself is feature-complete; nothing in the current code paths gates the next track.

## Sign-off

| Reviewer       | Role     | Decision  | Notes                                                                                  |
| -------------- | -------- | --------- | -------------------------------------------------------------------------------------- |
| Engineering    | author   | approved  | All six commits on `main`; tests + analyze clean.                                      |
| Operations     | reviewer | pending   | Operator-side sign-off after the four gates above land — real-device + store-upload items. |
| Product        | reviewer | pending   | First TestFlight / Play Store internal-tester walkthrough with a BUSINESS_OWNER persona drives the final approval. |

Re-run on any of:

- New API contract change that touches the eleven owner-facing endpoints the mobile app consumes (`/me/business`, `/businesses`, `/businesses/{id}`, `/businesses/{id}/submit`, `/businesses/{id}/services[/{sid}]`, `/businesses/{id}/staff[/{sid}]`, `/businesses/{id}/staff/{sid}/availability`, `/businesses/{id}/staff/{sid}/availability/override`, `/businesses/{id}/appointments`, `/appointments/{id}/{accept,reject,cancel,complete}`).
- Material UX change to a screen that already shipped.
- Profile / edit-business screen rollout (separate sign-off doc).
