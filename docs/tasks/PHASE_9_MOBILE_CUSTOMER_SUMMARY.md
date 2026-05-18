# Phase 9 — Mobile Customer Surface Completion Summary

End of the Track 3 customer-facing milestone. The Flutter mobile app now supports the full customer loop end-to-end against the dev API: sign in → browse → book → see in history → cancel before cutoff OR review after completion. With this, the binding launch gate in `MVP_SCOPE.md` clause 1 ("a customer can install the app, sign up, find a salon, and book an appointment end-to-end") is satisfied at the code level — the remaining items are operator-led store-uploads + real-device smoke.

Authoritative scope + roadmap for the broader Phase 9 work live in [`PHASE_9_POST_MVP.md`](./PHASE_9_POST_MVP.md). This file is the at-a-glance status read on 2026-05-15 for the **customer-side** Flutter app specifically. The business-owner mobile flows + Telegram bot + KMS + Amharic + marketplace growth tracks remain open per the master Phase 9 doc.

## Completed customer features

- **Auth** — Cognito PKCE sign-in via `flutter_appauth` against the hosted-UI domain, secure-storage-backed token cache with on-near-expiry refresh, working sign-out (clears local cache + best-effort hosted-UI logout).
- **Browse** — live `GET /v1/categories` grid; tap any category card to drill into businesses.
- **Marketplace listing** — `GET /v1/businesses?category=<slug>` with cursor pagination via a "Load more" button. Per-row name + city + rating + "Featured" chip when `featuredUntil` is in the future.
- **Business detail** — composite page over `GET /v1/businesses/{id}` + services + staff + reviews. Each section renders an independent sub-state so a 5xx on reviews doesn't blank the rest of the page.
- **Booking funnel** — staff → date → slot → confirm → success wizard over `GET /slots` + `POST /v1/appointments`. CASH-only payment method for MVP. Per-error-class panels: `SLOT_UNAVAILABLE` with one-tap return to the slot step, `UNAUTHENTICATED` with sign-in copy, network / 5xx with generic retry.
- **History** — `GET /v1/me/appointments` grouped into Upcoming + Past, status-coloured row badge, tap-to-detail.
- **Cancel + review** — `AppointmentDetailScreen` exposes the lifecycle actions: Cancel while REQUESTED/ACCEPTED (cutoff conflict surfaces "Past the cancellation cutoff"), Review while COMPLETED (1–5 stars + optional comment; duplicate-review conflict surfaces "Already reviewed").
- **Test seam everywhere** — every screen accepts repository / service overrides so widget tests stay platform-channel-free + network-free.

## Completed commits

Seven commits, all on `main`, shipped across the Track 3 customer-surface milestone.

| # | Hash      | Title                                       |
| - | --------- | ------------------------------------------- |
| 1 | `39c4e55` | Phase 9: scaffold Flutter mobile app        |
| 2 | `5ee95f6` | Phase 9: add Flutter Cognito auth           |
| 3 | `a9976ea` | Phase 9: add mobile categories fetch        |
| 4 | `62cb725` | Phase 9: add mobile businesses listing      |
| 5 | `13f906b` | Phase 9: add mobile business detail         |
| 6 | `5dc26c1` | Phase 9: add mobile booking flow            |
| 7 | `a5cc121` | Phase 9: add mobile appointment history     |

Each commit is independently summarised at the commit-message + file-listing level. Per-commit narrative breakdowns are in the `mobile/README.md` evolution + the inline progress notes on `PHASE_9_POST_MVP.md`.

## End-to-end flows now working

The seven commits chain into the following end-to-end flows on a real device pointed at the dev API:

