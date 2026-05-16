# Phase 9 Track 5 — Localization completion summary

This document closes Phase 9 Track 5 (Amharic / native localization). It records what shipped, what the engineering team verified, what's left for the operator team to gate before broad rollout, and the deferred follow-ups that pair naturally with later workstreams.

## Goal

Make the EthioLink customer + business-owner experience fully usable by native Amharic speakers. Concretely: every user-visible string in the customer-side mobile app and every booking-lifecycle notification reaches the user in the language they selected, with the choice persisted server-side so it survives across devices and is the source of truth for both UI and notifications.

Out of scope for this track: localizing operator-facing surfaces (admin SPA), translating user-authored business / service / category content beyond the existing `LocalizedText` JSONB shape, and FCM/APNs push notifications (still deferred per `MVP_SCOPE.md`).

## Completed commits

| Commit hash | Title | What it landed |
| ----------- | ----- | -------------- |
| `ec9939d`   | `Phase 9: add localization foundation` | Migration 0016 (`users.locale`), `PATCH /v1/me { locale }`, `UserView.locale`, registry signature widening + English-only renderers with fallback to English. |
| `747b1aa`   | `Phase 9: add Amharic notification templates` | Amharic renderers for all eight booking template keys + deterministic Amharic date/time formatting. |
| `2e14983`   | `Phase 9: add Flutter i18n scaffold` | `l10n.yaml`, `app_en.arb`, `LocaleScope`, `AppLocalizations` wired into `MaterialApp`, visible English strings refactored onto the bundle. |
| `f42859a`   | `Phase 9: add Amharic mobile locale picker` | `app_am.arb`, Profile-tab language picker, `HttpMeRepository`, `SecureLocalePreferences` cache, picker tests. |

## Completed backend / API work

The user-data + notification surfaces are end-to-end locale-aware. Specifically:

- **`users.locale` column.** Migration `0016_users_locale.sql` adds `locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'am'))`. Existing rows backfill to `'en'` via the column default — no data move required, no behavior change for users who never opt in.
- **Domain model.** `UserLocale` type + `SUPPORTED_USER_LOCALES` constant; `User.locale` field; `UpdateUserFields.locale?: UserLocale` (`undefined` = no change, `null` rejected because the column is `NOT NULL`); new `setLocale(id, locale)` on the `UserRepository` interface; partial-update SQL in `PgUserRepository.update` uses a `CASE WHEN $bool THEN $value ELSE col END` pattern so the two-field patch (`displayName` + `locale`) avoids COALESCE / NULL-mixing hazards. The `InMemoryUserRepository` fake mirrors every behavior.
- **`PATCH /v1/me { locale }`.** Accepts `'en'` or `'am'`; anything else is a 400 `VALIDATION_ERROR` with a field-specific details payload. `null` is rejected (the column is `NOT NULL`). The OpenAPI `User` schema now requires `locale`; the `PatchMeRequest` schema documents the enum.
- **`UserView.locale`.** The wire shape for `/v1/auth/sync` and `/v1/me` carries `locale` so the Flutter app reads it at sign-in and primes its UI locale.
- **Localized notification rendering.** `renderTemplate(key, payload, locale = 'en')` is keyed `template × locale`. English + Amharic renderers ship for every booking template key (`booking.requested.business`, `booking.accepted.customer`, `booking.rejected.customer`, `booking.cancelled.business`, `booking.cancelled.customer`, `booking.rescheduled.business`, `booking.reminder.customer`, `booking.reminder.business`). The dispatcher reads `user.locale` from the recipient row and threads it through. Amharic copy uses a hand-rolled weekday + month abbreviation table + ጥዋት / ከሰዓት meridiem so output is deterministic regardless of the Node ICU build; proper nouns (business / service / customer display name) pass through verbatim; cancellation-reason and reschedule-notes suffixes pick up Amharic labels (ምክንያት / ማስታወሻ). Registry fallback to English still applies if a future locale lands without all renderers — widening `users.locale` is safe ahead of any future translation pass.

## Completed mobile work

The Flutter app is fully Amharic-capable on every surface that flows through `AppLocalizations`:

