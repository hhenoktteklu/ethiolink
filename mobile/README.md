# EthioLink Mobile (Flutter)

A single Flutter codebase serving customer and business owner roles. Role gating is driven by the authenticated user's Cognito group (`CUSTOMER` / `BUSINESS_OWNER` / `ADMIN`).

This README documents the **Phase 9 Track 3 scaffold** — the minimum project structure required for the placeholder screens to render and for future feature commits to plug in cleanly. Real Cognito auth, the Dio + OpenAPI-generated API client, and per-feature business logic land in follow-up commits.

## Project layout

```
mobile/
  pubspec.yaml             Flutter package manifest
  analysis_options.yaml    Lint configuration (flutter_lints + overrides)
  .gitignore               Flutter / IDE / per-platform scaffolding ignores
  env/
    dev.example.json       Template for the dart-define-from-file values
    dev.json               (gitignored) operator-filled env values
  lib/
    main.dart              Entry point — loads config, runs the root widget
    app.dart               Root MaterialApp + theme + initial route
    core/
      config/
        app_config.dart         Resolved env config + bootstrap factory
        app_config_scope.dart   InheritedWidget for config access
      api/
        api_client.dart         HTTP client placeholder (Dio adapter lands later)
      auth/
        auth_service.dart       AuthService port + FakeAuthService placeholder
    features/
      auth/
        login_screen.dart       Login (Cognito PKCE; FakeAuthService in tests)
      booking/
        booking_flow_screen.dart  Wizard: staff → date → slot → confirm → success
        models/
          slot.dart               Slot value from /slots endpoint
          appointment.dart        Appointment / AppointmentView model
        data/
          booking_repositories.dart  Slots + Appointments ports + Http impls
      browse/
        browse_screen.dart        Browse tab — live /v1/categories
        businesses_screen.dart    Per-category business listing
        business_detail_screen.dart Detail page + services + staff + reviews
        models/                   category, business_summary, business_detail,
                                  service, staff, review
        data/                     businesses_repository, categories_repository,
                                  business_detail_repositories
      bookings/
        bookings_screen.dart    Placeholder bookings tab (history fetch lands next)
      owner/
        owner_tab.dart                          Role-gated "My Business" tab (Phase 9 Track 3.5)
        create_business_flow.dart               Multi-step DRAFT-create + submit-for-review wizard
        models/owner_business_view.dart         Owner-side BusinessOwnerView model (wraps BusinessDetail + status + ownerUserId)
        data/owner_business_repository.dart     GET /v1/me/business + failure-kind classifier
        data/business_actions_repository.dart   POST /v1/businesses + POST /v1/businesses/{id}/submit + failure-kind classifier
      profile/
        profile_screen.dart     Profile + env display + sign out
  test/
    widget_test.dart       Boot + placeholder-render smoke test
```

Per-platform scaffolding (`android/`, `ios/`, `web/`, etc.) is **not** committed. Operators regenerate it locally on the platform they target via `flutter create .` — see Step 1 below.

## Prerequisites

- **Flutter 3.22+ / Dart 3.4+.** Verify with `flutter doctor`. Match the `environment` block in `pubspec.yaml`.
- **A Cognito user pool** with a mobile app-client. Phase 7 provisions this — the dev outputs you need:
  - `cognito_hosted_ui_domain`     → `COGNITO_DOMAIN`
  - `cognito_mobile_app_client_id` → `COGNITO_CLIENT_ID`
  - `api_gateway_invoke_url`       → `API_BASE_URL`
- **iOS Simulator and/or Android Emulator** for local runs. Physical devices work; deep-link testing is easier on a real device because the simulator's URL handler is finicky with custom schemes.

## Setup — first time

1. **Generate the per-platform scaffolding.** From the repo root:
   ```bash
   cd mobile
   flutter create .
   ```
   This populates `android/`, `ios/`, `linux/`, `macos/`, `web/`, and `windows/` directories that the `.gitignore` keeps out of git. Running `flutter create` against an existing project is safe — it only writes missing files.

2. **Install dependencies.**
   ```bash
   flutter pub get
   ```

3. **Author your local env file.**
   ```bash
   cp env/dev.example.json env/dev.json
   # Edit env/dev.json — fill in the dev Cognito + API outputs.
   ```
   The file is gitignored. Each developer maintains their own; CI builds use the `--dart-define-from-file=env/ci.json` pattern with a CI-side secret.

