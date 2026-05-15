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
//     * Clear the secure-storage entries.
//     * Best-effort call to Cognito's `/logout` endpoint via
//       `FlutterAppAuth.endSession` so the hosted-UI session cookie
//       is torn down. If `endSession` throws (often the case on
//       Cognito's non-standard logout endpoint shape), we swallow
//       and log — local clear is the binding action; the cookie
//       expiring naturally is acceptable for MVP.
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
    // effort.
    await _clearStorage();

    if (idToken == null || idToken.isEmpty) return;

    try {
      await _appAuth.endSession(
        EndSessionRequest(
          idTokenHint: idToken,
          postLogoutRedirectUrl: config.logoutUri,
          serviceConfiguration: _serviceConfig,
        ),
      );
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