- **`AppLocalizations` scaffold.** `mobile/l10n.yaml` + `flutter.generate: true` in `pubspec.yaml` wire Flutter's `gen-l10n`. `MaterialApp` resolves `AppLocalizations.localizationsDelegates` + `AppLocalizations.supportedLocales` (now `[en, am]`). A `LocaleScope` (`InheritedNotifier<LocaleController>`) publishes the active `Locale` to `MaterialApp.locale` and rebuilds the tree when it changes.
- **English + Amharic ARB bundles.** `lib/l10n/app_en.arb` carries every customer-visible label that was previously a hardcoded literal — login, bottom-nav (`navBrowse`, `navBookings`, `navOwner`, `navProfile`), profile, booking flow (`bookingFlowConfirmTitle`, `bookingFlowConfirmAction`, `bookingFlowBookingInProgress`, `bookingFlowSuccessTitle`, `bookingFlowDone`, `bookingFlowPickAnotherSlot`), bookings tab title, owner empty-state + access-denied + the five dashboard card labels. `lib/l10n/app_am.arb` mirrors every key plus three picker-specific keys (`profileLanguageHeading`, `profileLanguageSaving`, `profileLanguageSaveError`). Proper nouns like "EthioLink" stay in their original script in both bundles.
- **Profile-tab language picker.** A "Language" section under the existing Notifications block exposes two `RadioListTile`s (`English`, `አማርኛ`) — each labelled in its own native script so a user can identify the right row regardless of current UI language. Stable `ValueKey('localeOption.{code}')`s back the widget tests. Picker is server-authoritative: the UI flips only after `PATCH /v1/me` succeeds.
- **Secure local cache.** `SecureLocalePreferences` (backed by `flutter_secure_storage` under key `ethiolink.user.locale`) persists the picked locale. The root `EthioLinkApp` reads the cache during `initState` so a returning user lands directly in their chosen language on cold-start, before the `GET /v1/me` round-trip completes. `InMemoryLocalePreferences` is the test seam.
- **Backend locale sync.** `HttpMeRepository.patchLocale(code)` drives `PATCH /v1/me { locale }`. Failure-kind classifier (`validation`, `unauthenticated`, `notFound`, `network`, `other`) mirrors the rest of the mobile codebase. On failure the picker shows a SnackBar with the localized `profileLanguageSaveError` copy and leaves the active locale at its previous value — the server-side `users.locale` row stays canonical.

## Behavior impact

- **English is unchanged.** Every English string is byte-identical to what shipped before Track 5 — both in the Flutter app and in notification bodies. Existing customers see no UI difference until they explicitly pick Amharic.
- **Amharic is opt-in per user.** The locale flips only via the Profile-tab picker; nothing in the app auto-detects an Amharic platform locale yet. The default for new users is `'en'` (the column default in migration 0016).
- **Notifications follow the same row.** Once a user flips to Amharic, the next booking event (request / accept / reject / cancel / reschedule / 24h reminder) renders with the Amharic template. No SMS or Telegram routing changed — Amharic bodies flow through the same gateways that already shipped.
- **Returning users land in their chosen language on cold-start** thanks to the secure-storage cache. If the cache is cleared (reinstall, device migration), the next `GET /v1/me` will re-prime it once the user signs in.
- **Forward-safe registry fallback.** If a third locale (e.g. Tigrinya) is added to `users.locale` ahead of the matching ARB / template translation pass, the registry transparently falls back to English. No outage path.

## Tests added

| Layer | Test file | What it covers |
| ----- | --------- | -------------- |
| Backend | `backend/tests/users/userService.test.ts` | Locale round-trip, `displayName + locale` combined patch, omission preservation. |
| Backend | `backend/tests/notifications/templateRegistry.test.ts` | Every key renders non-empty English; every key renders non-empty Amharic; bodies differ; proper nouns pass through; date format uses Amharic weekday + month + ጥዋት/ከሰዓት; unsupported locale falls back to English. |
| Backend | `backend/tests/notifications/notificationService.test.ts` | Default-locale recipient receives English body; `am`-locale recipient receives Amharic body containing Ethiopic glyphs + "ተቀብለዋል"; same payload, different locales, different bodies. |
| Backend | `backend/tests/notifications/sendReminders.test.ts`, `backend/tests/appointments/appointmentService.test.ts` | Inline `User` row construction in test helpers gained `locale: 'en' as const` to satisfy the wider type. |
| Mobile | `mobile/test/widget_test.dart` | App boots with English `AppLocalizations` wired into `MaterialApp`; key login labels render from `AppLocalizations`; Amharic bundle resolves when `locale=am` (`l10n.loginSignIn == 'ይግቡ'`). |
| Mobile | `mobile/test/features/profile/me_repository_test.dart` | `PATCH /v1/me` request shape (`{"locale":"am"}`); 400 / 401 / 404 / 500 / malformed-body classification. |
| Mobile | `mobile/test/features/profile/profile_screen_test.dart` | Amharic ARB loads under `locale=am`; picker shows both options in their own scripts; tapping the Amharic row updates the repo + LocaleScope + prefs cache and re-renders Amharic copy; PATCH failure surfaces a localized SnackBar and leaves LocaleScope at the previous value. |

