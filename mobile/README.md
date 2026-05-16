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
  l10n.yaml                Flutter gen-l10n config (arb-dir + output class)
  lib/
    main.dart              Entry point — loads config, runs the root widget
    app.dart               Root MaterialApp + theme + AppLocalizations + LocaleScope + initial route
    l10n/
      app_en.arb            English string bundle (source-of-truth for gen-l10n).
      app_am.arb            Amharic string bundle.
    core/
      config/
        app_config.dart         Resolved env config + bootstrap factory
        app_config_scope.dart   InheritedWidget for config access
      i18n/
        locale_scope.dart       App-level Locale state (LocaleController + LocaleScope notifier)
        locale_preferences.dart Secure-storage cache for the user's chosen locale
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
        browse_screen.dart        Browse tab — live /v1/categories + search input
        businesses_screen.dart    Per-category business listing
        business_detail_screen.dart Detail page + services + staff + reviews
        search_results_screen.dart Phase 9 Track 6 — `q` + filter chips + sort menu
        models/                   category, business_summary (with optional
                                  searchRank), business_detail, service, staff,
                                  review
        data/                     businesses_repository (BusinessSort enum +
                                  q/city/ratingMin/featuredOnly/sort args),
                                  categories_repository,
                                  business_detail_repositories
      bookings/
        bookings_screen.dart    Placeholder bookings tab (history fetch lands next)
      owner/
        owner_tab.dart                          Role-gated "My Business" tab (Phase 9 Track 3.5)
        create_business_flow.dart               Multi-step DRAFT-create + submit-for-review wizard
        owner_profile_screen.dart               Edit-business profile (PATCH /v1/businesses/{id})
        owner_promote_screen.dart               Paid featuring (Phase 9 Track 6) — loads active subscription + packages, drives POST subscribe
        owner_featuring_history_screen.dart     Featuring subscription history list (Phase 9 Track 6)
        owner_services_screen.dart              Services CRUD screen + create/edit modal sheet
        owner_staff_screen.dart                 Staff CRUD screen + create/edit modal sheet
        owner_availability_screen.dart          Per-staff weekly schedule editor + closed-date overrides
        owner_bookings_screen.dart              Owner appointments inbox + detail screen with accept/reject/cancel/complete actions
        models/owner_business_view.dart         Owner-side BusinessOwnerView model (wraps BusinessDetail + status + ownerUserId)
        models/availability.dart                AvailabilityWindow / AvailabilitySchedule + PUT-input + override-request value objects
        models/featuring.dart                   FeaturingPackage + FeaturingSubscription value objects (Phase 9 Track 6)
        data/owner_business_repository.dart     GET /v1/me/business + failure-kind classifier
        data/business_actions_repository.dart   POST /v1/businesses + POST /v1/businesses/{id}/submit + PATCH /v1/businesses/{id} + failure-kind classifier
        data/owner_services_repository.dart     GET/POST/PATCH/DELETE /v1/businesses/{id}/services[/{sid}] + failure-kind classifier
        data/owner_staff_repository.dart        GET/POST/PATCH/DELETE /v1/businesses/{id}/staff[/{sid}] + failure-kind classifier
        data/availability_repository.dart       GET/PUT /v1/.../availability + POST /v1/.../availability/override + failure-kind classifier
        data/owner_bookings_repository.dart     GET /v1/businesses/{id}/appointments + accept/reject/cancel/complete POSTs + failure-kind classifier
        data/featuring_repository.dart          GET packages/active/history + POST subscribe + failure-kind classifier (Phase 9 Track 6)
      profile/
        profile_screen.dart     Profile + env display + Telegram link entry + locale picker + sign out
        link_telegram_screen.dart       Telegram bot linking flow (Phase 9 Track 2)
        data/telegram_link_repository.dart  POST/GET/DELETE /v1/me/[link-telegram*|telegram-status]
        data/me_repository.dart         PATCH /v1/me { locale } + failure-kind classifier
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

### Phase 10 — Chapa hosted-checkout deep link

Online bookings + paid featuring open Chapa's hosted checkout in the system browser via `url_launcher.launchUrl(uri, mode: LaunchMode.externalApplication)`. After the customer completes (or cancels) payment, Chapa redirects to the operator-configured `chapa_return_url` — the backend env stack sets this to `ethiolink://payments/return`. The mobile app doesn't strictly need to consume the return URL — both the booking and the promote screens poll the relevant API endpoint after the launcher fires and surface the payment outcome from the server state — but registering the scheme means deep links from Chapa back into the app surface as a clean foreground transition rather than a "no app handles this URL" toast.

