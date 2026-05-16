// EthioLink Mobile — booking flow repositories.
//
// Two ports + two `Http*` implementations:
//
//   * `SlotsRepository` — `GET /v1/businesses/{id}/staff/{sid}/slots`
//                         with the required `serviceId` + `from` +
//                         `to` query params.
//   * `AppointmentsRepository` — `POST /v1/appointments` with the
//                                 `CreateAppointmentRequest` body.
//
// Error semantics:
//   * `SlotsLoadFailure` — same shape as the rest of the
//     repositories. The booking flow shows network vs. server
//     variants + retry.
//   * `AppointmentCreateFailure` — carries a typed `kind` so the
//     UI can branch precisely. The booking-flow needs to tell
//     `SLOT_UNAVAILABLE` (409 — clear "pick another slot" copy)
//     apart from `UNAUTHENTICATED` (401 — sign-in required) and
//     generic transport failures.

import '../../../core/api/api_client.dart';
import '../models/appointment.dart';
import '../models/slot.dart';

abstract class SlotsRepository {
  Future<List<Slot>> list({
    required String businessId,
    required String staffId,
    required String serviceId,
    required String fromDate,
    required String toDate,
  });
}

abstract class AppointmentsRepository {
  /// `POST /v1/appointments` with the documented request body.
  /// Throws `AppointmentCreateFailure` on every non-2xx — see the
  /// failure-kind enum below for the dispatch.
  Future<Appointment> create({
    required String staffId,
    required String serviceId,
    required String startsAtIso,
    required String paymentMethod,
    String? notes,
  });
}

// ---------------------------------------------------------------------------
// Http implementations
// ---------------------------------------------------------------------------

class HttpSlotsRepository implements SlotsRepository {
  HttpSlotsRepository(this._client);
  final ApiClient _client;

  @override
  Future<List<Slot>> list({
    required String businessId,
    required String staffId,
    required String serviceId,
    required String fromDate,
    required String toDate,
  }) async {
    try {
      return await _client.getJson<List<Slot>>(
        '/v1/businesses/$businessId/staff/$staffId/slots',
        queryParameters: <String, dynamic>{
          'serviceId': serviceId,
          'from': fromDate,
          'to': toDate,
        },
        parse: Slot.listFromJson,
      );
    } on FormatException catch (e) {
      throw SlotsLoadFailure(
        'Slots response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw SlotsLoadFailure(
        e.message,
        isNetworkError: e.isNetworkError,
        statusCode: e.statusCode,
      );
    }
  }
}

class HttpAppointmentsRepository implements AppointmentsRepository {
  HttpAppointmentsRepository(this._client);
  final ApiClient _client;

  @override
  Future<Appointment> create({
    required String staffId,
    required String serviceId,
    required String startsAtIso,
    required String paymentMethod,
    String? notes,
  }) async {
    final body = <String, dynamic>{
      'staffId': staffId,
      'serviceId': serviceId,
      'startsAt': startsAtIso,
      'paymentMethod': paymentMethod,
      if (notes != null && notes.isNotEmpty) 'notes': notes,
    };
    try {
      return await _client.postJson<Appointment>(
        '/v1/appointments',
        body: body,
        parse: Appointment.fromJson,
      );
    } on FormatException catch (e) {
      throw AppointmentCreateFailure(
        kind: AppointmentCreateFailureKind.malformedResponse,
        message: 'Appointment response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw AppointmentCreateFailure.fromApi(e);
    }
  }
}

// ---------------------------------------------------------------------------
// Failure types
// ---------------------------------------------------------------------------

class SlotsLoadFailure implements Exception {
  SlotsLoadFailure(
    this.message, {
    this.isNetworkError = false,
    this.statusCode,
  });
  final String message;
  final bool isNetworkError;
  final int? statusCode;
  @override
  String toString() => 'SlotsLoadFailure: $message';
}

/// Classification the booking-flow UI switches on.
enum AppointmentCreateFailureKind {
  slotUnavailable,
  unauthenticated,
  validation,
  network,
  malformedResponse,
  serverError,
  other,
}

class AppointmentCreateFailure implements Exception {
  AppointmentCreateFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final AppointmentCreateFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  factory AppointmentCreateFailure.fromApi(ApiException e) {
    final code = e.apiErrorCode;
    final status = e.statusCode;
    AppointmentCreateFailureKind k;
    if (e.isNetworkError) {
      k = AppointmentCreateFailureKind.network;
    } else if (code == 'SLOT_UNAVAILABLE') {
      k = AppointmentCreateFailureKind.slotUnavailable;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = AppointmentCreateFailureKind.unauthenticated;
    } else if (code == 'VALIDATION_ERROR') {
      k = AppointmentCreateFailureKind.validation;
    } else if (status != null && status >= 500) {
      k = AppointmentCreateFailureKind.serverError;
    } else {
      k = AppointmentCreateFailureKind.other;
    }
    return AppointmentCreateFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'AppointmentCreateFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}