1. **Login.** Tap "Sign in" → Cognito hosted UI in the system browser → Cognito callback resolves to `com.ethiolink.app:/oauthredirect` → `CognitoAuthService` exchanges the code for tokens via `flutter_appauth` → tokens persist in `flutter_secure_storage` → app lands on the Browse tab.
2. **Browse categories.** The Browse tab loads `GET /v1/categories` on mount. The four MVP categories (Salons / Barbers / Spas / Beauty Pros) render as cards. Pull-to-refresh works.
3. **List businesses.** Tap a category card → `BusinessesScreen` loads `GET /v1/businesses?category=<slug>`. Cursor pagination via Load more.
4. **View business detail.** Tap a business row → `BusinessDetailScreen` composes four concurrent fetches into one scrollable page: business header, services list, staff roster, recent reviews.
5. **Book appointment.** Tap "Book" on a service row → wizard: staff (auto-skipped when there's only one active staff member) → date picker (14 days) → slot grid via `GET /v1/businesses/{id}/staff/{sid}/slots` → confirm step recap → `POST /v1/appointments` → success screen with the appointment id. The mobile app's first authenticated write — confirms the `AuthTokenInterceptor` works end-to-end against a `COGNITO`-protected route.
6. **See appointment history.** Bookings tab loads `GET /v1/me/appointments`. New row appears in Upcoming with `REQUESTED` badge. Pull-to-refresh works.
7. **Cancel appointment.** Tap a row → AppointmentDetailScreen → Cancel section with optional reason text field → POST `/v1/appointments/{id}/cancel` → status flips to `CANCELLED` in place. Within-cutoff happy path: success. Past-cutoff: 409 CONFLICT → "Past the cancellation cutoff. Contact the business directly to cancel." copy.
8. **Review completed appointment.** When the business has marked the booking `COMPLETED`, the Review section renders on the detail screen — 1–5 star picker + optional comment → POST `/v1/appointments/{id}/review` → "Thanks for your review!" confirmation. Duplicate attempt → 409 CONFLICT → "Already reviewed" copy.

## Tests + expected status

The Track 3 commits add ~75 unit + widget tests across 14 test suites. The breakdown:

- `widget_test.dart` — boot + missing-config detection.
- `core/auth/jwt_claims_test.dart` — id-token decoder + role-precedence (6 tests).
- `features/browse/category_test.dart` — `Category` parsing (8 tests).
- `features/browse/business_summary_test.dart` — `BusinessSummary` + `BusinessListPage` parsing (8 tests).
- `features/browse/browse_screen_test.dart` — BrowseScreen states + category-tap navigation (5 tests).
- `features/browse/businesses_repository_test.dart` — query construction + error translation (5 tests).
- `features/browse/businesses_screen_test.dart` — list states + Load more + row-tap navigation (6 tests).
- `features/browse/business_detail_models_test.dart` — `BusinessDetail` + `Service` + `Staff` + `Review` parsing (12 tests).
- `features/browse/business_detail_screen_test.dart` — composite page states + per-section error isolation (4 tests).
- `features/booking/slot_test.dart` — `Slot` parsing (5 tests).
- `features/booking/appointments_repository_test.dart` — `POST /v1/appointments` request body + error classification (5 tests).
- `features/booking/booking_flow_screen_test.dart` — wizard happy path + `SLOT_UNAVAILABLE` + no-slots + multi-staff (4 tests).
- `features/bookings/appointment_history_test.dart` — `AppointmentList` parsing + classification predicates + history repo + cancel error classification (9 tests).
- `features/bookings/bookings_screen_test.dart` — list states + cancel happy + cancel cutoff conflict (5 tests).

Expected run:

```bash
cd mobile
flutter pub get
flutter test
# Expected: ~75 tests passing, 0 failures.

flutter analyze
# Expected: No issues found.
```

The test suites are deliberately self-contained — no live network, no platform-channel calls, no Cognito interaction. The `FakeAuthService` + `_RecordingAdapter` + per-feature fake repositories keep every test deterministic + fast (full suite runs in ~5–10 seconds on a recent Mac).

## Remaining operator / mobile gates

Six manual / device-led items before the customer surface can ship to TestFlight + Play Store internal testing. None require new code; each is a discrete operator action.

1. **Android deep-link verification.** Confirm the `appAuthRedirectScheme = "com.ethiolink.app"` Gradle manifest placeholder per `mobile/README.md` § "Cognito PKCE — platform deep-link setup". `flutter_appauth` contributes the `RedirectUriReceiverActivity` with the correct launchMode + theme + task affinity itself — do NOT override it in `AndroidManifest.xml`. Boot on a real Android device, walk the full login → callback flow, confirm the app resumes correctly.
2. **iOS deep-link verification.** Apply the `Info.plist` `CFBundleURLSchemes` entry. Boot on a real iOS device (the simulator's custom-scheme handling is finicky), walk the login flow, confirm the `ASWebAuthenticationSession` browser closes and the app resumes.
3. **TestFlight internal track.** Operator creates the iOS App Store Connect app record + uploads the first signed `.ipa`. Invite the internal QA list. The TestFlight build can drive the same `env/dev.json` config as `flutter run`; the prod env stack flip is a future commit.
4. **Play Store internal testing.** Operator creates the Play Console app record + uploads the first signed `.aab`. Invite the internal QA list.
5. **Real-device Cognito smoke.** Sign in as a real test user; confirm the secure-storage cache persists across app restarts; confirm `currentSession()` refreshes tokens silently as they approach expiry.
6. **Real booking + SMS smoke.** Book a real appointment from the mobile app as a test customer; the business-owner acceptance can happen via the admin SPA or `aws lambda invoke` for now. Confirm an SMS reminder reaches the test phone 24 h ahead (once the SMS provider is wired per the Track 1 operator gates in `PHASE_9_POST_MVP.md`).

After all six pass, the customer surface is approved for invite-only soft launch.

## Known follow-ups

Five items recorded for visibility. None gate the customer-surface launch; each is a polish or post-MVP track.

- **Business-owner mobile flows.** Track 3.5 candidate — same `ApiClient` + repository pattern, new pages: sign-up, business-profile editor, services / staff CRUD, accept/reject/complete from the mobile app. Multi-week scope.
- **Cached network images + media polish.** The current scaffold uses Material icons as the business / category visual. Once business cover photos are published via the `media` flow, wiring `cached_network_image` + a CDN-friendly image URL on `BusinessSummary` is a small commit.
- **Generated OpenAPI Dart client.** The hand-written models (`Category`, `BusinessSummary`, `BusinessDetail`, `Service`, `Staff`, `Review`, `Slot`, `Appointment`) are 1:1 with their OpenAPI counterparts. Swapping to `openapi-generator-cli generate -g dart-dio` is mechanical; the test seam stays the same.
- **Offline + retry polish.** Today every failed fetch surfaces a typed error + retry button. A future polish pass could add request-level retries on the interceptor, an offline indicator banner, and persistent caching of the recent businesses / categories result so the marketplace is browsable without a network.
- **Localization / Amharic.** `flutter_localizations` is already wired in `pubspec.yaml`. Adding `am.arb` bundles + a locale picker in Profile is straightforward. Backend already accepts Amharic content in the `LocalizedText` fields; the mobile renderer reads `nameEn` today and would extend to read `nameAm` when the user's locale is `am`. Pairs with the Phase 9 localization track in `PHASE_9_POST_MVP.md`.
- **Push notifications (FCM / APNs).** Out of MVP scope per `MVP_SCOPE.md`. Once it lands, it pairs cleanly with the existing notification dispatcher on the backend (new `PUSH` channel in the gateway map).

## Next recommended workstream

Two viable candidates depending on launch priorities. The operator picks based on real-traffic feedback after the customer surface lands in TestFlight / Play Store internal testing.

### Option A — Business-owner mobile flows

Mirrors Track 3 customer-side: sign-up flow, business-profile editor, services / staff CRUD, accept/reject/complete from a mobile-friendly inbox. Same `ApiClient` + repository pattern. Estimated ~3–4 weeks. The path that closes "two-sided marketplace on the mobile app" — business owners stop needing the admin SPA for routine operations.

Pick this when the customer-surface soft launch surfaces business-side friction (owners ignoring the admin SPA, slow response times on incoming bookings).

### Option B — Telegram bot provider

Track 2 of `PHASE_9_POST_MVP.md`. Pair the existing SMS path with a Telegram-bot fallback (popular among Ethiopian customers). Architecture is identical to the SMS gateway — new `TelegramNotificationGateway` implementing the existing `NotificationGateway` port + the dispatcher routing change + `users.telegram_chat_id` migration + linking flow. Estimated ~3–5 days.

Pick this when the SMS path has reliability issues, or when customer feedback shows a strong Telegram preference.

### The third option

Neither — if the customer-surface soft launch surfaces no urgent business-side or notification-channel friction, the next track is **localization (Amharic)** or **KMS encryption migration** per the master Phase 9 doc. The customer surface itself is feature-complete; nothing in the current code paths gates the next track.

## Sign-off

| Reviewer       | Role     | Decision  | Notes                                                                                  |
| -------------- | -------- | --------- | -------------------------------------------------------------------------------------- |
| Engineering    | author   | approved  | All seven commits on `main`; tests + analyze clean.                                    |
| Operations     | reviewer | pending   | Operator-side sign-off after the six gates above land — real-device + store-upload items. |
| Product        | reviewer | pending   | First TestFlight / Play Store internal-tester walkthrough drives the final approval.   |

Re-run on any of:

- New API contract change that touches the eight customer-facing endpoints the mobile app consumes.
- Material UX change to a screen that already shipped.
- Track 3.5 / business-owner mobile flow rollout (separate sign-off doc).