The Android intent filter + iOS `CFBundleURLSchemes` entries from the Cognito setup above already cover the `ethiolink://` scheme — no additional native edits are needed for the `ethiolink://payments/return` path. The backend env-stack variable name is `chapa_return_url` (commit `eed6885`) and the value must match the schemed URL exactly; trailing slashes are significant.

The screens that consume the redirect URL today:

- **Customer booking** — `BookingFlowScreen` confirm step shows a Cash / "Pay now (Chapa)" radio. Picking online + tapping Book hits `POST /v1/appointments` with `paymentMethod = "ONLINE_PENDING"`, opens `payment.redirectUrl` via the launcher, and transitions to a `_PaymentWaitingStep` that polls `GET /v1/me/appointments` every 3 s up to 90 s. CANCELLED rows surface as the failed branch; other statuses optimistically succeed (the server-side webhook is the canonical record).
- **Owner promote** — `OwnerPromoteScreen` purchase tap drives the same flow: `POST /v1/businesses/{id}/featuring/subscribe` → open Chapa checkout → poll `GET /v1/businesses/{id}/featuring/active` until it returns an ACTIVE subscription (or the budget exhausts). The screen replaces its body with a full-screen waiting overlay so the dashboard returns to the package cards on dismiss.

Both screens expose a `paymentRedirectorOverride` test seam so widget tests inject a fake launcher and never open a real browser.

## What the scaffold ships

