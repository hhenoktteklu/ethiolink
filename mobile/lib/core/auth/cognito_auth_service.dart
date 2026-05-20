// EthioLink Mobile — Cognito PKCE auth implementation.
//
// Phase 9 Track 3. Replaces `FakeAuthService` for production runs;
// `FakeAuthService` is preserved for the widget test seam (see
// `mobile/test/widget_test.dart` + `LoginScreen`'s constructor).
//
// Flow:
//   1. `signIn()` — `FlutterAppAuth.authorizeAndExchangeCode` opens
//      the system browser (Custom Tab on Android, ASWebAuthenticationSession
//      on iOS) against `https://${cognitoDomain}/oauth2/authorize`
//      with PKCE + the configured redirect URI. On callback the
//      library exchanges the auth code for tokens at
//      `https://${cognitoDomain}/oauth2/token` automatically.
//   2. Persist `accessToken` + `idToken` + `refreshToken` +
//      `idTokenExpiresAt` in `flutter_secure_storage` (Keychain /
//      Keystore-backed).
//   3. Decode the id token's payload (no signature verification on
//      the client — the API enforces it via `aws-jwt-verify`) and
//      return a populated `AuthSession`.
//
//   On `signOut()`:
//     * Clear the secure-storage entries FIRST. This is the
//       load-bearing local-sign-out action — even if the
//       Cognito-side cookie teardown fails (network blip, plugin
//       error, user closes the Custom Tab before redirect), the
//       app still considers the user signed out and the
//       LoginScreen renders.
//     * Best-effort call to Cognito's `/logout` endpoint via
//       `FlutterAppAuth.endSession` so the hosted-UI session cookie
//       is torn down. The Cognito logout endpoint is NOT spec-OIDC
//       compliant — it requires `client_id` as a query parameter
//       (the OIDC end-session spec only mandates `id_token_hint`),
//       so we thread the client id through
//       `EndSessionRequest.additionalParameters`. Without that,
//       Cognito serves "Required String parameter 'client_id' is
//       not present" inside the Custom Tab. If `endSession` still
//       throws for any other reason, we swallow and log — local
//       clear has already happened above.
//
//   On `currentSession()`:
//     * Read the persisted tokens. When `idTokenExpiresAt` is more
//       than 60s away, return the cached session.
//     * When the id token is near-expiry or expired AND a refresh
//       token is present, run `FlutterAppAuth.token` with
//       `refreshToken:` to mint fresh tokens, persist them, and
//       return the new session.
//     * If refresh fails (revoked, network), clear the cache and
//       return `null` — the caller routes to LoginScreen.
//
// Secure-storage key layout:
//
//   * `cognito.access_token`            — current access token.
//   * `cognito.id_token`                — current id token.
//   * `cognito.refresh_token`           — Cognito refresh token (long-lived).
//   * `cognito.id_token_expires_at_ms`  — millisSinceEpoch UTC of `exp`.
//
// Why not `amplify_auth_cognito`:
//   `amplify_auth_cognito` covers the same surface but pulls in
//   the full Amplify bootstrap (Amplify config files, analytics
//   side-channel, the Amplify CLI assumption). `flutter_appauth`
//   is the leaner AppAuth wrapper; it covers exactly the PKCE
//   flow we need without the Amplify framing. We can revisit if a
//   future requirement (e.g. social-IdP federation) is easier in
//   Amplify.

import 'dart:async';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_appauth/flutter_appauth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../config/app_config.dart';
import 'auth_service.dart';
import 'jwt_claims.dart';

// Secure-storage key constants. Kept module-scope (not on the
// class) so tests can grep them when stubbing the storage layer.
const _kAccessToken = 'cognito.access_token';
const _kIdToken = 'cognito.id_token';
const _kRefreshToken = 'cognito.refresh_token';
const _kIdTokenExpiresAtMs = 'cognito.id_token_expires_at_ms';

/// How close to expiry the id token has to get before we proactively
/// refresh on `currentSession`. 60 seconds keeps us comfortably
/// outside any clock skew without forcing a refresh on every cold
/// start.
const _proactiveRefreshThreshold = Duration(seconds: 60);

class CognitoAuthService implements AuthService {
  CognitoAuthService({
    required this.config,
    FlutterAppAuth? appAuth,
    FlutterSecureStorage? storage,
  })  : _appAuth = appAuth ?? const FlutterAppAuth(),
        _storage = storage ?? const FlutterSecureStorage();

  final AppConfig config;
  final FlutterAppAuth _appAuth;
  final FlutterSecureStorage _storage;

  /// OAuth scopes requested at sign-in. Mirrors the Cognito
  /// `allowed_oauth_scopes` set on the mobile app client
  /// (`infra/terraform/modules/cognito/main.tf`).
  static const List<String> _scopes = <String>[
    'openid',
    'email',
    'phone',
    'profile',
  ];

  AuthorizationServiceConfiguration get _serviceConfig =>
      AuthorizationServiceConfiguration(
        authorizationEndpoint:
            'https://${config.cognitoDomain}/oauth2/authorize',
        tokenEndpoint:
            'https://${config.cognitoDomain}/oauth2/token',
        endSessionEndpoint:
            'https://${config.cognitoDomain}/logout',
      );

