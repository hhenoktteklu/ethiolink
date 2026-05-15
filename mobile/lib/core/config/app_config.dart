// EthioLink Mobile — runtime configuration.
//
// `AppConfig` is the typed snapshot of the four env-driven values
// the app needs at boot:
//
//   * `apiBaseUrl`        — API Gateway invoke URL, e.g.
//                            `https://abc.execute-api.eu-west-1.amazonaws.com/dev`
//   * `cognitoDomain`     — hosted-UI domain, e.g.
//                            `ethiolink-dev.auth.eu-west-1.amazoncognito.com`
//   * `cognitoClientId`   — Cognito mobile app-client id (public
//                            PKCE; no secret).
//   * `redirectUri`       — Deep-link URI for the OAuth callback,
//                            e.g. `ethiolink://auth/callback`.
//
// Resolution order at runtime (`fromCompileTimeEnv`):
//
//   1. `--dart-define-from-file=env/<env>.json` — preferred for
//      per-env builds. The JSON keys map 1:1 to the constants
//      below.
//   2. Individual `--dart-define=KEY=value` flags — accepted for
//      ad-hoc local runs (e.g. CI smoke).
//   3. Any required value missing throws `MissingConfigError`.
//      Optional values fall back to documented defaults.
//
// Tests construct `AppConfig` directly via the public constructor
// without touching `String.fromEnvironment`, so the unit-test
// surface stays env-independent.

class AppConfig {
  const AppConfig({
    required this.apiBaseUrl,
    required this.cognitoDomain,
    required this.cognitoClientId,
    required this.redirectUri,
    this.logoutUri,
    this.environmentName = 'dev',
  });

  /// API base URL (no trailing slash). Every API call is built as
  /// `${apiBaseUrl}/v1/...`.
  final String apiBaseUrl;

  /// Cognito hosted-UI domain (host only, no scheme). The OAuth
  /// flow targets `https://${cognitoDomain}/oauth2/authorize` and
  /// `/oauth2/token`.
  final String cognitoDomain;

  /// Cognito mobile app-client id. Public PKCE client; no secret.
  final String cognitoClientId;

  /// OAuth callback deep-link URI registered with Cognito's
  /// `callback_urls`. The default is `ethiolink://auth/callback`.
  final String redirectUri;

  /// OAuth logout deep-link URI registered with Cognito's
  /// `logout_urls`. Defaults to `ethiolink://auth/logout` if
  /// unset.
  final String? logoutUri;

  /// Environment label surfaced in the placeholder UI to make it
  /// obvious which backend the app is talking to. Defaults to
  /// `'dev'`.
  final String environmentName;

  /// Resolve `AppConfig` from `--dart-define` / `--dart-define-from-file`
  /// compile-time constants. Throws `MissingConfigError` when any
  /// required field is empty.
  ///
  /// The `String.fromEnvironment` calls below MUST be passed
  /// literal string keys — the Dart compiler treats them as
  /// compile-time constants and won't accept a runtime value.
  factory AppConfig.fromCompileTimeEnv() {
    const apiBaseUrl = String.fromEnvironment('API_BASE_URL');
    const cognitoDomain = String.fromEnvironment('COGNITO_DOMAIN');
    const cognitoClientId = String.fromEnvironment('COGNITO_CLIENT_ID');
    const redirectUri = String.fromEnvironment(
      'COGNITO_REDIRECT_URI',
      defaultValue: 'ethiolink://auth/callback',
    );
    const logoutUri = String.fromEnvironment(
      'COGNITO_LOGOUT_URI',
      defaultValue: 'ethiolink://auth/logout',
    );
    const environmentName = String.fromEnvironment(
      'APP_ENV',
      defaultValue: 'dev',
    );

    final missing = <String>[
      if (apiBaseUrl.isEmpty) 'API_BASE_URL',
      if (cognitoDomain.isEmpty) 'COGNITO_DOMAIN',
      if (cognitoClientId.isEmpty) 'COGNITO_CLIENT_ID',
    ];

    if (missing.isNotEmpty) {
      throw MissingConfigError(missing);
    }

    return AppConfig(
      apiBaseUrl: apiBaseUrl,
      cognitoDomain: cognitoDomain,
      cognitoClientId: cognitoClientId,
      redirectUri: redirectUri,
      logoutUri: logoutUri,
      environmentName: environmentName,
    );
  }
}

/// Raised at bootstrap when one or more required config keys are
/// missing. The list is exhaustive — operators see every missing
/// key at once rather than fixing them one at a time.
class MissingConfigError extends Error {
  MissingConfigError(this.missing);

  final List<String> missing;

  @override
  String toString() =>
      'Missing required mobile app config: ${missing.join(', ')}. '
      'Pass them via --dart-define-from-file=env/<env>.json or '
      'individual --dart-define=KEY=value flags. See '
      'env/dev.example.json for the template.';
}
