// EthioLink Mobile — HttpAvailabilityRepository tests.
//
// `_RecordingAdapter` pattern. Verifies:
//
//   * `getSchedule` → GET /v1/businesses/{id}/staff/{sid}/availability
//   * `replaceWeekly` → PUT to the same path with the `{ days: [...] }`
//     body shape (7 weekdays, each appearing once).
//   * `addOverride` → POST /v1/.../availability/override with the
//     `{ specificDate, startTime, endTime, isClosed }` body and a
//     `AvailabilityWindow` response.
//   * Error classification for 400/403/404.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/owner/data/availability_repository.dart';
import 'package:ethiolink/features/owner/models/availability.dart';

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

String _emptyScheduleJson() => json.encode({
      'weekly': <dynamic>[],
      'overrides': <dynamic>[],
    });

String _windowJson({
  String id = 'win-1',
  String kind = 'OVERRIDE',
  String? date = '2026-12-25',
  bool closed = true,
}) =>
    json.encode({
      'id': id,
      'kind': kind,
      'weekday': null,
      'specificDate': date,
      'startTime': '00:00:00',
      'endTime': '23:59:00',
      'isClosed': closed,
    });

void main() {
  group('HttpAvailabilityRepository.getSchedule', () {
    test('GETs the availability path and decodes the envelope', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _emptyScheduleJson()),
      ]);
      final repo = HttpAvailabilityRepository(_clientFor(adapter));

      final s = await repo.getSchedule('biz-1', 'staff-1');
      expect(s.weekly, isEmpty);
      expect(s.overrides, isEmpty);

      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/businesses/biz-1/staff/staff-1/availability');
    });

    test('404 → kind=notFound', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          404,
          json.encode({
            'error': {'code': 'NOT_FOUND', 'message': 'no staff'},
          }),
        ),
      ]);
      final repo = HttpAvailabilityRepository(_clientFor(adapter));

      try {
        await repo.getSchedule('biz-1', 'staff-1');
        fail('expected AvailabilityFailure');
      } on AvailabilityFailure catch (e) {
        expect(e.kind, AvailabilityFailureKind.notFound);
      }
    });
  });

  group('HttpAvailabilityRepository.replaceWeekly', () {
    test('PUTs the path with the {days: [...]} body shape', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _emptyScheduleJson()),
      ]);
      final repo = HttpAvailabilityRepository(_clientFor(adapter));

      final days = <WeeklyDayInput>[
        for (var d = 0; d < 7; d++)
          WeeklyDayInput(
            weekday: d,
            windows: d == 1
                ? const [
                    WeeklyWindowInput(
                      startTime: '09:00',
                      endTime: '17:00',
                    ),
                  ]
                : const <WeeklyWindowInput>[],
          ),
      ];
      await repo.replaceWeekly('biz-1', 'staff-1', days);

      final req = adapter.captured[0];
      expect(req.method, 'PUT');
      expect(req.path, '/v1/businesses/biz-1/staff/staff-1/availability');
      final body = req.data as Map<String, dynamic>;
      final daysOut = body['days'] as List<dynamic>;
      expect(daysOut, hasLength(7));
      expect(daysOut[1], {
        'weekday': 1,
        'windows': [
          {'startTime': '09:00', 'endTime': '17:00'},
        ],
      });
      expect(daysOut[0], {'weekday': 0, 'windows': <dynamic>[]});
    });

    test('400 → kind=validation', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          400,
          json.encode({
            'error': {'code': 'VALIDATION_ERROR', 'message': 'bad'},
          }),
        ),
      ]);
      final repo = HttpAvailabilityRepository(_clientFor(adapter));

      try {
        await repo.replaceWeekly(
          'biz-1',
          'staff-1',
          [
            for (var d = 0; d < 7; d++)
              WeeklyDayInput(weekday: d, windows: const []),
          ],
        );
        fail('expected AvailabilityFailure');
      } on AvailabilityFailure catch (e) {
        expect(e.kind, AvailabilityFailureKind.validation);
      }
    });

    test('403 → kind=forbidden', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          403,
          json.encode({
            'error': {'code': 'FORBIDDEN', 'message': 'drift'},
          }),
        ),
      ]);
      final repo = HttpAvailabilityRepository(_clientFor(adapter));

      try {
        await repo.replaceWeekly(
          'biz-1',
          'staff-1',
          [
            for (var d = 0; d < 7; d++)
              WeeklyDayInput(weekday: d, windows: const []),
          ],
        );
        fail('expected AvailabilityFailure');
      } on AvailabilityFailure catch (e) {
        expect(e.kind, AvailabilityFailureKind.forbidden);
      }
    });
  });

  group('HttpAvailabilityRepository.addOverride', () {
    test('POSTs the override path with the request body', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _windowJson()),
      ]);
      final repo = HttpAvailabilityRepository(_clientFor(adapter));

      final w = await repo.addOverride(
        'biz-1',
        'staff-1',
        const AvailabilityOverrideRequest(
          specificDate: '2026-12-25',
          startTime: '00:00',
          endTime: '23:59',
          isClosed: true,
        ),
      );
      expect(w.kind, 'OVERRIDE');
      expect(w.isClosed, isTrue);

      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(
        req.path,
        '/v1/businesses/biz-1/staff/staff-1/availability/override',
      );
      final body = req.data as Map<String, dynamic>;
      expect(body['specificDate'], '2026-12-25');
      expect(body['startTime'], '00:00');
      expect(body['endTime'], '23:59');
      expect(body['isClosed'], isTrue);
    });
  });
}