  @override
  Future<AuthSession> signIn() async {
    final result = await _appAuth.authorizeAndExchangeCode(
      AuthorizationTokenRequest(
        config.cognitoClientId,
        config.redirectUri,
        serviceConfiguration: _serviceConfig,
        scopes: _scopes,
        promptValues: const <String>['login'],
      ),
    );

    final idToken = result.idToken;
    if (idToken == null || idToken.isEmpty) {
      throw const AuthFailure(
        'Cognito returned no id token. Confirm the mobile app '
        'client allows openid scope.',
      );
    }
    final claims = decodeIdTokenClaims(idToken);

    await _persistTokens(
      accessToken: result.accessToken,
      idToken: idToken,
      refreshToken: result.refreshToken,
      idTokenExpiresAt: claims.expiresAt,
    );

    return _sessionFromClaims(claims);
  }

  @override
  Future<void> signOut() async {
    final idToken = await _storage.read(key: _kIdToken);

    // Clear local state FIRST so even if endSession blows up the
    // app considers the user signed out. The storage clear is the
    // binding action; the Cognito-side cookie teardown is best
    // effort. This ordering also satisfies the "logout failure
    // still clears local session" contract — the LoginScreen
    // appears on the next frame regardless of what Cognito does.
    await _clearStorage();

    if (idToken == null || idToken.isEmpty) return;

    // Remote hosted-UI logout requires a logout redirect URI.
    // flutter_appauth's `EndSessionRequest` asserts that
    // `idTokenHint` and `postLogoutRedirectUrl` are BOTH null or
    // BOTH non-null — passing an idToken with a null redirect
    // would trip that assertion. When `logoutUri` is unset
    // (only possible on a misconfigured env; every shipped env
    // sets it) we treat local-storage clear as the complete
    // sign-out and skip the remote round-trip entirely. The
    // hosted-UI cookie then expires on its own.
    final logoutUri = config.logoutUri;
    if (logoutUri == null || logoutUri.isEmpty) {
      return;
    }

    try {
      await _appAuth.endSession(buildEndSessionRequest(idToken, logoutUri));
    } catch (e) {
      // Swallowed by design — the Cognito `/logout` endpoint shape
      // differs slightly from the OIDC standard and some
      // flutter_appauth versions surface a benign error. The user
      // is still signed out locally; the hosted-UI cookie expires
      // on its own. Print is acceptable here (avoid_print
      // overridden in analysis_options).
      // ignore: avoid_print
      print('CognitoAuthService.signOut: endSession threw '
          '(swallowed): $e');
    }
  }

  /// Build the `EndSessionRequest` we send to Cognito's `/logout`
  /// endpoint. Exposed for unit tests so the regression sentinels
  /// — every Cognito-required query param must appear in
  /// `additionalParameters` — can be pinned without touching the
  /// `flutter_appauth` platform channel.
  ///
  /// Cognito's `/logout` is NOT OIDC-end-session-spec compliant.
  /// flutter_appauth speaks the spec: it serialises
  /// `EndSessionRequest.postLogoutRedirectUrl` as the OIDC name
  /// `post_logout_redirect_uri`. Cognito ignores that parameter
  /// outright and instead requires its own non-standard trio:
  ///
  ///   * `client_id`    — required. Without it Cognito returns
  ///                      "Required String parameter 'client_id'
  ///                      is not present" (the previous fix added
  ///                      this).
  ///   * `logout_uri`   — Cognito's canonical "where to redirect
  ///                      after sign-out" parameter. Must match
  ///                      an entry in the Cognito app client's
  ///                      `LogoutURLs` allowlist. Added in this
  ///                      commit.
  ///   * `redirect_uri` — Cognito's alternative redirect target
  ///                      (used by some account configurations
  ///                      where the logout endpoint behaves as a
  ///                      logout-then-reauth funnel). When only
  ///                      `client_id` is present Cognito surfaces
  ///                      "Required String parameter 'redirect_uri'
  ///                      is not present", which is what triggered
  ///                      this commit. Sending `logout_uri` AND
  ///                      `redirect_uri` together is documented in
  ///                      the AWS Cognito logout reference as the
  ///                      belt-and-braces shape that satisfies
  ///                      every parser branch — Cognito prefers
  ///                      `logout_uri` when both are present and
  ///                      no `response_type` is supplied, so we
  ///                      end up with a clean local-sign-out
  ///                      redirect (no second auth-code dance).
  ///
  /// flutter_appauth's `EndSessionRequest` doesn't expose
  /// top-level `clientId` / `logoutUri` / `redirectUri` fields, so
  /// we thread all three through `additionalParameters`; the
  /// platform implementation forwards them verbatim as query
  /// string parameters on the `endSessionEndpoint` URL. The OIDC
  /// `id_token_hint` (carrying the user's last id token, useful
  /// for audit) and `post_logout_redirect_uri` (which Cognito
  /// ignores but is harmless) still go through via the standard
  /// fields above.
  /// `logoutUri` is REQUIRED and non-null — the caller
  /// (`signOut`) guarantees it by short-circuiting to a
  /// local-only sign-out when `config.logoutUri` is unset.
  /// Taking it as a parameter (rather than reading the nullable
  /// `config.logoutUri` inside) keeps the
  /// `idTokenHint`-non-null / `postLogoutRedirectUrl`-non-null
  /// invariant that flutter_appauth's `EndSessionRequest`
  /// asserts — a null redirect alongside a non-null id token
  /// trips that assertion.
  @visibleForTesting
  EndSessionRequest buildEndSessionRequest(
    String idTokenHint,
    String logoutUri,
  ) {
    return EndSessionRequest(
      idTokenHint: idTokenHint,
      postLogoutRedirectUrl: logoutUri,
      serviceConfiguration: _serviceConfig,
      additionalParameters: <String, String>{
        'client_id': config.cognitoClientId,
        'logout_uri': logoutUri,
        'redirect_uri': logoutUri,
      },
    );
  }

