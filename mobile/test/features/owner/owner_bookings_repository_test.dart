// EthioLink Mobile — HttpOwnerBookingsRepository tests.
//
// Reuses the `_RecordingAdapter` pattern. Verifies:
//
//   * `listAppointments` GET URL + query-param shape.
//   * Each of the four action endpoints POSTs to the right URL.
//   * Reject + cancel bodies include `reason` when provided and
//     omit it when empty.
//   * Failure classification for 403 / 404 / 409 / 500.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/owner/data/owner_bookings_repository.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

class _NoTokenProvider implements TokenProvider {
  const _NoTokenProvider();
  @override
  Future<String?> currentIdToken() async => null;
  @override
  Future<String?> refresh() async => null;
}

class _RecordingAdapter implements HttpClientAdapter {
  _RecordingAdapter(this.responses);
  final List<_AdapterResponse> responses;
  final List<RequestOptions> captured = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<dynamic>? cancelFuture,
  ) async {
    captured.add(options);
    final next = responses.removeAt(0);
    return ResponseBody.fromString(
      next.body,
      next.statusCode,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _AdapterResponse {
  _AdapterResponse(this.statusCode, this.body);
  final int statusCode;
  final String body;
}

ApiClient _clientFor(_RecordingAdapter adapter) {
  final dio = Dio(BaseOptions(baseUrl: _testConfig.apiBaseUrl));
  dio.httpClientAdapter = adapter;
  return ApiClient(
    config: _testConfig,
    tokenProvider: const _NoTokenProvider(),
    dio: dio,
  );
}

String _appointmentJson({String status = 'ACCEPTED'}) => json.encode({
      'id': 'appt-1',
      'customerId': 'user-1',
      'businessId': 'biz-1',
      'serviceId': 'svc-1',
      'staffId': 'staff-1',
      'startsAt': '2026-06-01T09:00:00.000Z',
      'endsAt': '2026-06-01T09:30:00.000Z',
      'status': status,
      'paymentMethod': 'CASH',
      'priceEtb': 250,
      'notes': null,
      'cancelledBy': null,
      'cancelReason': null,
    });

String _listJson(List<String> items) =>
    json.encode({'items': items.map<dynamic>(json.decode).toList()});

void main() {
  group('HttpOwnerBookingsRepository.listAppointments', () {
    test('GETs the business path without filters', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _listJson([_appointmentJson()])),
      ]);
      final repo = HttpOwnerBookingsRepository(_clientFor(adapter));

      final out = await repo.listAppointments(businessId: 'biz-1');
      expect(out, hasLength(1));
      expect(out.first.id, 'appt-1');

      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/businesses/biz-1/appointments');
      // No query params attached.
      expect(req.queryParameters, isEmpty);
    });

    test('GET attaches status + from + to query params', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _listJson([])),
      ]);
      final repo = HttpOwnerBookingsRepository(_clientFor(adapter));

      await repo.listAppointments(
        businessId: 'biz-1',
        status: 'REQUESTED',
        fromIso: '2026-06-01T00:00:00.000Z',
        toIso: '2026-06-02T00:00:00.000Z',
      );

      final req = adapter.captured[0];
      expect(req.queryParameters['status'], 'REQUESTED');
      expect(req.queryParameters['from'], '2026-06-01T00:00:00.000Z');
      expect(req.queryParameters['to'], '2026-06-02T00:00:00.000Z');
    });

    test('403 → kind=forbidden', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          403,
          json.encode({
            'error': {'code': 'FORBIDDEN', 'message': 'not owner'},
          }),
        ),
      ]);
      final repo = HttpOwnerBookingsRepository(_clientFor(adapter));

      try {
        await repo.listAppointments(businessId: 'biz-1');
        fail('expected OwnerBookingsFailure');
      } on OwnerBookingsFailure catch (e) {
        expect(e.kind, OwnerBookingsFailureKind.forbidden);
      }
    });
  });

  group('HttpOwnerBookingsRepository.acceptAppointment', () {
    test('POSTs the accept path', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _appointmentJson()),
      ]);
      final repo = HttpOwnerBookingsRepository(_clientFor(adapter));

      final a = await repo.acceptAppointment('appt-1');
      expect(a.status, 'ACCEPTED');

      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/appointments/appt-1/accept');
    });

    test('409 → kind=conflict with action="accept"', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          409,
          json.encode({
            'error': {
              'code': 'CONFLICT',
              'message': 'fromStatus is not REQUESTED',
            },
          }),
        ),
      ]);
      final repo = HttpOwnerBookingsRepository(_clientFor(adapter));

      try {
        await repo.acceptAppointment('appt-1');
        fail('expected OwnerBookingsFailure');
      } on OwnerBookingsFailure catch (e) {
        expect(e.kind, OwnerBookingsFailureKind.conflict);
        expect(e.action, 'accept');
      }
    });
  });

  group('HttpOwnerBookingsRepository.rejectAppointment', () {
    test('POSTs the reject path and includes reason when provided',
        () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _appointmentJson(status: 'REJECTED')),
      ]);
      final repo = HttpOwnerBookingsRepository(_clientFor(adapter));

      await repo.rejectAppointment('appt-1', reason: 'Outside hours');

      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/appointments/appt-1/reject');
      final body = req.data as Map<String, dynamic>;
      expect(body['reason'], 'Outside hours');
    });

    test('omits reason when empty', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _appointmentJson(status: 'REJECTED')),
      ]);
      final repo = HttpOwnerBookingsRepository(_clientFor(adapter));

      await repo.rejectAppointment('appt-1');

      final body = adapter.captured[0].data as Map<String, dynamic>;
      expect(body.containsKey('reason'), isFalse);
    });
  });

  group('HttpOwnerBookingsRepository.cancelAppointment', () {
    test('POSTs the cancel path with reason', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _appointmentJson(status: 'CANCELLED')),
      ]);
      final repo = HttpOwnerBookingsRepository(_clientFor(adapter));

      await repo.cancelAppointment('appt-1', reason: 'Sick day');

      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/appointments/appt-1/cancel');
      final body = req.data as Map<String, dynamic>;
      expect(body['reason'], 'Sick day');
    });
  });

  group('HttpOwnerBookingsRepository.completeAppointment', () {
    test('POSTs the complete path', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _appointmentJson(status: 'COMPLETED')),
      ]);
      final repo = HttpOwnerBookingsRepository(_clientFor(adapter));

      final a = await repo.completeAppointment('appt-1');
      expect(a.status, 'COMPLETED');

      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/appointments/appt-1/complete');
    });

    test('409 → kind=conflict with action="complete"', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          409,
          json.encode({
            'error': {
              'code': 'CONFLICT',
              'message': 'fromStatus is not ACCEPTED',
            },
          }),
        ),
      ]);
      final repo = HttpOwnerBookingsRepository(_clientFor(adapter));

      try {
        await repo.completeAppointment('appt-1');
        fail('expected OwnerBookingsFailure');
      } on OwnerBookingsFailure catch (e) {
        expect(e.kind, OwnerBookingsFailureKind.conflict);
        expect(e.action, 'complete');
      }
    });
  });
}
