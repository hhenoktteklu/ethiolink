// EthioLink Mobile — owner services repository.
//
// Phase 9 Track 3.5 third commit. Wraps the four service-CRUD
// endpoints the owner-side surface needs:
//
//   * `GET    /v1/businesses/{businessId}/services` — list active
//     services. The endpoint is public, so the GET works without
//     a token. The auth interceptor still attaches the bearer
//     when one's present (harmless).
//
//   * `POST   /v1/businesses/{businessId}/services` — create an
//     active service. Authenticated, BUSINESS_OWNER role,
//     owner-of-business.
//
//   * `PATCH  /v1/businesses/{businessId}/services/{id}` — edit a
//     service. Each field optional. `name` + `durationMinutes`
//     cannot be cleared (DB NOT NULL); `description` + `priceEtb`
//     accept `null` to clear. `isActive` cannot be patched — use
//     DELETE to deactivate.
//
//   * `DELETE /v1/businesses/{businessId}/services/{id}` — soft-
//     delete. Flips `is_active` to `false` and returns the
//     deactivated row (so the owner UI can show "Deactivated"
//     copy without re-fetching the list).
//
// Failure classification mirrors `BusinessActionFailureKind` so
// the screen can switch on the same nine cases uniformly.

import '../../../core/api/api_client.dart';
import '../../browse/models/service.dart';

/// Domain port. Production: `HttpOwnerServicesRepository`. Tests:
/// in-memory fake.
abstract class OwnerServicesRepository {
  Future<List<Service>> listServices(String businessId);

  Future<Service> createService(
    String businessId,
    CreateServiceRequest request,
  );

  Future<Service> updateService(
    String businessId,
    String serviceId,
    UpdateServiceRequest request,
  );

  Future<Service> deactivateService(String businessId, String serviceId);
}

/// POST body. `name` + `durationMinutes` are required by the
/// API; `descriptionEn` + `priceEtb` are optional.
class CreateServiceRequest {
  const CreateServiceRequest({
    required this.nameEn,
    required this.durationMinutes,
    this.descriptionEn,
    this.priceEtb,
  });

  final String nameEn;
  final int durationMinutes;
  final String? descriptionEn;
  final double? priceEtb;

  Map<String, dynamic> toJson() {
    final body = <String, dynamic>{
      'name': <String, dynamic>{'en': nameEn},
      'durationMinutes': durationMinutes,
    };
    if (descriptionEn != null && descriptionEn!.isNotEmpty) {
      body['description'] = <String, dynamic>{'en': descriptionEn};
    }
    if (priceEtb != null) body['priceEtb'] = priceEtb;
    return body;
  }
}

/// PATCH body. Every field is optional ("no change" by absence).
/// Use `clearDescription` / `clearPrice` to explicitly clear the
/// column (the JSON encodes as `null`). The API rejects `null`
/// for `name` + `durationMinutes` (DB NOT NULL), so those
/// affordances aren't surfaced.
class UpdateServiceRequest {
  const UpdateServiceRequest({
    this.nameEn,
    this.durationMinutes,
    this.descriptionEn,
    this.clearDescription = false,
    this.priceEtb,
    this.clearPrice = false,
  });

  final String? nameEn;
  final int? durationMinutes;
  final String? descriptionEn;
  final bool clearDescription;
  final double? priceEtb;
  final bool clearPrice;

  Map<String, dynamic> toJson() {
    final body = <String, dynamic>{};
    if (nameEn != null && nameEn!.isNotEmpty) {
      body['name'] = <String, dynamic>{'en': nameEn};
    }
    if (durationMinutes != null) body['durationMinutes'] = durationMinutes;
    if (clearDescription) {
      body['description'] = null;
    } else if (descriptionEn != null && descriptionEn!.isNotEmpty) {
      body['description'] = <String, dynamic>{'en': descriptionEn};
    }
    if (clearPrice) {
      body['priceEtb'] = null;
    } else if (priceEtb != null) {
      body['priceEtb'] = priceEtb;
    }
    return body;
  }
}

class HttpOwnerServicesRepository implements OwnerServicesRepository {
  HttpOwnerServicesRepository(this._client);
  final ApiClient _client;

  static String _collection(String businessId) =>
      '/v1/businesses/$businessId/services';
  static String _resource(String businessId, String serviceId) =>
      '/v1/businesses/$businessId/services/$serviceId';

  @override
  Future<List<Service>> listServices(String businessId) async {
    try {
      return await _client.getJson<List<Service>>(
        _collection(businessId),
        parse: Service.listFromJson,
      );
    } on FormatException catch (e) {
      throw OwnerServicesFailure(
        kind: OwnerServicesFailureKind.malformedResponse,
        message: 'Services response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw OwnerServicesFailure.fromApi(e);
    }
  }

  @override
  Future<Service> createService(
    String businessId,
    CreateServiceRequest request,
  ) async {
    try {
      return await _client.postJson<Service>(
        _collection(businessId),
        body: request.toJson(),
        parse: Service.fromJson,
      );
    } on FormatException catch (e) {
      throw OwnerServicesFailure(
        kind: OwnerServicesFailureKind.malformedResponse,
        message: 'Service-create response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw OwnerServicesFailure.fromApi(e);
    }
  }

  @override
  Future<Service> updateService(
    String businessId,
    String serviceId,
    UpdateServiceRequest request,
  ) async {
    try {
      return await _client.patchJson<Service>(
        _resource(businessId, serviceId),
        body: request.toJson(),
        parse: Service.fromJson,
      );
    } on FormatException catch (e) {
      throw OwnerServicesFailure(
        kind: OwnerServicesFailureKind.malformedResponse,
        message: 'Service-patch response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw OwnerServicesFailure.fromApi(e);
    }
  }

  @override
  Future<Service> deactivateService(
    String businessId,
    String serviceId,
  ) async {
    try {
      return await _client.deleteJson<Service>(
        _resource(businessId, serviceId),
        parse: Service.fromJson,
      );
    } on FormatException catch (e) {
      throw OwnerServicesFailure(
        kind: OwnerServicesFailureKind.malformedResponse,
        message: 'Service-delete response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw OwnerServicesFailure.fromApi(e);
    }
  }
}

/// Failure classification consumed by `OwnerServicesScreen`. The
/// mapping mirrors `BusinessActionFailureKind`: 400 → `validation`,
/// 401 → `unauthenticated`, 403 → `forbidden`, 404 → `notFound`,
/// 409 → `conflict`, 5xx → `serverError`, network → `network`,
/// decode-failure → `malformedResponse`, else → `other`.
enum OwnerServicesFailureKind {
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

class OwnerServicesFailure implements Exception {
  OwnerServicesFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final OwnerServicesFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  factory OwnerServicesFailure.fromApi(ApiException e) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    OwnerServicesFailureKind k;
    if (e.isNetworkError) {
      k = OwnerServicesFailureKind.network;
    } else if (status == 400 || code == 'VALIDATION_ERROR') {
      k = OwnerServicesFailureKind.validation;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = OwnerServicesFailureKind.unauthenticated;
    } else if (status == 403 || code == 'FORBIDDEN') {
      k = OwnerServicesFailureKind.forbidden;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = OwnerServicesFailureKind.notFound;
    } else if (status == 409 || code == 'CONFLICT') {
      k = OwnerServicesFailureKind.conflict;
    } else if (status != null && status >= 500) {
      k = OwnerServicesFailureKind.serverError;
    } else {
      k = OwnerServicesFailureKind.other;
    }
    return OwnerServicesFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'OwnerServicesFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}
