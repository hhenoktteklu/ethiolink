// EthioLink Mobile — owner featuring repository.
//
// Phase 9 Track 6 owner mobile UI. Wraps the four owner-side
// featuring endpoints:
//
//   * GET    /v1/businesses/{businessId}/featuring/packages
//   * POST   /v1/businesses/{businessId}/featuring/subscribe
//   * GET    /v1/businesses/{businessId}/featuring/active
//   * GET    /v1/businesses/{businessId}/featuring/history
//
// All four are authenticated; the `ApiClient`'s
// `AuthTokenInterceptor` attaches the bearer header. The
// repository surface mirrors the failure-kind pattern used
// elsewhere — `FeaturingFailureKind` + `FeaturingFailure` so the
// UI switches on the kind for per-state copy.

import '../../../core/api/api_client.dart';
import '../models/featuring.dart';

/// Domain port. Production wires `HttpFeaturingRepository`; tests
/// pass a fake.
abstract class FeaturingRepository {
  Future<List<FeaturingPackage>> listPackages(String businessId);
  Future<FeaturingSubscription> subscribe(
    String businessId,
    String packageCode,
  );
  Future<FeaturingSubscription?> getActive(String businessId);
  Future<List<FeaturingSubscription>> listHistory(
    String businessId, {
    int? limit,
  });
}

/// Failure classification consumed by `OwnerPromoteScreen` +
/// `OwnerFeaturingHistoryScreen`. Each kind maps to a distinct
/// UI branch (banner / SnackBar copy).
enum FeaturingFailureKind {
  /// 503 FEATURING_DISABLED — the env hasn't opted in to paid
  /// featuring. Screen renders a dedicated "Not yet available"
  /// state.
  disabled,

  /// 503 ONLINE_PAYMENTS_UNAVAILABLE — gateway unavailable.
  /// Surfaced as the same "Not yet available" branch for now.
  unavailable,

  /// 409 CONFLICT — already-active subscription.
  alreadyActive,

  /// 402 PAYMENT_REQUIRED — gateway returned FAILED.
  paymentRequired,

  /// 401 — session expired.
  unauthenticated,

  /// 403 — not the owner of this business.
  forbidden,

  /// 404 — business not found / orphaned.
  notFound,

  /// 400 — unknown package code or malformed body. Should never
  /// happen in the wild (the UI only sends server-known codes)
  /// but recorded defensively.
  validation,

  /// DNS / timeout / 5xx — transport-level failure.
  network,

  /// Everything else (decode errors, unexpected 4xx).
  other,
}

class FeaturingFailure implements Exception {
  FeaturingFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final FeaturingFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  factory FeaturingFailure.fromApi(ApiException e) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    FeaturingFailureKind k;
    if (e.isNetworkError) {
      k = FeaturingFailureKind.network;
    } else if (code == 'FEATURING_DISABLED') {
      k = FeaturingFailureKind.disabled;
    } else if (code == 'ONLINE_PAYMENTS_UNAVAILABLE' || status == 503) {
      k = FeaturingFailureKind.unavailable;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = FeaturingFailureKind.unauthenticated;
    } else if (status == 402 || code == 'PAYMENT_REQUIRED') {
      k = FeaturingFailureKind.paymentRequired;
    } else if (status == 403 || code == 'FORBIDDEN') {
      k = FeaturingFailureKind.forbidden;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = FeaturingFailureKind.notFound;
    } else if (status == 409 || code == 'CONFLICT') {
      k = FeaturingFailureKind.alreadyActive;
    } else if (status == 400 || code == 'VALIDATION_ERROR') {
      k = FeaturingFailureKind.validation;
    } else if (status != null && status >= 500) {
      k = FeaturingFailureKind.network;
    } else {
      k = FeaturingFailureKind.other;
    }
    return FeaturingFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'FeaturingFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}

class HttpFeaturingRepository implements FeaturingRepository {
  HttpFeaturingRepository(this._client);
  final ApiClient _client;

  String _packagesPath(String businessId) =>
      '/v1/businesses/$businessId/featuring/packages';
  String _subscribePath(String businessId) =>
      '/v1/businesses/$businessId/featuring/subscribe';
  String _activePath(String businessId) =>
      '/v1/businesses/$businessId/featuring/active';
  String _historyPath(String businessId) =>
      '/v1/businesses/$businessId/featuring/history';

  @override
  Future<List<FeaturingPackage>> listPackages(String businessId) async {
    try {
      return await _client.getJson<List<FeaturingPackage>>(
        _packagesPath(businessId),
        parse: _parsePackageList,
      );
    } on FormatException catch (e) {
      throw FeaturingFailure(
        kind: FeaturingFailureKind.other,
        message: 'Featuring packages response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw FeaturingFailure.fromApi(e);
    }
  }

  @override
  Future<FeaturingSubscription> subscribe(
    String businessId,
    String packageCode,
  ) async {
    try {
      return await _client.postJson<FeaturingSubscription>(
        _subscribePath(businessId),
        body: <String, dynamic>{'packageCode': packageCode},
        parse: FeaturingSubscription.fromJson,
      );
    } on FormatException catch (e) {
      throw FeaturingFailure(
        kind: FeaturingFailureKind.other,
        message: 'Featuring subscribe response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw FeaturingFailure.fromApi(e);
    }
  }

  @override
  Future<FeaturingSubscription?> getActive(String businessId) async {
    try {
      return await _client.getJson<FeaturingSubscription?>(
        _activePath(businessId),
        parse: _parseActive,
      );
    } on FormatException catch (e) {
      throw FeaturingFailure(
        kind: FeaturingFailureKind.other,
        message: 'Featuring active response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw FeaturingFailure.fromApi(e);
    }
  }

  @override
  Future<List<FeaturingSubscription>> listHistory(
    String businessId, {
    int? limit,
  }) async {
    try {
      return await _client.getJson<List<FeaturingSubscription>>(
        _historyPath(businessId),
        queryParameters: limit != null ? <String, dynamic>{'limit': limit} : null,
        parse: _parseSubscriptionList,
      );
    } on FormatException catch (e) {
      throw FeaturingFailure(
        kind: FeaturingFailureKind.other,
        message: 'Featuring history response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw FeaturingFailure.fromApi(e);
    }
  }
}

// ---------------------------------------------------------------------------
// Parsers — kept module-private; throw `FormatException` so the
// repository translates them into the typed failure surface.
// ---------------------------------------------------------------------------

List<FeaturingPackage> _parsePackageList(dynamic body) {
  if (body is! Map<String, dynamic>) {
    throw const FormatException('Body must be an object.');
  }
  final items = body['items'];
  if (items is! List) {
    throw const FormatException('items must be an array.');
  }
  return [for (final entry in items) FeaturingPackage.fromJson(entry)];
}

List<FeaturingSubscription> _parseSubscriptionList(dynamic body) {
  if (body is! Map<String, dynamic>) {
    throw const FormatException('Body must be an object.');
  }
  final items = body['items'];
  if (items is! List) {
    throw const FormatException('items must be an array.');
  }
  return [
    for (final entry in items) FeaturingSubscription.fromJson(entry),
  ];
}

FeaturingSubscription? _parseActive(dynamic body) {
  if (body is! Map<String, dynamic>) {
    throw const FormatException('Body must be an object.');
  }
  final active = body['active'];
  if (active == null) return null;
  return FeaturingSubscription.fromJson(active);
}