**Expected status:** all suites pass locally and in CI. Backend tests run under Node 20's built-in test runner (`npm test` in `backend/`). Mobile tests run under `flutter test` after `flutter pub get` (which triggers the `gen-l10n` codegen for `AppLocalizations`).

## Remaining operator gates

Three items remain before Track 5 should be considered closed at the product level (separate from engineering). None of them block the next workstream; all three are run by the operator side.

1. **Native-speaker review of the Amharic copy.** Engineering authored both the ARB strings and the notification templates. A native Amharic-speaking reviewer should sweep:
   - `mobile/lib/l10n/app_am.arb` — every key, with attention to tone (formal customer-facing) and proper-noun handling (we left `Telegram` and `EthioLink` in their original scripts).
   - `backend/shared/domains/notifications/templateRegistry.ts` — the eight Amharic booking renderers, especially the verb conjugation for "rescheduled / cancelled" and the "(reason: ...)" / "(notes: ...)" suffix labels.
2. **TestFlight / Play Store internal-track Amharic smoke.** Build the Flutter app with the standard `--dart-define-from-file=env/dev.json`, sign in as a test user, flip the picker to Amharic, walk through the happy-path booking flow end-to-end, and verify the resulting SMS / Telegram message arrives in Amharic. Document any device-side rendering issues (font fallback, glyph cut-off) for the design team.
3. **Content-side Amharic population for category / business / service fields.** The platform already exposes a `LocalizedText` JSONB shape with `{ en, am? }` on user-authored content (categories seeded by the operator, business descriptions, service names). The Flutter app currently renders the `en` branch only — exposing the `am` branch in the customer browse / detail screens is a small mobile follow-up, but populating the `am` branch is operator work (or business-owner self-service). Sequence: ensure the seed data has Amharic entries for the four MVP categories before the Amharic picker is surfaced to real customers; encourage business owners to fill in Amharic descriptions via the existing edit-business screens.

## Deferred follow-ups

Track 5 closes here. The items below are deliberately out of scope and pair naturally with later workstreams.

- **Admin SPA i18n scaffolding** (`react-i18next`). Lower priority — operators are bilingual and the admin surface is smaller than the customer app. Recommended only after a native-speaker review of the customer-side copy completes, or once concrete operator demand surfaces.
- **Richer localized business content.** Surfacing `LocalizedText.am` in the customer browse + detail screens, business-owner UI for filling Amharic descriptions on the create-business / edit-business flow, an admin-side QA pass on Amharic category names. Pairs with the marketplace-growth track.
- **Per-user notification preferences** beyond locale. Channel preference (SMS vs. Telegram vs. push), quiet hours, opt-out per template key. Requires a `user_notification_preferences` table; the current `notification_logs` payload + `users.locale` are intentionally minimal. Worth scoping when the SMS provider integration lands (Track 1) and real volume creates a need for finer-grained controls.

## Next recommended workstream

Two options, both standalone tracks with their own commit cadence:

- **Track 4 — KMS-managed encryption migration.** Higher engineering effort but the natural next gate before broader prod readiness. Module per consuming service (RDS, S3 buckets, Secrets Manager, Lambda env vars); maintenance window for the re-encryption pass; per-domain Lambda role updates for `kms:Decrypt` + `kms:GenerateDataKey*`. The runbook + dev maintenance window described in `PHASE_9_POST_MVP.md` is the path; a Saturday dev window followed by prod a week later is the typical pattern.
- **Track 6 — Marketplace growth (start with search).** GIN index on `business_profiles.description` + `search` query param on `GET /v1/businesses`. Lower engineering effort, more user-visible. Naturally pairs with paid-featuring + analytics work later. Recommended when product wants a customer-impact feature next.

If forced to pick one: **KMS migration** has the larger downstream blocker effect (prod readiness gating) and benefits from being scheduled before search/growth features start adding hot paths. Marketplace growth is the right pick if prod readiness is on hold for organizational reasons and the team wants user-facing momentum instead.