4. **Run the app.**
   ```bash
   flutter run --dart-define-from-file=env/dev.json
   ```
   Or against any other env file (`env/staging.json`, `env/prod.json`) when those land.

The placeholder flow works end-to-end without any backend running — `FakeAuthService` simulates a 300 ms PKCE round-trip locally.

## Configuration contract

The app resolves four required + two optional values from compile-time constants. Pass them via `--dart-define-from-file=<json>` (preferred) or individual `--dart-define=KEY=value` flags:

| Key                       | Required | Default                          | Source                                                       |
| ------------------------- | -------- | -------------------------------- | ------------------------------------------------------------ |
| `API_BASE_URL`            | yes      | —                                | `terraform output -raw api_gateway_invoke_url`               |
| `COGNITO_DOMAIN`          | yes      | —                                | `terraform output -raw cognito_hosted_ui_domain` (+ `.auth.<region>.amazoncognito.com`) |
| `COGNITO_CLIENT_ID`       | yes      | —                                | `terraform output -raw cognito_mobile_app_client_id`         |
| `COGNITO_REDIRECT_URI`    | optional | `ethiolink://auth/callback`      | Must match Cognito's `callback_urls` exactly                 |
| `COGNITO_LOGOUT_URI`      | optional | `ethiolink://auth/logout`        | Must match Cognito's `logout_urls` exactly                   |
| `APP_ENV`                 | optional | `dev`                            | Free-form label surfaced in the placeholder UI               |

Missing any of the three required values throws `MissingConfigError` at boot — the app fails loud rather than booting half-wired.

## Cognito PKCE — platform deep-link setup

