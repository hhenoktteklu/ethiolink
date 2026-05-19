// EthioLink Mobile — admin businesses repository.
//
// Wraps the three admin write endpoints that the mobile Review
// Queue screen needs:
//
//   * `GET  /v1/admin/businesses?status=PENDING_REVIEW` — list
//     the businesses in the review queue. Default filter is
//     PENDING_REVIEW since that's the only state an admin opens
//     this screen to act on; the same endpoint accepts other
//     statuses for future status-filtered tabs.
//   * `POST /v1/admin/businesses/{id}/approve` — flip
//     PENDING_REVIEW → APPROVED. Optional `notes` body (stored
//     on the `APPROVE_BUSINESS` admin_actions row).
//   * `POST /v1/admin/businesses/{id}/reject` — flip
//     PENDING_REVIEW → REJECTED. Optional `notes` body (stored
//     on the `REJECT_BUSINESS` admin_actions row — the canonical
//     rejection-reason store that the owner-side dashboard
//     surfaces via `OwnerBusinessView.rejection`).
//
// The mobile UI requires the operator to supply a non-empty
// reason when rejecting; the backend accepts null notes for
// API parity with the admin SPA's "Reason (recommended)" label,
// but the mobile dialog gates the call client-side.
//
// Failure classification mirrors `BusinessActionFailure` /
// `OwnerBusinessLoadFailure` shapes: typed enum so the UI
// switches on it cleanly. `forbidden` covers the BUSINESS_OWNER
// / CUSTOMER who somehow tries to hit an admin endpoint —
// they'll see "Sign in with an admin account" rather than a
// generic 403 toast.

import '../../../core/api/api_client.dart';
import '../../owner/models/owner_business_view.dart';

/// Domain port. Production wires `HttpAdminBusinessesRepository`;
/// tests pass an in-memory fake.
abstract class AdminBusinessesRepository {
  /// List businesses filtered by [status]. Defaults to
  /// `PENDING_REVIEW` — the canonical review queue. Limit caps
  /// at 100 server-side (see `backend/lambdas/admin/businesses/list.ts`).
  Future<List<OwnerBusinessView>> list({
    String status = 'PENDING_REVIEW',
    int? limit,
  });

  /// Approve a PENDING_REVIEW business. `notes` lands on the
  /// `APPROVE_BUSINESS` admin_actions row; pass null when the
  /// admin had nothing to add.
  Future<OwnerBusinessView> approve(String id, {String? notes});

  /// Reject a PENDING_REVIEW business. The mobile review-queue
  /// dialog REQUIRES a non-empty reason (the owner-facing
  /// banner reads it back via `OwnerBusinessView.rejection.reason`);
  /// the backend itself accepts null for parity with the admin
  /// SPA.
  Future<OwnerBusinessView> reject(String id, {required String notes});
}

enum AdminBusinessFailureKind {
  /// 401 — token rejected. Sign back in.
  unauthenticated,

  /// 403 — caller is not ADMIN. The mobile shell shouldn't
  /// expose the screen to non-admins, but defensive UI copy
  /// catches a stale session whose role got demoted.
  forbidden,

  /// 404 — business id no longer exists or was hard-deleted.
  notFound,

  /// 409 — invalid status transition (e.g. trying to approve
  /// an already-APPROVED row).
  conflict,

  /// 400 — validation error. Notes too long, malformed id,
  /// etc.
  validation,

  /// 5xx or transport.
  network,

  /// Decode error or unmatched 4xx.
  other,
}

class AdminBusinessFailure implements Exception {
  AdminBusinessFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final AdminBusinessFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  factory AdminBusinessFailure.fromApi(ApiException e) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    AdminBusinessFailureKind k;
    if (e.isNetworkError) {
      k = AdminBusinessFailureKind.network;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = AdminBusinessFailureKind.unauthenticated;
    } else if (status == 403 || code == 'FORBIDDEN') {
      k = AdminBusinessFailureKind.forbidden;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = AdminBusinessFailureKind.notFound;
    } else if (status == 409 || code == 'CONFLICT') {
      k = AdminBusinessFailureKind.conflict;
    } else if (status == 400 || code == 'VALIDATION_ERROR') {
      k = AdminBusinessFailureKind.validation;
    } else if (status != null && status >= 500) {
      k = AdminBusinessFailureKind.network;
    } else {
      k = AdminBusinessFailureKind.other;
    }
    return AdminBusinessFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'AdminBusinessFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}

class HttpAdminBusinessesRepository implements AdminBusinessesRepository {
  HttpAdminBusinessesRepository(this._client);
  final ApiClient _client;

  static const _basePath = '/v1/admin/businesses';

  @override
  Future<List<OwnerBusinessView>> list({
    String status = 'PENDING_REVIEW',
    int? limit,
  }) async {
    try {
      return await _client.getJson<List<OwnerBusinessView>>(
        _basePath,
        queryParameters: <String, dynamic>{
          'status': status,
          if (limit != null) 'limit': limit,
        },
        parse: _parseList,
      );
    } on ApiException catch (e) {
      throw AdminBusinessFailure.fromApi(e);
    } on FormatException catch (e) {
      throw AdminBusinessFailure(
        kind: AdminBusinessFailureKind.other,
        message: 'Malformed admin list response: ${e.message}',
      );
    }
  }

  @override
  Future<OwnerBusinessView> approve(String id, {String? notes}) async {
    return _act(id, 'approve', notes);
  }

  @override
  Future<OwnerBusinessView> reject(
    String id, {
    required String notes,
  }) async {
    // Notes is required at the mobile UI layer (the dialog
    // gates submit on a non-empty reason), but the backend
    // contract is "optional notes" — we forward whatever the
    // caller supplied. An empty reason that slipped past the
    // dialog would still hit the backend; defensive trim is
    // cheap.
    return _act(id, 'reject', notes.trim().isEmpty ? null : notes.trim());
  }

  Future<OwnerBusinessView> _act(
    String id,
    String action,
    String? notes,
  ) async {
    try {
      return await _client.postJson<OwnerBusinessView>(
        '$_basePath/${Uri.encodeComponent(id)}/$action',
        body: <String, dynamic>{'notes': notes},
        parse: OwnerBusinessView.fromJson,
      );
    } on ApiException catch (e) {
      throw AdminBusinessFailure.fromApi(e);
    } on FormatException catch (e) {
      throw AdminBusinessFailure(
        kind: AdminBusinessFailureKind.other,
        message: 'Malformed admin $action response: ${e.message}',
      );
    }
  }
}

List<OwnerBusinessView> _parseList(dynamic body) {
  if (body is! Map<String, dynamic>) {
    throw const FormatException('Admin list response must be an object.');
  }
  final items = body['items'];
  if (items is! List) {
    throw const FormatException('Admin list response missing items array.');
  }
  return items
      .map<OwnerBusinessView>(OwnerBusinessView.fromJson)
      .toList(growable: false);
}
