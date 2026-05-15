// EthioLink Mobile — businesses repository.
//
// Wraps `GET /v1/businesses` with the documented query-string
// shape (see `backend/api/openapi.yaml` § `/businesses`).
// Mirrors `CategoriesRepository` in structure — production wires
// `HttpBusinessesRepository` over `ApiClient`; widget tests pass
// a fake.
//
// The MVP listing exposes only `category` + `cursor` + `limit`
// today. `city` / `query` / `ratingMin` filters land alongside
// the filter-chip UI in a follow-up commit.

import '../../../core/api/api_client.dart';
import '../models/business_summary.dart';

abstract class BusinessesRepository {
  /// Page of APPROVED businesses, optionally filtered to one
  /// category slug. `cursor` is the opaque token from the
  /// previous response's `nextCursor`. `limit` caps page size
  /// (1..100 per API contract; null defers to the server default,
  /// currently 20).
  Future<BusinessListPage> list({
    String? category,
    String? cursor,
    int? limit,
  });
}

class HttpBusinessesRepository implements BusinessesRepository {
  HttpBusinessesRepository(this._apiClient);

  final ApiClient _apiClient;

  /// Path. Same shape as the categories repository — relative
  /// against `AppConfig.apiBaseUrl`, which the `Dio` instance
  /// resolves via `BaseOptions.baseUrl`.
  static const _path = '/v1/businesses';

  @override
  Future<BusinessListPage> list({
    String? category,
    String? cursor,
    int? limit,
  }) async {
    final query = <String, dynamic>{};
    if (category != null && category.isNotEmpty) query['category'] = category;
    if (cursor != null && cursor.isNotEmpty) query['cursor'] = cursor;
    if (limit != null) query['limit'] = limit;

    try {
      return await _apiClient.getJson<BusinessListPage>(
        _path,
        queryParameters: query.isEmpty ? null : query,
        parse: BusinessListPage.fromJson,
      );
    } on FormatException catch (e) {
      throw BusinessesLoadFailure(
        'Businesses response was malformed: ${e.message}',
        isNetworkError: false,
      );
    } on ApiException catch (e) {
      throw BusinessesLoadFailure(
        e.message,
        isNetworkError: e.isNetworkError,
        statusCode: e.statusCode,
      );
    }
  }
}

/// Domain failure surface. Mirrors `CategoriesLoadFailure`.
class BusinessesLoadFailure implements Exception {
  BusinessesLoadFailure(
    this.message, {
    this.isNetworkError = false,
    this.statusCode,
  });

  final String message;
  final bool isNetworkError;
  final int? statusCode;

  @override
  String toString() => 'BusinessesLoadFailure: $message';
}
