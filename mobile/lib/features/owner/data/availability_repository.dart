// EthioLink Mobile — owner availability repository.
//
// Phase 9 Track 3.5 fifth commit. Wraps the three endpoints the
// availability editor needs:
//
//   * `GET    /v1/businesses/{businessId}/staff/{staffId}/availability`
//     → full schedule (weekly windows + overrides).
//   * `PUT    /v1/businesses/{businessId}/staff/{staffId}/availability`
//     → atomic "replace the entire weekly schedule". Must include
//     all 7 weekdays (each appearing exactly once); empty
//     `windows` for a weekday is "closed all day".
//   * `POST   /v1/businesses/{businessId}/staff/{staffId}/availability/override`
//     → add a single OVERRIDE row (open window or closed-date
//     blackout). The endpoint returns the newly-created row, not
//     the full schedule, so callers re-fetch via getSchedule()
//     after a successful POST.
//
// Failure classification mirrors the other owner-side surfaces.

import '../../../core/api/api_client.dart';
import '../models/availability.dart';

abstract class AvailabilityRepository {
  Future<AvailabilitySchedule> getSchedule(
    String businessId,
    String staffId,
  );

  Future<AvailabilitySchedule> replaceWeekly(
    String businessId,
    String staffId,
    List<WeeklyDayInput> days,
  );

  Future<AvailabilityWindow> addOverride(
    String businessId,
    String staffId,
    AvailabilityOverrideRequest request,
  );
}

class HttpAvailabilityRepository implements AvailabilityRepository {
  HttpAvailabilityRepository(this._client);
  final ApiClient _client;

  static String _path(String businessId, String staffId) =>
      '/v1/businesses/$businessId/staff/$staffId/availability';
  static String _overridePath(String businessId, String staffId) =>
      '/v1/businesses/$businessId/staff/$staffId/availability/override';

  @override
  Future<AvailabilitySchedule> getSchedule(
    String businessId,
    String staffId,
  ) async {
    try {
      return await _client.getJson<AvailabilitySchedule>(
        _path(businessId, staffId),
        parse: AvailabilitySchedule.fromJson,
      );
    } on FormatException catch (e) {
      throw AvailabilityFailure(
        kind: AvailabilityFailureKind.malformedResponse,
        message: 'Schedule response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw AvailabilityFailure.fromApi(e);
    }
  }

  @override
  Future<AvailabilitySchedule> replaceWeekly(
    String businessId,
    String staffId,
    List<WeeklyDayInput> days,
  ) async {
    final body = <String, dynamic>{
      'days': [for (final d in days) d.toJson()],
    };
    try {
      return await _client.putJson<AvailabilitySchedule>(
        _path(businessId, staffId),
        body: body,
        parse: AvailabilitySchedule.fromJson,
      );
    } on FormatException catch (e) {
      throw AvailabilityFailure(
        kind: AvailabilityFailureKind.malformedResponse,
        message: 'Schedule-replace response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw AvailabilityFailure.fromApi(e);
    }
  }

  @override
  Future<AvailabilityWindow> addOverride(
    String businessId,
    String staffId,
    AvailabilityOverrideRequest request,
  ) async {
    try {
      return await _client.postJson<AvailabilityWindow>(
        _overridePath(businessId, staffId),
        body: request.toJson(),
        parse: AvailabilityWindow.fromJson,
      );
    } on FormatException catch (e) {
      throw AvailabilityFailure(
        kind: AvailabilityFailureKind.malformedResponse,
        message: 'Override response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw AvailabilityFailure.fromApi(e);
    }
  }
}

/// Failure classification consumed by `OwnerAvailabilityScreen`.
/// Mirrors `OwnerServicesFailureKind` / `OwnerStaffFailureKind`.
enum AvailabilityFailureKind {
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

class AvailabilityFailure implements Exception {
  AvailabilityFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final AvailabilityFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  factory AvailabilityFailure.fromApi(ApiException e) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    AvailabilityFailureKind k;
    if (e.isNetworkError) {
      k = AvailabilityFailureKind.network;
    } else if (status == 400 || code == 'VALIDATION_ERROR') {
      k = AvailabilityFailureKind.validation;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = AvailabilityFailureKind.unauthenticated;
    } else if (status == 403 || code == 'FORBIDDEN') {
      k = AvailabilityFailureKind.forbidden;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = AvailabilityFailureKind.notFound;
    } else if (status == 409 || code == 'CONFLICT') {
      k = AvailabilityFailureKind.conflict;
    } else if (status != null && status >= 500) {
      k = AvailabilityFailureKind.serverError;
    } else {
      k = AvailabilityFailureKind.other;
    }
    return AvailabilityFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'AvailabilityFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}
