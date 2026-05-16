// EthioLink Mobile — owner business repository.
//
// Wraps `GET /v1/me/business`. The endpoint has three operator-
// meaningful outcomes the owner tab branches on:
//
//   * 200 → `OwnerBusinessView` (status determines the next UI
//     state — see `OwnerBusinessView.isApproved` etc.).
//   * 404 → the caller hasn't created a business yet OR hasn't
//     called `POST /v1/auth/sync` since signing up. The tab
//     surfaces the "Create your business" CTA.
//   * 403 → forbidden. Rare; the most common cause is a stale
//     id token where the user's `cognito:groups` no longer
//     matches what the server expects. The UI prompts a
//     sign-out + sign-back-in to refresh the token.
//
// The hand-shaped failure-kind enum lets the widget switch on
// these branches without parsing error strings.

import '../../../core/api/api_client.dart';
import '../models/owner_business_view.dart';

abstract class OwnerBusinessRepository {
  Future<OwnerBusinessView> getMine();
}

class HttpOwnerBusinessRepository implements OwnerBusinessRepository {
  HttpOwnerBusinessRepository(this._client);
  final ApiClient _client;

  static const _path = '/v1/me/business';

  @override
  Future<OwnerBusinessView> getMine() async {
    try {
      return await _client.getJson<OwnerBusinessView>(
        _path,
        parse: OwnerBusinessView.fromJson,
      );
    } on FormatException catch (e) {
      throw OwnerBusinessLoadFailure(
        kind: OwnerBusinessLoadFailureKind.malformedResponse,
        message: 'Owner business response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw OwnerBusinessLoadFailure.fromApi(e);
    }
  }
}

/// Failure classification consumed by `OwnerTab`. The tab maps
/// each kind to a dedicated branch:
///
///   * `notFound` → CreateBusiness CTA placeholder.
///   * `forbidden` → sign-out + sign-back-in copy.
///   * `unauthenticated` → "sign in required" copy.
///   * `network` → "can't reach server" with retry.
///   * `serverError` / `malformedResponse` / `other` → generic
///     retry.
enum OwnerBusinessLoadFailureKind {
  notFound,
  forbidden,
  unauthenticated,
  network,
  serverError,
  malformedResponse,
  other,
}

class OwnerBusinessLoadFailure implements Exception {
  OwnerBusinessLoadFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final OwnerBusinessLoadFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  factory OwnerBusinessLoadFailure.fromApi(ApiException e) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    OwnerBusinessLoadFailureKind k;
    if (e.isNetworkError) {
      k = OwnerBusinessLoadFailureKind.network;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = OwnerBusinessLoadFailureKind.notFound;
    } else if (status == 403 || code == 'FORBIDDEN') {
      k = OwnerBusinessLoadFailureKind.forbidden;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = OwnerBusinessLoadFailureKind.unauthenticated;
    } else if (status != null && status >= 500) {
      k = OwnerBusinessLoadFailureKind.serverError;
    } else {
      k = OwnerBusinessLoadFailureKind.other;
    }
    return OwnerBusinessLoadFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'OwnerBusinessLoadFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}
