// EthioLink Mobile — ProfileScreen locale-picker widget tests.
//
// Phase 9 Track 5. Verifies the visible labels switch when the
// user picks a different language + that the picker drives a
// `PATCH /v1/me` through `MeRepository` and updates the app-level
// `LocaleScope`. The error path renders a SnackBar with the
// localized `profileLanguageSaveError` copy and does NOT flip
// the active locale.

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/auth/auth_service.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/core/i18n/locale_preferences.dart';
import 'package:ethiolink/core/i18n/locale_scope.dart';
import 'package:ethiolink/features/profile/data/me_repository.dart';
import 'package:ethiolink/features/profile/profile_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

// `AuthSession` is the minimal { userId, email, role, expiresAt }
// shape today — the id / access / refresh tokens live on the auth
// service's secure-storage layer, not on this DTO. Earlier drafts
// of this test fixture inlined those tokens here; updating to the
// current model keeps the rest of the suite compiling.
final _testSession = AuthSession(
  userId: 'user-1',
  email: 'henok@example.com',
  role: 'CUSTOMER',
  expiresAt: DateTime.utc(2030, 1, 1),
);

class _FakeMeRepo implements MeRepository {
  _FakeMeRepo({this.failure});
  final MeUpdateFailure? failure;
  String? lastLocale;

  @override
  Future<String> patchLocale(String locale) async {
    lastLocale = locale;
    if (failure != null) throw failure!;
    return locale;
  }
}

Future<void> _pumpProfile(
  WidgetTester tester, {
  required LocaleController controller,
  required MeRepository meRepo,
  LocalePreferences? prefs,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: LocaleScope(
        notifier: controller,
        child: AnimatedBuilder(
          animation: controller,
          builder: (context, _) {
            return MaterialApp(
              locale: controller.locale,
              localizationsDelegates: AppLocalizations.localizationsDelegates,
              supportedLocales: AppLocalizations.supportedLocales,
              home: ProfileScreen(
                session: _testSession,
                meRepositoryOverride: meRepo,
                localePreferencesOverride:
                    prefs ?? InMemoryLocalePreferences(),
              ),
            );
          },
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('Amharic ARB bundle loads when locale is am', (tester) async {
    final controller = LocaleController(initial: const Locale('am'));
    await _pumpProfile(
      tester,
      controller: controller,
      meRepo: _FakeMeRepo(),
    );

    // Title flipped to the Amharic translation of "Profile".
    expect(find.text('መገለጫ'), findsWidgets);
    // Section heading is Amharic.
    expect(find.text('ቋንቋ'), findsOneWidget);
    // The English label is NOT visible (default app title aside).
    expect(find.text('Notifications'), findsNothing);
  });

  testWidgets('picker shows both English and Amharic options labelled in their own script',
      (tester) async {
    final controller = LocaleController();
    await _pumpProfile(
      tester,
      controller: controller,
      meRepo: _FakeMeRepo(),
    );

    expect(find.text('English'), findsOneWidget);
    expect(find.text('አማርኛ'), findsOneWidget);
  });

  testWidgets('switching locale changes visible labels and updates LocaleScope',
      (tester) async {
    final controller = LocaleController(); // defaults to 'en'
    final repo = _FakeMeRepo();
    final prefs = InMemoryLocalePreferences();
    await _pumpProfile(
      tester,
      controller: controller,
      meRepo: repo,
      prefs: prefs,
    );

    // English baseline.
    expect(find.text('Language'), findsOneWidget);
    expect(find.text('Sign out'), findsOneWidget);

    // Tap the Amharic option.
    await tester.tap(find.byKey(const ValueKey('localeOption.am')));
    await tester.pumpAndSettle();

    // Repo received the patch with the right locale.
    expect(repo.lastLocale, 'am');
    // LocaleScope flipped.
    expect(controller.locale.languageCode, 'am');
    // Secure-storage cache persisted the pick.
    final cached = await prefs.read();
    expect(cached?.languageCode, 'am');
    // UI now renders Amharic copy.
    expect(find.text('ቋንቋ'), findsOneWidget);
    expect(find.text('ይውጡ'), findsOneWidget);
    // English label is gone.
    expect(find.text('Sign out'), findsNothing);
  });

  testWidgets('PATCH failure surfaces a SnackBar and leaves the locale unchanged',
      (tester) async {
    final controller = LocaleController(); // 'en'
    final repo = _FakeMeRepo(
      failure: MeUpdateFailure(
        kind: MeUpdateFailureKind.network,
        message: 'boom',
      ),
    );
    await _pumpProfile(
      tester,
      controller: controller,
      meRepo: repo,
    );

    await tester.tap(find.byKey(const ValueKey('localeOption.am')));
    // Don't pumpAndSettle — the SnackBar's auto-dismiss timer
    // would race with the test teardown. A single pump shows the
    // SnackBar; we read it and stop.
    await tester.pump(); // start the async _onLocalePicked
    await tester.pump(); // pick up the post-error setState
    await tester.pump(const Duration(milliseconds: 100)); // SnackBar entry

    expect(
      find.text("Couldn't save your language. Please try again."),
      findsOneWidget,
    );
    // Locale did NOT flip — the picker is server-authoritative.
    expect(controller.locale.languageCode, 'en');

    // Drain the SnackBar before teardown.
    await tester.pump(const Duration(seconds: 4));
  });
}
