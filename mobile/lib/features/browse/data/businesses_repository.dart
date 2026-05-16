// EthioLink Mobile — businesses repository.
//
// Wraps `GET /v1/businesses` with the documented query-string
// shape (see `backend/api/openapi.yaml` § `/businesses`).
// Mirrors `CategoriesRepository` in structure — production wires
// `HttpBusinessesRepository` over `ApiClient`; widget tests pass
// a fake.
//
// Phase 9 Track 6 widened the query surface from
// `category` + `cursor` + `limit` to the full filter + sort set:
//
//   * `q`            — free-text search; matches against name +
//                      description.en + description.am via the
//                      backend's GIN-indexed tsvector (with a
//                      trigram `lower(name)` fallback). Sent as
//                      `?q=<value>` on the wire. The `query`
//                      param name remains accepted by the API but
//                      this repository always emits `q` —
//                      `category` and `q` are independent and may
//                      be combined.
//   * `city`         — case-insensitive exact match.
//   * `ratingMin`    — number 0..5.
//   * `featuredOnly` — boolean; restricts to rows where
//                      `featured_until > now()`.
//   * `sort`         — one of `featured` (default), `relevance`,
//                      `rating`, `newest`. Only `featured`
//                      supports cursor pagination today; the
//                      repository forwards the value verbatim and
//                      the API replies with `nextCursor: null`
//                      for the other three.

import '../../../core/api/api_client.dart';
import '../models/business_summary.dart';

/// Phase 9 Track 6 — sort mode wire values. The repository forwards
/// the matching `?sort=<value>` query-string param to the API.
enum BusinessSort {
  featured('featured'),
  relevance('relevance'),
  rating('rating'),
  newest('newest');

  const BusinessSort(this.wire);
  final String wire;
}

abstract class BusinessesRepository {
  /// Page of APPROVED businesses, optionally filtered + sorted.
  /// Every parameter except `limit` corresponds 1:1 to a
  /// `GET /v1/businesses` query-string field.
  Future<BusinessListPage> list({
    String? category,
    String? cursor,
    int? limit,
    String? q,
    String? city,
    double? ratingMin,
    bool? featuredOnly,
    BusinessSort? sort,
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
    String? q,
    String? city,
    double? ratingMin,
    bool? featuredOnly,
    BusinessSort? sort,
  }) async {
    final query = <String, dynamic>{};
    if (category != null && category.isNotEmpty) query['category'] = category;
    if (cursor != null && cursor.isNotEmpty) query['cursor'] = cursor;
    if (limit != null) query['limit'] = limit;
    if (q != null && q.trim().isNotEmpty) query['q'] = q.trim();
    if (city != null && city.trim().isNotEmpty) query['city'] = city.trim();
    if (ratingMin != null) query['ratingMin'] = ratingMin;
    if (featuredOnly == true) query['featuredOnly'] = 'true';
    if (sort != null) query['sort'] = sort.wire;

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