`CognitoAuthService` drives the PKCE flow via [`flutter_appauth`](https://pub.dev/packages/flutter_appauth). The callback URI `ethiolink://auth/callback` (and logout URI `ethiolink://auth/logout`) must be registered on **both** Cognito (handled by Terraform) and the native platforms (handled per-OS below). Skipping the platform step results in the system browser opening Cognito's hosted UI on sign-in but never returning to the app after the user signs in — the redirect succeeds at the IdP and then nothing happens.

Both platforms regenerate their scaffolding via `flutter create .`; the edits below are layered on top of the generated files.

### Android — `android/app/src/main/AndroidManifest.xml`

Add an intent filter to the launcher `Activity` so Android routes `ethiolink://auth/...` deep links back to the app:

```xml
<activity
    android:name=".MainActivity"
    ...
    android:launchMode="singleTask">
    <!-- existing MAIN / LAUNCHER intent filter stays as-is -->

    <intent-filter android:autoVerify="false">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data
            android:scheme="ethiolink"
            android:host="auth" />
    </intent-filter>
</activity>
```

`android:launchMode="singleTask"` is important — without it the Custom Tab launches a new activity instance on every sign-in attempt, and the redirect breaks.

In `android/app/build.gradle`, set the `appAuthRedirectScheme` manifest placeholder so `flutter_appauth` registers its own intent receiver:

```gradle
android {
    defaultConfig {
        ...
        manifestPlaceholders = [appAuthRedirectScheme: 'ethiolink']
    }
}
```

The scheme `ethiolink` is lowercase — Android matches schemes case-insensitively but the convention is lowercase + no version suffix.

### iOS — `ios/Runner/Info.plist`

Register the `ethiolink://` URL scheme so iOS routes deep links into the app:

```xml
<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleURLName</key>
        <string>app.ethiolink.callback</string>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>ethiolink</string>
        </array>
    </dict>
</array>
```

Cognito's `/oauth2/authorize` redirects to `ethiolink://auth/callback`; iOS dispatches that URL to the registered scheme and `flutter_appauth` resumes the token exchange.

iOS 11+ uses `ASWebAuthenticationSession` under the hood (system-managed; no `Info.plist` entitlement needed). On iOS 12+, the alternative `SFSafariViewController` path is auto-selected by `flutter_appauth` when the user has disabled the browser-session controller — both work without extra config.

### Verifying the deep link

After applying the edits + running `flutter run`, exercise the loop:

```
launch app → tap "Sign in" → hosted-UI in system browser → enter test credentials → browser closes → app lands on Browse tab
```

If the browser closes but the app stays on the LoginScreen, the deep link didn't resolve. Common causes:

- Intent filter or `CFBundleURLSchemes` missing or scheme typo.
- `appAuthRedirectScheme` manifest placeholder not set in Android.
- `redirectUri` env value doesn't match Cognito's `callback_urls` exactly (Cognito is strict — `ethiolink://auth/callback/` with trailing slash is a different URL).
- Cognito client ID typo — the IdP returns an error page in the browser; check the URL bar before the browser closes.

## What the scaffold ships

- ✅ Material 3 themed root app with a single navigator stack.
- ✅ Branded login screen — Cognito PKCE sign-in via `flutter_appauth` against the configured hosted-UI domain.
- ✅ Secure token cache via `flutter_secure_storage` (Keychain / Keystore). Refresh-on-near-expiry built into `CognitoAuthService.currentSession()`.
- ✅ Three-tab bottom navigation: Browse, Bookings, Profile.
- ✅ Browse tab — live `GET /v1/categories` fetch via `HttpCategoriesRepository` over Dio. Loading / success / empty / error states with a pull-to-refresh + retry button.
- ✅ Businesses listing — tap a category card → `BusinessesScreen` powered by `GET /v1/businesses?category=<slug>`. Loading / success / empty / error states; "Load more" button for cursor-paginated next pages (no infinite scroll yet). Per-business list item shows name, city, rating (or "No reviews yet"), and a "Featured" chip when `featuredUntil` is in the future.
- ✅ Business detail — tap a business row → `BusinessDetailScreen` composing four concurrent fetches: `GET /v1/businesses/{id}` (header, description, contact channels, address, rating), `/services` (bookable services with price + duration), `/staff` (active roster), `/reviews` (recent reviews with star glyphs). Each section renders its own loading / success / empty / error sub-state.
- ✅ Booking flow — tap "Book" on a service row → `BookingFlowScreen` wizard. Staff step (skipped when only one active staff member) → date picker (14 days) → slot grid powered by `GET /v1/businesses/{id}/staff/{sid}/slots` → confirmation recap → `POST /v1/appointments` (CASH only for MVP) → success screen with the appointment id. Error handling switches on the API error code: `SLOT_UNAVAILABLE` → "Pick another slot" with one-tap return to the slot step; `UNAUTHENTICATED` → sign-in-required panel; network / 5xx → generic retry.
- ✅ Bookings tab — live `GET /v1/me/appointments` list grouped into Upcoming + Past. Each row carries a status-coloured badge, the start time, and the price + payment method. Tap a row → `AppointmentDetailScreen` with the full booking metadata and the lifecycle actions: Cancel (visible while `REQUESTED`/`ACCEPTED`, optional reason) and Review (visible while `COMPLETED`, 1–5 stars + optional comment). 409 CONFLICT on cancel → "Past the cancellation cutoff" copy; 409 CONFLICT on review → "Already reviewed" copy.
- 🚧 Owner tab (Phase 9 Track 3.5 in progress) — role-gated 4th bottom-nav destination visible only when `session.role == 'BUSINESS_OWNER'`. Loads `GET /v1/me/business` via `HttpOwnerBusinessRepository` and branches on the outcome: 200 APPROVED → 5-card dashboard placeholder (Profile / Services / Staff / Availability / Bookings — each currently shows a "coming soon" SnackBar); 200 DRAFT or REJECTED → submit-for-review banner above the dashboard with a working "Submit for review" button that posts to `POST /v1/businesses/{id}/submit`; 200 PENDING_REVIEW or SUSPENDED → read-only "awaiting review" / "contact support" banner; 404 → "Create your business" CTA that pushes the `CreateBusinessFlow` wizard; 403 → "Sign out and back in" copy (stale `cognito:groups`); network → retry. CUSTOMER and ADMIN sessions don't see the tab.
- 🚧 Create-business flow (Phase 9 Track 3.5 in progress) — multi-step wizard reached from the 404 branch of the owner tab. Four input steps: basics (name, category dropdown sourced from `HttpCategoriesRepository`, city), contact (address, phone with loose validation, telegram handle, whatsapp number), description (English `LocalizedText.en`), review (read-only summary). Posts to `POST /v1/businesses` via `HttpBusinessActionsRepository`. Two terminal steps: draft-saved (with a working "Submit for review" button that posts to `POST /v1/businesses/{id}/submit`) and submitted (PENDING_REVIEW confirmation). Failure-kind classifier maps 400 → inline "Check your details" banner with the server message; 403 → "Access denied"; 409 → "You already have a business" (create) / "not in a submittable state" (submit); 500 → generic retry; network → "Can't reach the server". Returns the freshly-created `OwnerBusinessView` to the owner tab so the next read shows the new row immediately.
- ✅ Profile tab — session info + env display + working sign-out (clears secure storage + best-effort hosted-UI logout).
- ✅ `AppConfig` + `AppConfigScope` inherited-widget pattern.
- ✅ `AuthService` port with two implementations: `CognitoAuthService` (production) + `FakeAuthService` (tests + offline demo). `LoginScreen` accepts an optional override so widget tests stay platform-channel-free.
- ✅ `ApiClient` over Dio with an `AuthTokenInterceptor` — attaches `Authorization: Bearer <idToken>` when a session exists; public endpoints work without one. One-shot 401 retry after a token refresh.
- ✅ `CategoriesRepository` port with `HttpCategoriesRepository` over the `ApiClient`. `BrowseScreen` accepts a repository override so widget tests stay network-free.
- ✅ `flutter_lints` + strict analyzer settings.
- ✅ Widget tests covering login render + fake-auth tap + missing-config detection + BrowseScreen's loading / success / empty / error states + BrowseScreen role-gating of the "My Business" tab + OwnerTab's loading / APPROVED / PENDING_REVIEW / DRAFT / 404 / 403 / network branches + DRAFT-banner submit action + 404 CTA → CreateBusinessFlow navigation + CreateBusinessFlow happy-path create-then-submit + validation (empty required, missing category, invalid phone) + 409 conflict / 403 forbidden / 500 server-error banners. Unit tests covering id-token claim decoding + role precedence + Category JSON parsing + OwnerBusinessView parsing + OwnerBusinessRepository URL + 404/403/401/500 classification + BusinessActionsRepository request-body shape + create/submit URL + 400/403/409/500 classification.

## What the scaffold deliberately does NOT ship

Each item below is on the immediate Phase 9 Track 3 backlog. The scaffold leaves a typed seam so the follow-up commits drop in cleanly.
- ❌ OpenAPI-generated Dart client from `backend/api/openapi.yaml`. Lands once the auth path is real so generated requests can be authenticated end-to-end.
- ❌ State management (Riverpod). Adopted when the first feature with non-trivial state lands — likely the slot picker or the booking funnel.
- ❌ Routing library (go_router). Adopted when the screen count crosses ~6.
- ❌ Per-platform scaffolding (`android/`, `ios/`, ...). Regenerated locally; iOS Info.plist edits for the `ethiolink://` URL scheme land in a follow-up.
- ❌ Localization beyond English. The `flutter_localizations` package is wired so a future `am.arb` bundle drops in without a pubspec change.
- ❌ Push notifications via FCM / APNs. Out of MVP scope per `docs/product/MVP_SCOPE.md`.
- ❌ Owner edit-business form, services / staff / availability / bookings owner screens. The "My Business" tab + the create-business + submit-for-review wizard have landed (Track 3.5 in progress); every dashboard card still SnackBar-stubs. The next commit adds the services CRUD screens — services are the table appointments depend on, so it's the binding prerequisite for the staff / availability / bookings screens that follow.

## Running tests

```bash
flutter test
```

The current suite is two tests: the boot smoke test and the missing-config error path. Widget + integration tests for each feature screen land alongside the feature commits.

## Linting

```bash
flutter analyze
```

`analysis_options.yaml` adopts `flutter_lints` plus a tightened `strict-casts` / `strict-inference` / `strict-raw-types` set. The current scaffold is analyzer-clean.

## Next recommended mobile commit

**"Phase 9: add owner services CRUD"** — replace the Services dashboard-card SnackBar with a real screen. List → `GET /v1/businesses/{id}/services`; Create → `POST /v1/businesses/{id}/services` (name + duration + price + description); Edit → `PATCH /v1/businesses/{id}/services/{sid}`; Soft-delete → `DELETE /v1/businesses/{id}/services/{sid}`. Reuses the failure-kind classifier pattern. Services are the binding prerequisite for the staff and availability screens (staff are linked to services they perform; availability is per-staff but services drive durations) and for the bookings screen (every appointment carries a service id). After services land the owner can stand up a complete catalog → submit for review → admin approves → real customer bookings can flow.
