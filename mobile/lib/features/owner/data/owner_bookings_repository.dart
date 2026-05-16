// EthioLink Mobile — owner bookings repository.
//
// Phase 9 Track 3.5 sixth commit. Wraps the five owner-side
// appointment endpoints:
//
//   * `GET  /v1/businesses/{businessId}/appointments` — list the
//     business's appointments (optionally filtered by status +
//     date range). Authenticated; owner-of-business or ADMIN.
//   * `POST /v1/appointments/{id}/accept` — REQUESTED → ACCEPTED.
//     Refuses any other fromStatus with 409 CONFLICT.
//   * `POST /v1/appointments/{id}/reject` — REQUESTED → REJECTED.
//     Body accepts an optional `reason` (logged but not persisted
//     in MVP).
//   * `POST /v1/appointments/{id}/cancel` — Business-side cancel
//     (cutoff bypassed for business cancels). Body accepts an
//     optional `reason` that IS persisted to
//     `appointments.cancel_reason`.
//   * `POST /v1/appointments/{id}/complete` — ACCEPTED → COMPLETED.
//     Only valid from ACCEPTED; 409 otherwise.
//
// No `no-show` endpoint — the backend doesn't expose it yet. When
// it lands a follow-up commit adds the action.
//
// Failure classification mirrors the other owner-side surfaces.
// `conflict` covers the "invalid state transition" path the API
// surfaces with 409 + (often) a per-action code.

import '../../../core/api/api_client.dart';
import '../../booking/models/appointment.dart';

/// Domain port. Production: `HttpOwnerBookingsRepository`. Tests:
/// in-memory fake.
abstract class OwnerBookingsRepository {
  Future<List<Appointment>> listAppointments({
    required String businessId,
    String? status,
    String? fromIso,
    String? toIso,
  });

  Future<Appointment> acceptAppointment(String appointmentId);
  Future<Appointment> rejectAppointment(
    String appointmentId, {
    String? reason,
  });
  Future<Appointment> cancelAppointment(
    String appointmentId, {
    String? reason,
  });
  Future<Appointment> completeAppointment(String appointmentId);
}

class HttpOwnerBookingsRepository implements OwnerBookingsRepository {
  HttpOwnerBookingsRepository(this._client);
  final ApiClient _client;

  static String _listPath(String businessId) =>
      '/v1/businesses/$businessId/appointments';
  static String _actionPath(String appointmentId, String action) =>
      '/v1/appointments/$appointmentId/$action';

  @override
  Future<List<Appointment>> listAppointments({
    required String businessId,
    String? status,
    String? fromIso,
    String? toIso,
  }) async {
    final qp = <String, dynamic>{
      if (status != null && status.isNotEmpty) 'status': status,
      if (fromIso != null && fromIso.isNotEmpty) 'from': fromIso,
      if (toIso != null && toIso.isNotEmpty) 'to': toIso,
    };
    try {
      return await _client.getJson<List<Appointment>>(
        _listPath(businessId),
        queryParameters: qp.isEmpty ? null : qp,
        parse: Appointment.listFromJson,
      );
    } on FormatException catch (e) {
      throw OwnerBookingsFailure(
        kind: OwnerBookingsFailureKind.malformedResponse,
        message: 'Bookings response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw OwnerBookingsFailure.fromApi(e);
    }
  }

  Future<Appointment> _action(
    String appointmentId,
    String action, {
    Map<String, dynamic>? body,
  }) async {
    try {
      return await _client.postJson<Appointment>(
        _actionPath(appointmentId, action),
        body: body,
        parse: Appointment.fromJson,
      );
    } on FormatException catch (e) {
      throw OwnerBookingsFailure(
        kind: OwnerBookingsFailureKind.malformedResponse,
        message: '$action response was malformed: ${e.message}',
        action: action,
      );
    } on ApiException catch (e) {
      throw OwnerBookingsFailure.fromApi(e, action: action);
    }
  }

  @override
  Future<Appointment> acceptAppointment(String id) => _action(id, 'accept');

  @override
  Future<Appointment> rejectAppointment(String id, {String? reason}) {
    final body = <String, dynamic>{
      if (reason != null && reason.isNotEmpty) 'reason': reason,
    };
    // Reject's body is optional, but send an empty `{}` when no
    // reason — Dio drops `null` body to no Content-Type otherwise,
    // and the API tolerates empty objects.
    return _action(id, 'reject', body: body);
  }

  @override
  Future<Appointment> cancelAppointment(String id, {String? reason}) {
    final body = <String, dynamic>{
      if (reason != null && reason.isNotEmpty) 'reason': reason,
    };
    return _action(id, 'cancel', body: body);
  }

  @override
  Future<Appointment> completeAppointment(String id) =>
      _action(id, 'complete');
}

/// Failure classification consumed by `OwnerBookingsScreen` +
/// `OwnerAppointmentDetailScreen`. Mirrors the rest of the
/// owner-side enums.
enum OwnerBookingsFailureKind {
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

class OwnerBookingsFailure implements Exception {
  OwnerBookingsFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
    this.action,
  });

  final OwnerBookingsFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  /// Free-form label used by the UI to render action-specific
  /// copy on 409 ('accept' / 'reject' / 'cancel' / 'complete').
  final String? action;

  factory OwnerBookingsFailure.fromApi(
    ApiException e, {
    String? action,
  }) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    OwnerBookingsFailureKind k;
    if (e.isNetworkError) {
      k = OwnerBookingsFailureKind.network;
    } else if (status == 400 || code == 'VALIDATION_ERROR') {
      k = OwnerBookingsFailureKind.validation;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = OwnerBookingsFailureKind.unauthenticated;
    } else if (status == 403 || code == 'FORBIDDEN') {
      k = OwnerBookingsFailureKind.forbidden;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = OwnerBookingsFailureKind.notFound;
    } else if (status == 409 || code == 'CONFLICT') {
      k = OwnerBookingsFailureKind.conflict;
    } else if (status != null && status >= 500) {
      k = OwnerBookingsFailureKind.serverError;
    } else {
      k = OwnerBookingsFailureKind.other;
    }
    return OwnerBookingsFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
      action: action,
    );
  }

  @override
  String toString() =>
      'OwnerBookingsFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}'
      '${action != null ? "/$action" : ""}]: $message';
}
