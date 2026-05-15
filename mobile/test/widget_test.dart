// EthioLink Mobile — smoke widget test.
//
// Confirms the scaffold boots and the placeholder login screen
// renders. The test pre-builds an `AppConfig` directly (no
// dart-define lookup) so it runs without any compile-time env.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/app.dart';
import 'package:ethiolink/core/config/app_config.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'ethiolink-test.auth.eu-west-1.amazoncognito.com',
  cognitoClientId: 'test-client-id',
  redirectUri: 'ethiolink://auth/callback',
  environmentName: 'test',
);

void main() {
  testWidgets('login screen renders the EthioLink heading', (tester) async {
    await tester.pumpWidget(const EthioLinkApp(config: _testConfig));

    expect(find.text('EthioLink'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
    expect(find.text('TEST'), findsOneWidget); // env badge.
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
}