- ✅ Material 3 themed root app with a single navigator stack.
- ✅ Branded login screen — Cognito PKCE sign-in via `flutter_appauth` against the configured hosted-UI domain.
- ✅ Secure token cache via `flutter_secure_storage` (Keychain / Keystore). Refresh-on-near-expiry built into `CognitoAuthService.currentSession()`.
- ✅ Three-tab bottom navigation: Browse, Bookings, Profile.
- ✅ Browse tab — live `GET /v1/categories` fetch via `HttpCategoriesRepository` over Dio. Loading / success / empty / error states with a pull-to-refresh + retry button.
- ✅ Businesses listing — tap a category card → `BusinessesScreen` powered by `GET /v1/businesses?category=<slug>`. Loading / success / empty / error states; "Load more" button for cursor-paginated next pages (no infinite scroll yet). Per-business list item shows name, city, rating (or "No reviews yet"), and a "Featured" chip when `featuredUntil` is in the future.
- ✅ Business detail — tap a business row → `BusinessDetailScreen` composing four concurrent fetches: `GET /v1/businesses/{id}` (header, description, contact channels, address, rating), `/services` (bookable services with price + duration), `/staff` (active roster), `/reviews` (recent reviews with star glyphs). Each section renders its own loading / success / empty / error sub-state.
- ✅ Booking flow — tap "Book" on a service row → `BookingFlowScreen` wizard. Staff step (skipped when only one active staff member) → date picker (14 days) → slot grid powered by `GET /v1/businesses/{id}/staff/{sid}/slots` → confirmation recap → `POST /v1/appointments` (CASH only for MVP) → success screen with the appointment id. Error handling switches on the API error code: `SLOT_UNAVAILABLE` → "Pick another slot" with one-tap return to the slot step; `UNAUTHENTICATED` → sign-in-required panel; network / 5xx → generic retry.
- ✅ Marketplace search (Phase 9 Track 6) — the browse tab carries a search input under the AppBar; submitting a non-empty query pushes `SearchResultsScreen`, which calls `GET /v1/businesses?q=<query>&sort=relevance` and renders the result rows with a filter-chip row (category bottom-sheet picker / city free-text dialog / rating ≥ 4 / featured-only) and a sort menu (best match → top rated → newest → featured first). Empty / whitespace-only submits are ignored. Loading / success / empty / error states mirror the existing listing screens; the empty state's "Clear filters" CTA resets every chip and re-runs the search. Repository: `HttpBusinessesRepository.list` widened with `q` / `city` / `ratingMin` / `featuredOnly` / `sort` named args plus a `BusinessSort` enum. ARB additions: `searchHint` / `searchResultsTitle` / `searchEmptyTitle` / `searchClearFiltersAction` / four sort-mode labels / `searchFeaturedOnly` / `searchRating4Plus` — English + Amharic; Amharic flagged for native-speaker review under the existing Track 5 hold.
- ✅ Bookings tab — live `GET /v1/me/appointments` list grouped into Upcoming + Past. Each row carries a status-coloured badge, the start time, and the price + payment method. Tap a row → `AppointmentDetailScreen` with the full booking metadata and the lifecycle actions: Cancel (visible while `REQUESTED`/`ACCEPTED`, optional reason) and Review (visible while `COMPLETED`, 1–5 stars + optional comment). 409 CONFLICT on cancel → "Past the cancellation cutoff" copy; 409 CONFLICT on review → "Already reviewed" copy.
- 🚧 Owner tab (Phase 9 Track 3.5 in progress) — role-gated 4th bottom-nav destination visible only when `session.role == 'BUSINESS_OWNER'`. Loads `GET /v1/me/business` via `HttpOwnerBusinessRepository` and branches on the outcome: 200 APPROVED → 5-card dashboard placeholder (Profile / Services / Staff / Availability / Bookings — each currently shows a "coming soon" SnackBar); 200 DRAFT or REJECTED → submit-for-review banner above the dashboard with a working "Submit for review" button that posts to `POST /v1/businesses/{id}/submit`; 200 PENDING_REVIEW or SUSPENDED → read-only "awaiting review" / "contact support" banner; 404 → "Create your business" CTA that pushes the `CreateBusinessFlow` wizard; 403 → "Sign out and back in" copy (stale `cognito:groups`); network → retry. CUSTOMER and ADMIN sessions don't see the tab.
- 🚧 Create-business flow (Phase 9 Track 3.5 in progress) — multi-step wizard reached from the 404 branch of the owner tab. Four input steps: basics (name, category dropdown sourced from `HttpCategoriesRepository`, city), contact (address, phone with loose validation, telegram handle, whatsapp number), description (English `LocalizedText.en`), review (read-only summary). Posts to `POST /v1/businesses` via `HttpBusinessActionsRepository`. Two terminal steps: draft-saved (with a working "Submit for review" button that posts to `POST /v1/businesses/{id}/submit`) and submitted (PENDING_REVIEW confirmation). Failure-kind classifier maps 400 → inline "Check your details" banner with the server message; 403 → "Access denied"; 409 → "You already have a business" (create) / "not in a submittable state" (submit); 500 → generic retry; network → "Can't reach the server". Returns the freshly-created `OwnerBusinessView` to the owner tab so the next read shows the new row immediately.
- 🚧 Owner services CRUD (Phase 9 Track 3.5 in progress) — `OwnerServicesScreen` pushed when the dashboard's Services card is tapped. List → `GET /v1/businesses/{id}/services` (loading / success / empty / error sub-states); FAB → "Add service" modal bottom sheet posting to `POST /v1/businesses/{id}/services`; tap a row → same sheet pre-filled for `PATCH /v1/businesses/{id}/services/{sid}`; trash-icon → confirmation dialog → `DELETE /v1/businesses/{id}/services/{sid}` (soft-delete). Form: name (required, `LocalizedText.en` shape), duration in minutes (required, 1–720), price ETB (optional, ≥ 0), description (optional). Inline validators on every field. Failure-kind classifier mirrors the create-business one: 400 → "Check your details" banner with the server message; 403 → "Access denied"; 404 → "Not found"; 409 → "Conflicting state"; 5xx/network → "Something went wrong" / "Can't reach the server". Every row shows ACTIVE/INACTIVE chip even though the listing endpoint filters out inactive — defensive for the corner case where the server flips a row between fetches.
- 🚧 Owner staff CRUD (Phase 9 Track 3.5 in progress) — `OwnerStaffScreen` pushed when the dashboard's Staff card is tapped. Mirrors the services-CRUD shape: list → `GET /v1/businesses/{id}/staff`; FAB → "Add staff" modal posting to `POST /v1/businesses/{id}/staff`; tap a row → same sheet pre-filled for `PATCH /v1/businesses/{id}/staff/{sid}`; trash-icon → confirm-then-`DELETE /v1/businesses/{id}/staff/{sid}` (soft-delete). Form: displayName (required, max 200), role (optional, max 100). The PATCH path supports clearing the role — emptying the field on edit sends `role: null` so the server clears the column. Inline validators surface "Display name is required.". Failure-kind classifier mirrors the services surface. Each row shows an avatar with the first character of the display name, the role under the name, and the ACTIVE/INACTIVE chip.
- 🚧 Owner availability editor (Phase 9 Track 3.5 in progress) — `OwnerAvailabilityScreen` pushed when the dashboard's Availability card is tapped. Top: staff dropdown sourced from the existing `OwnerStaffRepository`. Body: seven weekday cards (Sunday → Saturday) each listing existing weekly windows as `HH:MM` start/end `TextField`s with a delete-icon, plus an "Add interval" button per day. Save → `PUT /v1/businesses/{id}/staff/{sid}/availability` with all 7 days in one transaction (empty `windows[]` for a day communicates "closed all day"). Bottom: read-only overrides list + "Add closed date" button that opens a date picker and `POST`s a closed-day OVERRIDE (00:00–23:59 with `isClosed: true`) to `/availability/override`. Inline validators: `HH:MM` regex per field; "end must be after start" lexicographic check; "both required" for empty fields. Failure-kind classifier mirrors the rest of the owner surface. Open-date overrides land as a follow-up commit — this one ships closed-date overrides only, which is enough for the customer-side slot picker to compute real slots against an owner-curated schedule.
- 🚧 Owner bookings inbox (Phase 9 Track 3.5 in progress) — `OwnerBookingsScreen` pushed when the dashboard's Bookings card is tapped. Filter chips (Requested / Accepted / All) re-issue `GET /v1/businesses/{id}/appointments` with the matching status query param. Each row shows status badge, local start time, customer / service / staff IDs, and the price. Tap a row → `OwnerAppointmentDetailScreen` with status-keyed actions: REQUESTED → Accept / Reject; ACCEPTED → Cancel / Mark complete; REJECTED / CANCELLED / COMPLETED / NO_SHOW → read-only "No further actions available from this state." copy. Reject + Cancel open a dialog with an optional reason TextField (persisted on cancel; logged-but-not-persisted on reject per the MVP backend). 409 CONFLICT renders an action-specific inline banner ("Cannot accept — pull to refresh and check the latest status"). No no-show action — the backend doesn't expose one yet. Push notifications are explicitly out of scope.
- ✅ Owner profile editor (Phase 9 Track 3.5 polish) — `OwnerProfileScreen` pushed when the dashboard's Profile card is tapped. Form pre-filled from the loaded `OwnerBusinessView`: name, category dropdown (from `HttpCategoriesRepository`), city, address, phone, telegram handle, whatsapp number, description. Save → `PATCH /v1/businesses/{id}` with the populated fields; cleared optional strings encode as explicit `null` so the server clears the column. Validators mirror the create-business wizard (name + category + city required; phone / whatsapp loose regex if present). Failure-kind classifier renders action-keyed banners (403 → "Access denied"; 409 → "Conflicting state"; 5xx / network → generic retry / can't-reach-server). Closes the last dashboard SnackBar stub — every owner-side card on the My Business dashboard now opens a real screen.
- ✅ Owner Promote (Phase 9 Track 6 paid featuring) — `OwnerPromoteScreen` pushed when the dashboard's Promote card is tapped (the card sits between Profile and Services so the upsell is the first option after business identity). Parallel-loads `GET /v1/businesses/{id}/featuring/active` + `/featuring/packages` via `HttpFeaturingRepository`. Not-featured branch renders a 7-day (500 ETB) and 30-day (1500 ETB) package card with a Purchase button each that calls `POST /v1/businesses/{id}/featuring/subscribe { packageCode }`; success surfaces "Featured until {date}" in a SnackBar + flips the header to the featured branch. Featured branch hides the cards and renders `Featured until {endsAt}` plus a `Comped by admin` chip when `source == ADMIN_COMP`. Error surfaces: `FEATURING_DISABLED` / `ONLINE_PAYMENTS_UNAVAILABLE` (503) → "Not yet available" branch (paid featuring not enabled in env); `409 CONFLICT` on subscribe → "Already featured" inline banner (rare race); `402 PAYMENT_REQUIRED` → "Payment failed" inline banner; `401` / `403` / `404` / network → standard reload banners. The AppBar carries a history icon that pushes `OwnerFeaturingHistoryScreen` (a newest-first list of every subscription with PENDING / ACTIVE / EXPIRED / CANCELLED / REFUNDED status chips + `PURCHASED` / `COMPED` source chips + cancellation reason on cancelled rows). The MVP gateway is the backend's `CashGateway` (no real Telebirr / Chapa integration yet) — subscribe returns ACTIVE immediately on success.
- ✅ Profile tab — session info + env display + working sign-out (clears secure storage + best-effort hosted-UI logout). The "Notifications" section exposes a **Telegram** row that opens the `LinkTelegramScreen`.
- ✅ Telegram linking (Phase 9 Track 2) — `LinkTelegramScreen` reached from the Profile tab. `HttpTelegramLinkRepository` drives `POST /v1/me/link-telegram/start` + `GET /v1/me/telegram-status` + `DELETE /v1/me/link-telegram` with a `TelegramLinkFailureKind` enum (unconfigured / unauthenticated / notFound / network / other). Five branches: loading (spinner), not-linked (CTA), linked (linkedAt + Unlink), unconfigured-503 ("Telegram is not yet enabled for this environment" copy + no CTA — graceful when the operator hasn't wired Telegram), error+retry. Link flow: tap CTA → POST start → open `t.me/<bot>?start=<code>` via `url_launcher` (test seam: injectable `LinkLauncher`) → poll status every 3 s for up to 90 s with a manual "I linked it — check now" button + cancel option → flips to linked branch when the bot redeems the code. Poll-exhausted branch shows restart-link + check-now buttons. Unlink calls the DELETE endpoint and snaps back to not-linked.
- ✅ `AppConfig` + `AppConfigScope` inherited-widget pattern.
- ✅ `AuthService` port with two implementations: `CognitoAuthService` (production) + `FakeAuthService` (tests + offline demo). `LoginScreen` accepts an optional override so widget tests stay platform-channel-free.
- ✅ `ApiClient` over Dio with an `AuthTokenInterceptor` — attaches `Authorization: Bearer <idToken>` when a session exists; public endpoints work without one. One-shot 401 retry after a token refresh.
- ✅ `CategoriesRepository` port with `HttpCategoriesRepository` over the `ApiClient`. `BrowseScreen` accepts a repository override so widget tests stay network-free.
- ✅ `flutter_lints` + strict analyzer settings.
- ✅ Widget tests covering login render + fake-auth tap + missing-config detection + BrowseScreen's loading / success / empty / error states + BrowseScreen role-gating of the "My Business" tab + OwnerTab's loading / APPROVED / PENDING_REVIEW / DRAFT / 404 / 403 / network branches + DRAFT-banner submit action + 404 CTA → CreateBusinessFlow navigation + CreateBusinessFlow happy-path create-then-submit + validation (empty required, missing category, invalid phone) + 409 conflict / 403 forbidden / 500 server-error banners + OwnerServicesScreen list / empty / error states + create-happy-path + edit-happy-path + deactivate-confirmation + create-validation (empty / duration / negative price) + create-403 access-denied banner + OwnerStaffScreen list / empty / error + create-happy-path + edit-happy-path + clear-role-on-edit + deactivate-confirmation + create-validation (empty displayName) + create-403 access-denied banner + OwnerAvailabilityScreen no-staff prompt + staff-load error + pick-staff-loads-schedule + add/remove weekly window + save-happy-path PUTs 7 days + validation (empty / end ≤ start) + add closed-date override POSTs and renders + initial-overrides render + OwnerBookingsScreen empty / list / error + filter chips refetch + tap-row → detail Accept / Reject (with reason dialog) / Cancel (with reason dialog) / Mark complete happy paths + 409 conflict banner + REJECTED detail read-only hint. Unit tests covering id-token claim decoding + role precedence + Category JSON parsing + OwnerBusinessView parsing + OwnerBusinessRepository URL + 404/403/401/500 classification + BusinessActionsRepository request-body shape + create/submit URL + 400/403/409/500 classification + OwnerServicesRepository request shapes (list / create / patch / delete) + clear-description / clear-price PATCH semantics + 400/403/404/409/500 classification + OwnerStaffRepository request shapes (list / create / patch / delete) + clearRole PATCH semantics + 400/403/404/409/500 classification + AvailabilityWindow / AvailabilitySchedule JSON parsing + weeklyByDay grouping + WeeklyDayInput / AvailabilityOverrideRequest encoding + AvailabilityRepository request shapes (get / put / post override) + 400/403/404 classification + OwnerBookingsRepository list URL + query params + accept/reject/cancel/complete URLs + reject/cancel body (with and without reason) + 403/409 classification (with action label) + OwnerPromoteScreen loading / not-featured / featured / comp-badge / purchase-success / busy-spinner / FEATURING_DISABLED / ALREADY_ACTIVE / PAYMENT_REQUIRED / network states + OwnerFeaturingHistoryScreen empty / populated (with PURCHASED + COMPED chips) / cancelled-reason / network states + HttpFeaturingRepository request shapes (list packages / subscribe with `{packageCode}` / get active with nullable parse / list history with optional `limit`) + 503 FEATURING_DISABLED + 503 ONLINE_PAYMENTS_UNAVAILABLE + 409 / 402 / 401 / 403 / 400 / 500 / 404 classification + OwnerTab Promote card renders + navigates to OwnerPromoteScreen.

## What the scaffold deliberately does NOT ship

Each item below is on the immediate Phase 9 Track 3 backlog. The scaffold leaves a typed seam so the follow-up commits drop in cleanly.
- ❌ OpenAPI-generated Dart client from `backend/api/openapi.yaml`. Lands once the auth path is real so generated requests can be authenticated end-to-end.
- ❌ State management (Riverpod). Adopted when the first feature with non-trivial state lands — likely the slot picker or the booking funnel.
- ❌ Routing library (go_router). Adopted when the screen count crosses ~6.
- ❌ Per-platform scaffolding (`android/`, `ios/`, ...). Regenerated locally; iOS Info.plist edits for the `ethiolink://` URL scheme land in a follow-up.
- ✅ **Localization — English + Amharic.** Phase 9 Track 5 closed on the mobile side. `flutter_localizations` + Flutter's built-in `gen-l10n` are wired through `l10n.yaml` + `lib/l10n/app_en.arb` + `lib/l10n/app_am.arb`; `MaterialApp` resolves `AppLocalizations.localizationsDelegates` + `AppLocalizations.supportedLocales` (`[en, am]`). The visible English copy on login, the bottom-nav, the profile + bookings + owner-dashboard surfaces, and the booking-flow confirm + success steps reads from `AppLocalizations.of(context)`. The Profile tab carries a language picker (English / አማርኛ) — tapping a row drives `PATCH /v1/me { locale }` via `HttpMeRepository`, then flips `LocaleScope` on success and persists the pick to `flutter_secure_storage` via `SecureLocalePreferences` so the next cold-start renders in the chosen language before the network round-trip. Failures surface a SnackBar with localized copy and leave the active locale untouched — the server-side `users.locale` row stays canonical.
- ❌ Push notifications via FCM / APNs. Out of MVP scope per `docs/product/MVP_SCOPE.md`.
- ❌ Open-date availability overrides, owner-side `no-show` action (backend not yet exposed), push notifications, business analytics, business cover photos / media polish. With the profile editor landed, every dashboard card on the My Business tab opens a real screen — Track 3.5 is closed end-to-end. The remaining deferred items are all post-MVP polish that pair with backend or infrastructure work tracked in `PHASE_9_POST_MVP.md`.

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

**"Phase 9 Track 2: add Telegram bot provider"** — pair the existing SMS path with a Telegram-bot fallback (popular among Ethiopian customers and owners). Architecture mirrors the SMS gateway: new `TelegramNotificationGateway` implementing the existing `NotificationGateway` port + dispatcher routing change + `users.telegram_chat_id` migration + linking endpoint (`POST /v1/me/link-telegram`) the mobile + admin SPA can drive. Estimated ~3–5 days. Telegram has push-style real-time delivery without the FCM/APNs infrastructure that's still out of MVP scope, so the owner-mobile bookings inbox immediately benefits from incoming-booking notifications even before push notifications proper land. Once it ships, the owner can receive a Telegram ping the moment a customer books — closing the last operational gap in the Track 3.5 loop where owners have to refresh manually to see new requests. Track 3.5 itself is feature-complete: every dashboard card on the My Business tab opens a real screen.
