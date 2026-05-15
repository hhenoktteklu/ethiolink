// EthioLink Mobile — categories repository.
//
// Thin domain wrapper over the API client. The browse screen
// depends on the `CategoriesRepository` abstraction; production
// wires `HttpCategoriesRepository` over the real `ApiClient`,
// tests pass a `FakeCategoriesRepository` (defined in the test
// file) to drive loading / success / error states without
// touching the network.
//
// Why a repository instead of calling `apiClient.getJson`
// directly from the widget:
//
//   * Keeps the widget testable without `flutter_secure_storage`
//     in the harness. The widget never sees `Dio`.
//   * Surfaces a domain-shaped exception (`CategoriesLoadFailure`)
//     so the UI can render a clean error state.
//   * Centralises the URL constant — every other future caller
//     (`GET /v1/categories` is also the admin SPA's seed) reads
//     the same path string.

import '../../../core/api/api_client.dart';
import '../models/category.dart';

/// Domain port. Production: `HttpCategoriesRepository`. Tests:
/// fake stub injected into `BrowseScreen`.
abstract class CategoriesRepository {
  Future<List<Category>> list();
}

/// Wraps `GET /v1/categories`. The endpoint is public — no
/// Authorization header required. The `AuthTokenInterceptor`
/// attaches the token anyway if one's present (harmless; the
/// API ignores it on public routes).
class HttpCategoriesRepository implements CategoriesRepository {
  HttpCategoriesRepository(this._apiClient);

  final ApiClient _apiClient;

  /// API path. Lives on the `/v1/` namespace per
  /// `docs/architecture/API_SPEC.md`. The `apiBaseUrl` from
  /// `AppConfig` is the full invoke URL up to the stage suffix
  /// — `Dio` resolves relative paths against `BaseOptions.baseUrl`.
  static const _path = '/v1/categories';

  @override
  Future<List<Category>> list() async {
    try {
      return await _apiClient.getJson<List<Category>>(
        _path,
        parse: Category.listFromJson,
      );
    } on FormatException catch (e) {
      // Translate decode failures into the domain error so the
      // UI doesn't have to switch on FormatException + ApiException
      // separately.
      throw CategoriesLoadFailure(
        'Categories response was malformed: ${e.message}',
        isNetworkError: false,
      );
    } on ApiException catch (e) {
      throw CategoriesLoadFailure(
        e.message,
        isNetworkError: e.isNetworkError,
        statusCode: e.statusCode,
      );
    }
  }
}

/// Domain-friendly failure surface. The UI switches on
/// `isNetworkError` + `statusCode` to render the right error
/// state (offline copy vs. server-error copy).
class CategoriesLoadFailure implements Exception {
  CategoriesLoadFailure(
    this.message, {
    this.isNetworkError = false,
    this.statusCode,
  });

  final String message;
  final bool isNetworkError;
  final int? statusCode;

  @override
  String toString() => 'CategoriesLoadFailure: $message';
}
