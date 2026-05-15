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
        login_screen.dart       Placeholder login (tap → fake signIn → browse)
      browse/
        browse_screen.dart      Placeholder home/browse tab + bottom nav
      bookings/
        bookings_screen.dart    Placeholder bookings tab
      profile/
        profile_screen.dart     Placeholder profile + env display + sign out
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

## What the scaffold ships

- ✅ Material 3 themed root app with a single navigator stack.
- ✅ Placeholder login screen — tap "Sign in", land on the home tab.
- ✅ Three-tab bottom navigation: Browse, Bookings, Profile.
- ✅ Browse tab — 4 placeholder category cards (Salons / Barbers / Spas / Beauty Pros).
- ✅ Profile tab — fake session info + env display + sign-out button.
- ✅ `AppConfig` + `AppConfigScope` inherited-widget pattern.
- ✅ `AuthService` port + `FakeAuthService` placeholder.
- ✅ `ApiClient` skeleton with a stable `baseUrl` getter and `UnimplementedError`-throwing method stubs.
- ✅ `flutter_lints` + strict analyzer settings.
- ✅ Widget smoke test confirming the login screen renders.

## What the scaffold deliberately does NOT ship

Each item below is on the immediate Phase 9 Track 3 backlog. The scaffold leaves a typed seam so the follow-up commits drop in cleanly.

- ❌ Real Cognito auth (PKCE via `flutter_appauth` or `amplify_auth_cognito`). The next mobile commit.
- ❌ Real HTTP client (Dio + auth-token interceptor + retry). Pairs with the OpenAPI-generated client.
- ❌ OpenAPI-generated Dart client from `backend/api/openapi.yaml`. Lands once the auth path is real so generated requests can be authenticated end-to-end.
- ❌ State management (Riverpod). Adopted when the first feature with non-trivial state lands — likely the slot picker or the booking funnel.
- ❌ Routing library (go_router). Adopted when the screen count crosses ~6.
- ❌ Per-platform scaffolding (`android/`, `ios/`, ...). Regenerated locally; iOS Info.plist edits for the `ethiolink://` URL scheme land in a follow-up.
- ❌ Localization beyond English. The `flutter_localizations` package is wired so a future `am.arb` bundle drops in without a pubspec change.
- ❌ Push notifications via FCM / APNs. Out of MVP scope per `docs/product/MVP_SCOPE.md`.
- ❌ Booking funnel, slot picker, business-owner flows. Each is a dedicated future commit.

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

**"Phase 9: wire Cognito PKCE auth"** — replace `FakeAuthService` with a real implementation that drives the `https://${cognitoDomain}/oauth2/authorize` flow via `flutter_appauth`, captures the `code` on the `ethiolink://auth/callback` deep-link redirect, exchanges it for tokens at `/oauth2/token`, stores the refresh token in `flutter_secure_storage`, and exposes the session to the `LoginScreen` via the existing `AuthService` port. Includes the iOS `Info.plist` URL-scheme entry and the Android `AndroidManifest.xml` intent filter. ~1–2 days of work.
