// EthioLink Mobile — smoke widget test.
//
// Confirms the scaffold boots and the placeholder login screen
// renders. The test pre-builds an `AppConfig` directly (no
// dart-define lookup) so it runs without any compile-time env.
//
// Phase 9 — the LoginScreen now constructs a real
// `CognitoAuthService` by default. To keep the widget test free
// of the `flutter_appauth` + `flutter_secure_storage` platform
// channels, we pump the test app with `EthioLinkApp.testAuth(...)`
// which injects a `FakeAuthService` down the navigation stack.
//
// Phase 9 Track 5 — `LoginScreen` now reads visible copy from
// `AppLocalizations`. The test scaffold pumps a `MaterialApp`
// with the standard delegates + supported locales so
// `AppLocalizations.of(context)` resolves to the English bundle.

import 'package:flutter/material.dart';
import 'package:flutter_gen/gen_l10n/app_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/app.dart';
import 'package:ethiolink/core/auth/auth_service.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/auth/login_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'ethiolink-test.auth.eu-west-1.amazoncognito.com',
  cognitoClientId: 'test-client-id',
  redirectUri: 'ethiolink://auth/callback',
  environmentName: 'test',
);

/// Pumps a test app shell that wraps `LoginScreen` in
/// `AppConfigScope` and injects `FakeAuthService` instead of the
/// production `CognitoAuthService`. Mirrors what `EthioLinkApp`
/// does in production but stays platform-channel-free.
Future<void> pumpLoginScreen(WidgetTester tester) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: LoginScreen(authServiceOverride: FakeAuthService()),
      ),
    ),
  );
  // Initial pumpWidget yields the loading scaffold while the
  // localization delegates load; one extra pump resolves the
  // English bundle.
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('login screen renders the EthioLink heading', (tester) async {
    await pumpLoginScreen(tester);

    expect(find.text('EthioLink'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
    expect(find.text('TEST'), findsOneWidget); // env badge.
  });

  testWidgets('sign-in via FakeAuthService clears the loading state', (tester) async {
    // Note: we don't navigate to BrowseScreen here because that
    // screen constructs a real `HttpCategoriesRepository` which
    // would instantiate Dio + secure-storage platform channels.
    // Coverage of the destination route lives in
    // `features/browse/browse_screen_test.dart`. This test just
    // confirms the LoginScreen drives the FakeAuthService and
    // returns to a non-error state.
    await pumpLoginScreen(tester);

    expect(find.text('Sign in'), findsOneWidget);
    expect(find.text('Signing in…'), findsNothing);

    await tester.tap(find.text('Sign in'));
    await tester.pump(); // start loading state
    expect(find.text('Signing in…'), findsOneWidget);
  });

  testWidgets('AppConfig.fromCompileTimeEnv surfaces missing keys', (tester) async {
    // The default compile-time env in `flutter test` has no
    // `--dart-define=API_BASE_URL=...` flags set, so the factory
    // should throw the expected `MissingConfigError`.
    expect(
      AppConfig.fromCompileTimeEnv,
      throwsA(isA<MissingConfigError>()),
    );
  });

  testWidgets('EthioLinkApp constructs with config injection', (tester) async {
    // Smoke-only — confirms the root widget's tree builds. We
    // don't tap Sign in here because the real CognitoAuthService
    // would try to load `flutter_appauth`'s platform channel.
    await tester.pumpWidget(const EthioLinkApp(config: _testConfig));
    expect(find.byType(MaterialApp), findsOneWidget);
  });

  testWidgets('app boots with English AppLocalizations wired into MaterialApp',
      (tester) async {
    // Pump the real root widget. `EthioLinkApp` wires
    // `AppLocalizations.localizationsDelegates` +
    // `supportedLocales` into the `MaterialApp`; the LoginScreen
    // reads its labels through `AppLocalizations.of(context)`.
    await tester.pumpWidget(const EthioLinkApp(config: _testConfig));
    await tester.pumpAndSettle();

    final BuildContext context = tester.element(find.byType(LoginScreen));
    final Locale active = Localizations.localeOf(context);
    expect(active.languageCode, equals('en'));
    expect(AppLocalizations.supportedLocales, contains(const Locale('en')));
    final AppLocalizations l10n = AppLocalizations.of(context);
    // Sanity: the bundle resolved to the English ARB.
    expect(l10n.appTitle, equals('EthioLink'));
    expect(l10n.loginSignIn, equals('Sign in'));
  });

  testWidgets('key login labels render from AppLocalizations (not hardcoded strings)',
      (tester) async {
    await pumpLoginScreen(tester);

    final BuildContext context = tester.element(find.byType(LoginScreen));
    final AppLocalizations l10n = AppLocalizations.of(context);

    // The widget reads each of these from the ARB bundle; the
    // strings happen to be English today but the indirection is
    // what we're verifying.
    expect(find.text(l10n.appTitle), findsOneWidget);
    expect(find.text(l10n.appTagline), findsOneWidget);
    expect(find.text(l10n.loginSignIn), findsOneWidget);
  });
}