  @override
  Future<AuthSession?> currentSession() async {
    final idToken = await _storage.read(key: _kIdToken);
    final refreshToken = await _storage.read(key: _kRefreshToken);
    final expiresAtMs = await _storage.read(key: _kIdTokenExpiresAtMs);

    if (idToken == null || idToken.isEmpty || expiresAtMs == null) {
      return null;
    }

    final expiresAt = DateTime.fromMillisecondsSinceEpoch(
      int.tryParse(expiresAtMs) ?? 0,
      isUtc: true,
    );
    final timeToExpiry = expiresAt.difference(DateTime.now().toUtc());

    if (timeToExpiry > _proactiveRefreshThreshold) {
      // Cached id token still good. Decode + return.
      try {
        return _sessionFromClaims(decodeIdTokenClaims(idToken));
      } on FormatException {
        // Stored token is malformed — fall through to refresh
        // attempt; if that also fails the cache is cleared.
      }
    }

    if (refreshToken == null || refreshToken.isEmpty) {
      await _clearStorage();
      return null;
    }

    try {
      final refreshed = await _appAuth.token(
        TokenRequest(
          config.cognitoClientId,
          config.redirectUri,
          serviceConfiguration: _serviceConfig,
          refreshToken: refreshToken,
          scopes: _scopes,
          grantType: 'refresh_token',
        ),
      );
      final newIdToken = refreshed.idToken;
      if (newIdToken == null || newIdToken.isEmpty) {
        await _clearStorage();
        return null;
      }
      final newClaims = decodeIdTokenClaims(newIdToken);
      await _persistTokens(
        accessToken: refreshed.accessToken,
        idToken: newIdToken,
        // Cognito does not rotate the refresh token on refresh —
        // the same one stays valid until its `refresh_token_validity`
        // window expires. `refreshed.refreshToken` may be null;
        // fall back to the existing one when so.
        refreshToken: refreshed.refreshToken ?? refreshToken,
        idTokenExpiresAt: newClaims.expiresAt,
      );
      return _sessionFromClaims(newClaims);
    } catch (e) {
      // Refresh failed (revoked, network, etc.). Wipe local state
      // so the next `currentSession()` reports unauthenticated and
      // the app routes back to LoginScreen.
      await _clearStorage();
      // ignore: avoid_print
      print('CognitoAuthService.currentSession: refresh failed '
          '(cleared cache): $e');
      return null;
    }
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  Future<void> _persistTokens({
    required String? accessToken,
    required String idToken,
    required String? refreshToken,
    required DateTime idTokenExpiresAt,
  }) async {
    await Future.wait([
      if (accessToken != null && accessToken.isNotEmpty)
        _storage.write(key: _kAccessToken, value: accessToken),
      _storage.write(key: _kIdToken, value: idToken),
      if (refreshToken != null && refreshToken.isNotEmpty)
        _storage.write(key: _kRefreshToken, value: refreshToken),
      _storage.write(
        key: _kIdTokenExpiresAtMs,
        value: idTokenExpiresAt.millisecondsSinceEpoch.toString(),
      ),
    ]);
  }

  Future<void> _clearStorage() async {
    await Future.wait([
      _storage.delete(key: _kAccessToken),
      _storage.delete(key: _kIdToken),
      _storage.delete(key: _kRefreshToken),
      _storage.delete(key: _kIdTokenExpiresAtMs),
    ]);
  }

  AuthSession _sessionFromClaims(IdTokenClaims claims) {
    return AuthSession(
      userId: claims.sub,
      email: claims.email,
      role: pickRole(claims.groups),
      expiresAt: claims.expiresAt,
    );
  }
}

/// Thrown by `signIn` when Cognito's response is missing the
/// required token shape. Distinguishable from the user-cancellation
/// + network errors `flutter_appauth` raises so the UI can render
/// a precise message.
class AuthFailure implements Exception {
  const AuthFailure(this.message);
  final String message;

  @override
  String toString() => 'AuthFailure: $message';
}
