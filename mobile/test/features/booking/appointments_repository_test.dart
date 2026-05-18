// EthioLink Mobile — HttpAppointmentsRepository tests.
//
// Uses the same `_RecordingAdapter` pattern as the businesses
// repo tests — captures the request body so we can assert on the
// `CreateAppointmentRequest` shape Dio serialised.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/booking/data/booking_repositories.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
);

class _StaticTokenProvider implements TokenProvider {
  const _StaticTokenProvider(this.token);
  final String? token;
  @override
  Future<String?> currentIdToken() async => token;
  @override
  Future<String?> refresh() async => null;
}

class _RecordingAdapter implements HttpClientAdapter {
  _RecordingAdapter(this.responses);
  final List<_AdapterResponse> responses;
  final List<RequestOptions> captured = <RequestOptions>[];
  final List<String> capturedBodies = <String>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<dynamic>? cancelFuture,
  ) async {
    captured.add(options);
    // Capture the request body (Dio has already serialised it
    // into `options.data` for non-streaming requests).
    capturedBodies.add(json.encode(options.data));
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

ApiClient _clientFor(_RecordingAdapter adapter, {String? token}) {
  final dio = Dio(BaseOptions(baseUrl: _testConfig.apiBaseUrl));
  dio.httpClientAdapter = adapter;
  return ApiClient(
    config: _testConfig,
    tokenProvider: _StaticTokenProvider(token),
    dio: dio,
  );
}

/// Phase 10 — the wrapped `CreateAppointmentResponse` shape. Cash
/// bookings ship `payment.redirectUrl: null` and `status:
/// SUCCEEDED`.
const _validResponse = '''
{
  "appointment": {
    "id": "apt-1",
    "customerId": "cust-1",
    "businessId": "biz-1",
    "serviceId": "srv-1",
    "staffId": "stf-1",
    "startsAt": "2026-05-15T09:30:00.000Z",
    "endsAt": "2026-05-15T10:00:00.000Z",
    "status": "REQUESTED",
    "paymentMethod": "CASH",
    "priceEtb": 300,
    "createdAt": "2026-05-14T00:00:00.000Z",
    "updatedAt": "2026-05-14T00:00:00.000Z"
  },
  "payment": {
    "status": "SUCCEEDED",
    "provider": "CASH",
    "providerRef": null,
    "redirectUrl": null,
    "errorCode": null,
    "errorMessage": null
  }
}
''';

/// Phase 10 — Chapa PENDING wrapper response.
const _pendingChapaResponse = '''
{
  "appointment": {
    "id": "apt-1",
    "customerId": "cust-1",
    "businessId": "biz-1",
    "serviceId": "srv-1",
    "staffId": "stf-1",
    "startsAt": "2026-05-15T09:30:00.000Z",
    "endsAt": "2026-05-15T10:00:00.000Z",
    "status": "REQUESTED",
    "paymentMethod": "ONLINE_PENDING",
    "priceEtb": 300,
    "createdAt": "2026-05-14T00:00:00.000Z",
    "updatedAt": "2026-05-14T00:00:00.000Z"
  },
  "payment": {
    "status": "PENDING",
    "provider": "CHAPA",
    "providerRef": "apt-1-aaaaaaaa",
    "redirectUrl": "https://checkout.chapa.test/sess-001",
    "errorCode": null,
    "errorMessage": null
  }
}
''';

void main() {
  group('HttpAppointmentsRepository.create — request shape', () {
    test('POSTs the documented CreateAppointmentRequest body', () async {
      final adapter = _RecordingAdapter([_AdapterResponse(200, _validResponse)]);
      final repo = HttpAppointmentsRepository(
        _clientFor(adapter, token: 'fake-token'),
      );

      final apt = await repo.create(
        staffId: 'stf-1',
        serviceId: 'srv-1',
        startsAtIso: '2026-05-15T09:30:00.000Z',
        paymentMethod: 'CASH',
      );

      expect(adapter.captured, hasLength(1));
      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/appointments');
      // Authorization attached by the interceptor.
      // Bare ID token — no `Bearer ` prefix. The backend API
      // Gateway REST COGNITO_USER_POOLS authorizer validates the
      // raw Authorization-header value as a JWT; a `Bearer eyJ…`
      // value fails to parse and is rejected with 401 before the
      // Lambda runs. See `api_client.dart`'s header rationale.
      expect(req.headers['Authorization'], 'fake-token');
      // Body shape.
      final body = json.decode(adapter.capturedBodies[0]) as Map<String, dynamic>;
      expect(body['staffId'], 'stf-1');
      expect(body['serviceId'], 'srv-1');
      expect(body['startsAt'], '2026-05-15T09:30:00.000Z');
      expect(body['paymentMethod'], 'CASH');
      expect(body.containsKey('notes'), isFalse);
      // Phase 10 — response decoded into the wrapper shape.
      expect(apt.appointment.id, 'apt-1');
      expect(apt.appointment.status, 'REQUESTED');
      expect(apt.payment.status, 'SUCCEEDED');
      expect(apt.payment.provider, 'CASH');
      expect(apt.payment.redirectUrl, isNull);
    });

    test(
      'Phase 10 — Chapa PENDING response surfaces redirectUrl + providerRef',
      () async {
        final adapter = _RecordingAdapter([
          _AdapterResponse(200, _pendingChapaResponse),
        ]);
        final repo = HttpAppointmentsRepository(_clientFor(adapter));

        final result = await repo.create(
          staffId: 'stf-1',
          serviceId: 'srv-1',
          startsAtIso: '2026-05-15T09:30:00.000Z',
          paymentMethod: 'ONLINE_PENDING',
        );
        expect(result.payment.status, 'PENDING');
        expect(result.payment.provider, 'CHAPA');
        expect(result.payment.providerRef, 'apt-1-aaaaaaaa');
        expect(
          result.payment.redirectUrl,
          'https://checkout.chapa.test/sess-001',
        );
        expect(result.payment.isPending, isTrue);
      },
    );

    test('includes notes when provided', () async {
      final adapter = _RecordingAdapter([_AdapterResponse(200, _validResponse)]);
      final repo = HttpAppointmentsRepository(_clientFor(adapter));

      await repo.create(
        staffId: 'stf-1',
        serviceId: 'srv-1',
        startsAtIso: '2026-05-15T09:30:00.000Z',
        paymentMethod: 'CASH',
        notes: 'Window seat please.',
      );

      final body =
          json.decode(adapter.capturedBodies[0]) as Map<String, dynamic>;
      expect(body['notes'], 'Window seat please.');
    });
  });

  group('HttpAppointmentsRepository.create — error classification', () {
    test('409 SLOT_UNAVAILABLE → kind=slotUnavailable', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          409,
          json.encode({
            'error': {
              'code': 'SLOT_UNAVAILABLE',
              'message': 'Slot just got taken.',
            }
          }),
        ),
      ]);
      final repo = HttpAppointmentsRepository(_clientFor(adapter));

      try {
        await repo.create(
          staffId: 's',
          serviceId: 'r',
          startsAtIso: '2026-05-15T09:30:00.000Z',
          paymentMethod: 'CASH',
        );
        fail('expected AppointmentCreateFailure');
      } on AppointmentCreateFailure catch (e) {
        expect(e.kind, AppointmentCreateFailureKind.slotUnavailable);
        expect(e.apiErrorCode, 'SLOT_UNAVAILABLE');
        expect(e.statusCode, 409);
      }
    });

    test('401 → kind=unauthenticated', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          401,
          json.encode({
            'error': {
              'code': 'UNAUTHENTICATED',
              'message': 'Missing token.',
            }
          }),
        ),
      ]);
      final repo = HttpAppointmentsRepository(_clientFor(adapter));

      try {
        await repo.create(
          staffId: 's',
          serviceId: 'r',
          startsAtIso: '2026-05-15T09:30:00.000Z',
          paymentMethod: 'CASH',
        );
        fail('expected AppointmentCreateFailure');
      } on AppointmentCreateFailure catch (e) {
        expect(e.kind, AppointmentCreateFailureKind.unauthenticated);
      }
    });

    test('500 → kind=serverError', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          500,
          json.encode({
            'error': {
              'code': 'INTERNAL_ERROR',
              'message': 'boom',
            }
          }),
        ),
      ]);
      final repo = HttpAppointmentsRepository(_clientFor(adapter));

      try {
        await repo.create(
          staffId: 's',
          serviceId: 'r',
          startsAtIso: '2026-05-15T09:30:00.000Z',
          paymentMethod: 'CASH',
        );
        fail('expected AppointmentCreateFailure');
      } on AppointmentCreateFailure catch (e) {
        expect(e.kind, AppointmentCreateFailureKind.serverError);
      }
    });
  });
}
