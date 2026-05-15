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

import 'package:flutter/material.dart';
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
        home: LoginScreen(authServiceOverride: FakeAuthService()),
      ),
    ),
  );
}

void main() {
  testWidgets('login screen renders the EthioLink heading', (tester) async {
    await pumpLoginScreen(tester);

    expect(find.text('EthioLink'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
    expect(find.text('TEST'), findsOneWidget); // env badge.
  });

  testWidgets('sign-in via FakeAuthService routes to browse', (tester) async {
    await pumpLoginScreen(tester);

    await tester.tap(find.text('Sign in'));
    // `FakeAuthService.signIn` simulates a 300 ms PKCE round-trip.
    await tester.pump(); // start loading state
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pumpAndSettle();

    // Browse tab's app bar title is "Discover" — confirms we
    // routed away from the login screen.
    expect(find.text('Discover'), findsOneWidget);
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
}
