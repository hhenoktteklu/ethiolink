// EthioLink Mobile — appointment history model + repository tests.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/booking/data/booking_repositories.dart';
import 'package:ethiolink/features/booking/models/appointment.dart';

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
      headers: {Headers.contentTypeHeader: ['application/json']},
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

Map<String, dynamic> _aptJson({
  String id = 'apt-1',
  String status = 'ACCEPTED',
  String startsAt = '2030-01-01T09:00:00.000Z',
  String? cancelledBy,
  String? cancelReason,
}) {
  return <String, dynamic>{
    'id': id,
    'customerId': 'cust',
    'businessId': 'biz',
    'serviceId': 'srv',
    'staffId': 'stf',
    'startsAt': startsAt,
    'endsAt': '2030-01-01T09:30:00.000Z',
    'status': status,
    'paymentMethod': 'CASH',
    'priceEtb': 300,
    'createdAt': '2026-05-14T00:00:00.000Z',
    'updatedAt': '2026-05-14T00:00:00.000Z',
    if (cancelledBy != null) 'cancelledBy': cancelledBy,
    if (cancelReason != null) 'cancelReason': cancelReason,
  };
}

void main() {
  group('Appointment.listFromJson', () {
    test('parses the AppointmentList envelope', () {
      final list = Appointment.listFromJson(<String, dynamic>{
        'items': [
          _aptJson(id: 'a', status: 'REQUESTED'),
          _aptJson(id: 'b', status: 'COMPLETED'),
        ],
      });
      expect(list, hasLength(2));
      expect(list[0].id, 'a');
      expect(list[0].isUpcoming, isTrue);
      expect(list[1].isReviewable, isTrue);
    });

    test('returns empty list when items is empty', () {
      final list = Appointment.listFromJson(<String, dynamic>{
        'items': <dynamic>[],
      });
      expect(list, isEmpty);
    });

    test('throws when items is missing', () {
      expect(
        () => Appointment.listFromJson(<String, dynamic>{}),
        throwsFormatException,
      );
    });

    test('captures cancelledBy + cancelReason when present', () {
      final list = Appointment.listFromJson(<String, dynamic>{
        'items': [
          _aptJson(
            status: 'CANCELLED',
            cancelledBy: 'CUSTOMER',
            cancelReason: 'Plans changed',
          ),
        ],
      });
      expect(list[0].cancelledBy, 'CUSTOMER');
      expect(list[0].cancelReason, 'Plans changed');
    });
  });

  group('Appointment classification getters', () {
    test('isUpcoming requires future startsAt + REQUESTED/ACCEPTED', () {
      final past = Appointment.fromJson(
        _aptJson(status: 'ACCEPTED', startsAt: '2020-01-01T00:00:00.000Z'),
      );
      final future = Appointment.fromJson(
        _aptJson(status: 'REQUESTED', startsAt: '2030-01-01T09:00:00.000Z'),
      );
      final completed = Appointment.fromJson(
        _aptJson(status: 'COMPLETED', startsAt: '2030-01-01T09:00:00.000Z'),
      );
      expect(past.isUpcoming, isFalse);
      expect(future.isUpcoming, isTrue);
      expect(completed.isUpcoming, isFalse);
    });

    test('isCancellable / isReviewable map to the documented statuses', () {
      Appointment build(String status) =>
          Appointment.fromJson(_aptJson(status: status));
      expect(build('REQUESTED').isCancellable, isTrue);
      expect(build('ACCEPTED').isCancellable, isTrue);
      expect(build('COMPLETED').isCancellable, isFalse);
      expect(build('COMPLETED').isReviewable, isTrue);
      expect(build('CANCELLED').isReviewable, isFalse);
    });
  });

  group('HttpAppointmentHistoryRepository.listMine', () {
    test('GETs /v1/me/appointments', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode({'items': [_aptJson()]}),
        ),
      ]);
      final repo = HttpAppointmentHistoryRepository(_clientFor(adapter));

      final list = await repo.listMine();
      expect(list, hasLength(1));
      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/me/appointments');
    });

    test('translates a 401 into AppointmentHistoryLoadFailure', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          401,
          json.encode({
            'error': {'code': 'UNAUTHENTICATED', 'message': 'missing'},
          }),
        ),
      ]);
      final repo = HttpAppointmentHistoryRepository(_clientFor(adapter));

      try {
        await repo.listMine();
        fail('expected AppointmentHistoryLoadFailure');
      } on AppointmentHistoryLoadFailure catch (e) {
        expect(e.statusCode, 401);
        expect(e.apiErrorCode, 'UNAUTHENTICATED');
      }
    });
  });

  group('HttpAppointmentsRepository.cancel — error classification', () {
    test('409 → kind=conflict', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          409,
          json.encode({
            'error': {
              'code': 'CONFLICT',
              'message': 'Past the cancellation cutoff.',
            },
          }),
        ),
      ]);
      final repo = HttpAppointmentsRepository(_clientFor(adapter));

      try {
        await repo.cancel(appointmentId: 'apt-1');
        fail('expected AppointmentActionFailure');
      } on AppointmentActionFailure catch (e) {
        expect(e.kind, AppointmentActionFailureKind.conflict);
        expect(e.statusCode, 409);
      }
    });

    test('200 → returns the updated Appointment', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode(_aptJson(
            status: 'CANCELLED',
            cancelledBy: 'CUSTOMER',
            cancelReason: 'Plans changed',
          )),
        ),
      ]);
      final repo = HttpAppointmentsRepository(_clientFor(adapter));

      final updated = await repo.cancel(
        appointmentId: 'apt-1',
        reason: 'Plans changed',
      );
      expect(updated.status, 'CANCELLED');
      expect(updated.cancelledBy, 'CUSTOMER');
      expect(updated.cancelReason, 'Plans changed');
    });
  });
}
