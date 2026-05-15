// EthioLink Mobile — HTTP client placeholder.
//
// The scaffold's API client is intentionally tiny: a `baseUrl`
// holder and a no-op `get` / `post` pair. Real HTTP wiring (Dio
// + interceptors + auth-token attachment + retry) lands in a
// follow-up commit once the OpenAPI-generated client is wired.
//
// The placeholder exists so the feature screens have a real
// type to import. Replacing it later is a one-import swap.

import '../config/app_config.dart';

class ApiClient {
  ApiClient({required this.config});

  final AppConfig config;

  /// API root including stage suffix, e.g.
  /// `https://abc.execute-api.eu-west-1.amazonaws.com/dev`.
  String get baseUrl => config.apiBaseUrl;

  /// Placeholder. Throws `UnimplementedError` until the Dio
  /// integration lands. Tests that need a working HTTP client
  /// inject a fake implementation directly into the feature
  /// services.
  Future<dynamic> get(String path, {Map<String, String>? headers}) {
    throw UnimplementedError(
      'ApiClient.get is a Phase 9 scaffold placeholder. '
      'Implement with the Dio adapter in the next mobile commit.',
    );
  }

  /// Placeholder. Same posture as `get`.
  Future<dynamic> post(
    String path, {
    Object? body,
    Map<String, String>? headers,
  }) {
    throw UnimplementedError(
      'ApiClient.post is a Phase 9 scaffold placeholder. '
      'Implement with the Dio adapter in the next mobile commit.',
    );
  }
}
