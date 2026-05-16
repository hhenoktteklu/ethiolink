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
import '../../browse/models/review.dart';
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

  /// `POST /v1/appointments/{id}/cancel`. Throws
  /// `AppointmentActionFailure` keyed on the documented error
  /// classes so the customer-side UI can render the cutoff
  /// conflict precisely.
  Future<Appointment> cancel({
    required String appointmentId,
    String? reason,
  });

  /// `POST /v1/appointments/{id}/review`. Returns the created
  /// review. Throws `AppointmentActionFailure` on every non-2xx
  /// (duplicate review → 409 CONFLICT; non-COMPLETED → 409
  /// CONFLICT).
  Future<Review> review({
    required String appointmentId,
    required int rating,
    String? comment,
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

  @override
  Future<Appointment> cancel({
    required String appointmentId,
    String? reason,
  }) async {
    final body = <String, dynamic>{
      if (reason != null && reason.isNotEmpty) 'reason': reason,
    };
    try {
      return await _client.postJson<Appointment>(
        '/v1/appointments/$appointmentId/cancel',
        body: body,
        parse: Appointment.fromJson,
      );
    } on FormatException catch (e) {
      throw AppointmentActionFailure(
        kind: AppointmentActionFailureKind.malformedResponse,
        message: 'Cancel response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw AppointmentActionFailure.fromApi(e, defaultAction: 'cancel');
    }
  }

  @override
  Future<Review> review({
    required String appointmentId,
    required int rating,
    String? comment,
  }) async {
    final body = <String, dynamic>{
      'rating': rating,
      if (comment != null && comment.isNotEmpty) 'comment': comment,
    };
    try {
      return await _client.postJson<Review>(
        '/v1/appointments/$appointmentId/review',
        body: body,
        parse: Review.fromJson,
      );
    } on FormatException catch (e) {
      throw AppointmentActionFailure(
        kind: AppointmentActionFailureKind.malformedResponse,
        message: 'Review response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw AppointmentActionFailure.fromApi(e, defaultAction: 'review');
    }
  }
}

// ---------------------------------------------------------------------------
// Appointment history
// ---------------------------------------------------------------------------

abstract class AppointmentHistoryRepository {
  /// `GET /v1/me/appointments`. The MVP listing is unpaginated;
  /// the API returns every customer-side booking. Future page
  /// support lands behind the same call site.
  Future<List<Appointment>> listMine();
}

class HttpAppointmentHistoryRepository
    implements AppointmentHistoryRepository {
  HttpAppointmentHistoryRepository(this._client);
  final ApiClient _client;

  @override
  Future<List<Appointment>> listMine() async {
    try {
      return await _client.getJson<List<Appointment>>(
        '/v1/me/appointments',
        parse: Appointment.listFromJson,
      );
    } on FormatException catch (e) {
      throw AppointmentHistoryLoadFailure(
        'Appointments response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw AppointmentHistoryLoadFailure(
        e.message,
        isNetworkError: e.isNetworkError,
        statusCode: e.statusCode,
        apiErrorCode: e.apiErrorCode,
      );
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

class AppointmentHistoryLoadFailure implements Exception {
  AppointmentHistoryLoadFailure(
    this.message, {
    this.isNetworkError = false,
    this.statusCode,
    this.apiErrorCode,
  });
  final String message;
  final bool isNetworkError;
  final int? statusCode;
  final String? apiErrorCode;
  @override
  String toString() => 'AppointmentHistoryLoadFailure: $message';
}

/// Failure classification for the lifecycle actions
/// (`cancel`, `review`). Distinct from `AppointmentCreateFailure`
/// — the `conflict` case here covers both the
/// cancellation-cutoff and the duplicate-review paths, which the
/// UI surfaces with action-specific copy.
enum AppointmentActionFailureKind {
  conflict,
  unauthenticated,
  forbidden,
  notFound,
  validation,
  network,
  serverError,
  malformedResponse,
  other,
}

class AppointmentActionFailure implements Exception {
  AppointmentActionFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
    this.action,
  });

  final AppointmentActionFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;
  /// Free-form label used in fallback copy ('cancel' / 'review').
  final String? action;

  factory AppointmentActionFailure.fromApi(
    ApiException e, {
    String? defaultAction,
  }) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    AppointmentActionFailureKind k;
    if (e.isNetworkError) {
      k = AppointmentActionFailureKind.network;
    } else if (status == 409 || code == 'CONFLICT') {
      k = AppointmentActionFailureKind.conflict;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = AppointmentActionFailureKind.unauthenticated;
    } else if (status == 403 || code == 'FORBIDDEN') {
      k = AppointmentActionFailureKind.forbidden;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = AppointmentActionFailureKind.notFound;
    } else if (code == 'VALIDATION_ERROR') {
      k = AppointmentActionFailureKind.validation;
    } else if (status != null && status >= 500) {
      k = AppointmentActionFailureKind.serverError;
    } else {
      k = AppointmentActionFailureKind.other;
    }
    return AppointmentActionFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
      action: defaultAction,
    );
  }

  @override
  String toString() =>
      'AppointmentActionFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
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
