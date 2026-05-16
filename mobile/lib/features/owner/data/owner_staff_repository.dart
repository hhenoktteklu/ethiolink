// EthioLink Mobile — owner staff repository.
//
// Phase 9 Track 3.5 fourth commit. Wraps the four staff-CRUD
// endpoints the owner-side surface needs:
//
//   * `GET    /v1/businesses/{businessId}/staff` — list active
//     staff members. Public endpoint (auth interceptor still
//     attaches the bearer when present; harmless on a public
//     route).
//
//   * `POST   /v1/businesses/{businessId}/staff` — create an
//     active staff member. Authenticated, BUSINESS_OWNER role,
//     owner-of-business.
//
//   * `PATCH  /v1/businesses/{businessId}/staff/{id}` — edit a
//     staff member. Each field optional. `displayName` cannot be
//     cleared (DB NOT NULL); `role` accepts `null` to clear.
//     `isActive` cannot be patched here — use DELETE to
//     deactivate.
//
//   * `DELETE /v1/businesses/{businessId}/staff/{id}` — soft-
//     delete. Flips `is_active` to `false` and returns the
//     deactivated row.
//
// Failure classification mirrors `OwnerServicesFailureKind` so
// the screen can share the same banner copy across CRUD surfaces.

import '../../../core/api/api_client.dart';
import '../../browse/models/staff.dart';

/// Domain port. Production: `HttpOwnerStaffRepository`. Tests:
/// in-memory fake.
abstract class OwnerStaffRepository {
  Future<List<Staff>> listStaff(String businessId);

  Future<Staff> createStaff(
    String businessId,
    CreateStaffRequest request,
  );

  Future<Staff> updateStaff(
    String businessId,
    String staffId,
    UpdateStaffRequest request,
  );

  Future<Staff> deactivateStaff(String businessId, String staffId);
}

/// POST body. `displayName` is required by the API; `role` is
/// optional (free-text job title).
class CreateStaffRequest {
  const CreateStaffRequest({required this.displayName, this.role});

  final String displayName;
  final String? role;

  Map<String, dynamic> toJson() {
    final body = <String, dynamic>{'displayName': displayName};
    if (role != null && role!.isNotEmpty) body['role'] = role;
    return body;
  }
}

/// PATCH body. Every field optional ("no change" by absence). Use
/// `clearRole` to explicitly clear the column — the JSON encodes
/// as `null`. The API rejects `null` for `displayName` (DB NOT
/// NULL), so that affordance isn't surfaced.
class UpdateStaffRequest {
  const UpdateStaffRequest({
    this.displayName,
    this.role,
    this.clearRole = false,
  });

  final String? displayName;
  final String? role;
  final bool clearRole;

  Map<String, dynamic> toJson() {
    final body = <String, dynamic>{};
    if (displayName != null && displayName!.isNotEmpty) {
      body['displayName'] = displayName;
    }
    if (clearRole) {
      body['role'] = null;
    } else if (role != null && role!.isNotEmpty) {
      body['role'] = role;
    }
    return body;
  }
}

class HttpOwnerStaffRepository implements OwnerStaffRepository {
  HttpOwnerStaffRepository(this._client);
  final ApiClient _client;

  static String _collection(String businessId) =>
      '/v1/businesses/$businessId/staff';
  static String _resource(String businessId, String staffId) =>
      '/v1/businesses/$businessId/staff/$staffId';

  @override
  Future<List<Staff>> listStaff(String businessId) async {
    try {
      return await _client.getJson<List<Staff>>(
        _collection(businessId),
        parse: Staff.listFromJson,
      );
    } on FormatException catch (e) {
      throw OwnerStaffFailure(
        kind: OwnerStaffFailureKind.malformedResponse,
        message: 'Staff response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw OwnerStaffFailure.fromApi(e);
    }
  }

  @override
  Future<Staff> createStaff(
    String businessId,
    CreateStaffRequest request,
  ) async {
    try {
      return await _client.postJson<Staff>(
        _collection(businessId),
        body: request.toJson(),
        parse: Staff.fromJson,
      );
    } on FormatException catch (e) {
      throw OwnerStaffFailure(
        kind: OwnerStaffFailureKind.malformedResponse,
        message: 'Staff-create response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw OwnerStaffFailure.fromApi(e);
    }
  }

  @override
  Future<Staff> updateStaff(
    String businessId,
    String staffId,
    UpdateStaffRequest request,
  ) async {
    try {
      return await _client.patchJson<Staff>(
        _resource(businessId, staffId),
        body: request.toJson(),
        parse: Staff.fromJson,
      );
    } on FormatException catch (e) {
      throw OwnerStaffFailure(
        kind: OwnerStaffFailureKind.malformedResponse,
        message: 'Staff-patch response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw OwnerStaffFailure.fromApi(e);
    }
  }

  @override
  Future<Staff> deactivateStaff(
    String businessId,
    String staffId,
  ) async {
    try {
      return await _client.deleteJson<Staff>(
        _resource(businessId, staffId),
        parse: Staff.fromJson,
      );
    } on FormatException catch (e) {
      throw OwnerStaffFailure(
        kind: OwnerStaffFailureKind.malformedResponse,
        message: 'Staff-delete response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw OwnerStaffFailure.fromApi(e);
    }
  }
}

/// Failure classification consumed by `OwnerStaffScreen`. Mirrors
/// `OwnerServicesFailureKind` exactly — both surfaces switch on
/// the same nine cases.
enum OwnerStaffFailureKind {
  validation,
  forbidden,
  unauthenticated,
  conflict,
  notFound,
  network,
  serverError,
  malformedResponse,
  other,
}

class OwnerStaffFailure implements Exception {
  OwnerStaffFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final OwnerStaffFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  factory OwnerStaffFailure.fromApi(ApiException e) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    OwnerStaffFailureKind k;
    if (e.isNetworkError) {
      k = OwnerStaffFailureKind.network;
    } else if (status == 400 || code == 'VALIDATION_ERROR') {
      k = OwnerStaffFailureKind.validation;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = OwnerStaffFailureKind.unauthenticated;
    } else if (status == 403 || code == 'FORBIDDEN') {
      k = OwnerStaffFailureKind.forbidden;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = OwnerStaffFailureKind.notFound;
    } else if (status == 409 || code == 'CONFLICT') {
      k = OwnerStaffFailureKind.conflict;
    } else if (status != null && status >= 500) {
      k = OwnerStaffFailureKind.serverError;
    } else {
      k = OwnerStaffFailureKind.other;
    }
    return OwnerStaffFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'OwnerStaffFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}
