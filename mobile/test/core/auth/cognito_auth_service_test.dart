// EthioLink Mobile — CognitoAuthService.signOut wire-shape tests.
//
// The signOut path crosses two platform channels (flutter_appauth
// and flutter_secure_storage) so we don't run the full method in
// a widget test; instead we pin the EndSessionRequest the service
// builds for Cognito via `buildEndSessionRequest`. The tests
// guard against two regressions in the order they were
// surfaced live on the dev pool:
//
//   1. "Required String parameter 'client_id' is not present" —
//      Cognito's `/logout` endpoint requires `client_id` even
//      though the OIDC end-session spec only mandates
//      `id_token_hint`.
//
//   2. "Required String parameter 'redirect_uri' is not present"
//      — Cognito ignores OIDC's `post_logout_redirect_uri` and
//      requires its own non-standard `logout_uri` and/or
//      `redirect_uri`. Sending both is the documented
//      belt-and-braces shape; Cognito prefers `logout_uri` when
//      both are present and no `response_type` is supplied, so we
//      get a clean local-sign-out redirect.
//
// flutter_appauth's `EndSessionRequest` exposes neither
// `clientId` nor `logoutUri` nor `redirectUri` as top-level
// fields (those are Cognito-specific), so all three are threaded
// through `additionalParameters` and the platform layer forwards
// them verbatim as query string params on the
// `endSessionEndpoint` URL.
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

const _logoutUri = 'com.ethiolink.app:/logout';

void main() {
  group('CognitoAuthService.buildEndSessionRequest', () {
    test(
      'attaches client_id via additionalParameters — the first regression '
      'sentinel ("client_id is not present")',
      () {
        final service = CognitoAuthService(config: _testConfig);
        final req =
            service.buildEndSessionRequest('id-token-hint-stub', _logoutUri);

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

    test(
      'attaches logout_uri + redirect_uri — the second regression sentinel '
      '("redirect_uri is not present")',
      () {
        // Cognito ignores OIDC `post_logout_redirect_uri` and
        // requires its own `logout_uri` (and accepts `redirect_uri`
        // as an alternative target). The previous client_id-only
        // fix moved Cognito past the first parser check but landed
        // on "Required String parameter 'redirect_uri' is not
        // present". This sentinel pins the belt-and-braces shape
        // that satisfies both branches of Cognito's logout-URL
        // parser.
        final service = CognitoAuthService(config: _testConfig);
        final req = service.buildEndSessionRequest('hint', _logoutUri);

        expect(req.additionalParameters, contains('logout_uri'));
        expect(req.additionalParameters, contains('redirect_uri'));
        expect(req.additionalParameters!['logout_uri'], _logoutUri);
        expect(req.additionalParameters!['redirect_uri'], _logoutUri);
      },
    );

    test(
      'idTokenHint AND postLogoutRedirectUrl are both non-null — the '
      'flutter_appauth EndSessionRequest invariant',
      () {
        // flutter_appauth asserts these two are both-null or
        // both-non-null. signOut() guarantees a non-null logoutUri
        // reaches buildEndSessionRequest (it short-circuits to a
        // local-only sign-out when config.logoutUri is null), so
        // the request always satisfies the invariant. This test
        // pins it so a refactor that reintroduces a nullable
        // postLogoutRedirectUrl trips here, not at runtime on the
        // device.
        final service = CognitoAuthService(config: _testConfig);
        final req = service.buildEndSessionRequest('hint', _logoutUri);
        expect(req.idTokenHint, isNotNull);
        expect(req.postLogoutRedirectUrl, isNotNull);
      },
    );

    test('passes the id_token_hint we received', () {
      final service = CognitoAuthService(config: _testConfig);
      final req = service.buildEndSessionRequest('hint-abc-xyz', _logoutUri);
      expect(req.idTokenHint, 'hint-abc-xyz');
    });

    test('uses the supplied logout redirect URI (OIDC field too)', () {
      final service = CognitoAuthService(config: _testConfig);
      final req = service.buildEndSessionRequest('hint', _logoutUri);
      // postLogoutRedirectUrl serialises as OIDC `post_logout_redirect_uri`.
      // Cognito ignores it but spec-compliant IdPs use it; sending
      // it costs nothing.
      expect(req.postLogoutRedirectUrl, _logoutUri);
    });

    test(
      'service configuration points at https://<domain>/logout — the '
      'Cognito hosted-UI end-session endpoint',
      () {
        final service = CognitoAuthService(config: _testConfig);
        final req = service.buildEndSessionRequest('hint', _logoutUri);
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
