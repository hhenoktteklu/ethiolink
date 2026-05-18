// EthioLink Mobile — CognitoAuthService.signOut wire-shape tests.
//
// The signOut path crosses two platform channels (flutter_appauth
// and flutter_secure_storage) so we don't run the full method in
// a widget test; instead we pin the EndSessionRequest the service
// builds for Cognito via `buildEndSessionRequest`. That's the
// regression sentinel for the bug this commit fixes:
//
//   "Required String parameter 'client_id' is not present"
//
// served by Cognito's `/logout` endpoint when the request omits
// `client_id`. Cognito's logout endpoint is not OIDC-spec-
// compliant — it requires `client_id` even though the OIDC
// end-session spec only mandates `id_token_hint`. flutter_appauth's
// `EndSessionRequest` doesn't expose a top-level `clientId`
// field, so we thread it through `additionalParameters` and the
// platform layer forwards it verbatim as a query string parameter.
//
// The clear-on-success / clear-on-failure invariants live in
// `cognito_auth_service.dart`'s `signOut` ordering — local
// storage is cleared FIRST (before the network call), so any
// EndSession outcome — success, swallowed error, awaited future
// that never completes because the user closed the Custom Tab —
// leaves the user signed out locally. The file's doc comment
// records that contract.

import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/auth/cognito_auth_service.dart';
import 'package:ethiolink/core/config/app_config.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'ethiolink-test.auth.eu-west-1.amazoncognito.com',
  cognitoClientId: 'test-client-id-1234',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
  logoutUri: 'com.ethiolink.app:/logout',
);

void main() {
  group('CognitoAuthService.buildEndSessionRequest', () {
    test(
      'attaches client_id via additionalParameters — the regression sentinel',
      () {
        final service = CognitoAuthService(config: _testConfig);
        final req = service.buildEndSessionRequest('id-token-hint-stub');

        // The fix: Cognito's /logout endpoint demands client_id.
        // additionalParameters is forwarded as query string by the
        // platform implementation.
        expect(req.additionalParameters, isNotNull);
        expect(req.additionalParameters, contains('client_id'));
        expect(
          req.additionalParameters!['client_id'],
          'test-client-id-1234',
          reason:
              'EndSessionRequest must thread config.cognitoClientId '
              'as the `client_id` query parameter. Without it, '
              'Cognito serves "Required String parameter '
              '\'client_id\' is not present" inside the Custom Tab '
              'and the user-visible sign-out flow fails.',
        );
      },
    );

    test('passes the id_token_hint we received', () {
      final service = CognitoAuthService(config: _testConfig);
      final req = service.buildEndSessionRequest('hint-abc-xyz');
      expect(req.idTokenHint, 'hint-abc-xyz');
    });

    test('uses the configured logout redirect URI', () {
      final service = CognitoAuthService(config: _testConfig);
      final req = service.buildEndSessionRequest('hint');
      // The logout URI is the reverse-domain private-use URI scheme
      // (RFC 8252 §7.1) registered with Cognito's
      // mobile_logout_urls; matches mobile/env/dev.example.json.
      expect(req.postLogoutRedirectUrl, 'com.ethiolink.app:/logout');
    });

    test(
      'service configuration points at https://<domain>/logout — the '
      'Cognito hosted-UI end-session endpoint',
      () {
        final service = CognitoAuthService(config: _testConfig);
        final req = service.buildEndSessionRequest('hint');
        // The AuthorizationServiceConfiguration plumbing must
        // carry the end-session endpoint; otherwise flutter_appauth
        // wouldn't know where to POST.
        expect(req.serviceConfiguration, isNotNull);
        expect(
          req.serviceConfiguration!.endSessionEndpoint,
          'https://ethiolink-test.auth.eu-west-1.amazoncognito.com/logout',
        );
      },
    );
  });
}
