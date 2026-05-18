// EthioLink Mobile — HttpFeaturingRepository tests.
//
// Reuses the `_RecordingAdapter` pattern. Covers:
//
//   * `listPackages` GETs `/v1/businesses/{id}/featuring/packages`
//     and decodes the `{items:[...]}` envelope into
//     `List<FeaturingPackage>`.
//   * `subscribe` POSTs to the subscribe path with
//     `{packageCode}` and decodes the `FeaturingSubscription`.
//   * `getActive` GETs the active path and decodes nullable
//     subscription from `{active: ... | null}`.
//   * `listHistory` GETs the history path with optional `limit`.
//   * Error classification for FEATURING_DISABLED / 503 /
//     401 / 402 / 403 / 404 / 409 / 400 / 500 / network.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/owner/data/featuring_repository.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
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

String _packageJson({
  String code = 'FEATURING_7D',
  int duration = 7,
  num price = 500,
}) =>
    json.encode({
      'code': code,
      'durationDays': duration,
      'priceEtb': price,
    });

String _subscriptionJson({
  String id = 'sub-1',
  String status = 'ACTIVE',
  String source = 'OWNER_PURCHASE',
  String? cancelledReason,
}) =>
    json.encode({
      'id': id,
      'businessId': 'biz-1',
      'packageCode': 'FEATURING_7D',
      'priceEtb': 500.0,
      'startsAt': '2026-05-15T00:00:00.000Z',
      'endsAt': '2026-05-22T00:00:00.000Z',
      'status': status,
      'source': source,
      'cancelledAt': null,
      'cancelledReason': cancelledReason,
      'createdAt': '2026-05-15T00:00:00.000Z',
      'updatedAt': '2026-05-15T00:00:00.000Z',
    });

void main() {
  group('HttpFeaturingRepository.listPackages', () {
    test('GETs /v1/businesses/{id}/featuring/packages and decodes',
        () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode({
            'items': [
              json.decode(_packageJson()),
              json.decode(_packageJson(
                  code: 'FEATURING_30D', duration: 30, price: 1500)),
            ],
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      final pkgs = await repo.listPackages('biz-1');
      expect(pkgs, hasLength(2));
      expect(pkgs[0].code, 'FEATURING_7D');
      expect(pkgs[0].durationDays, 7);
      expect(pkgs[0].priceEtb, 500);
      expect(pkgs[1].code, 'FEATURING_30D');
      expect(pkgs[1].durationDays, 30);
      expect(pkgs[1].priceEtb, 1500);

      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/businesses/biz-1/featuring/packages');
    });

    test('503 FEATURING_DISABLED → kind=disabled', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          503,
          json.encode({
            'error': {
              'code': 'FEATURING_DISABLED',
              'message': 'featuring not enabled in env',
            },
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      try {
        await repo.listPackages('biz-1');
        fail('expected FeaturingFailure');
      } on FeaturingFailure catch (e) {
        expect(e.kind, FeaturingFailureKind.disabled);
        expect(e.apiErrorCode, 'FEATURING_DISABLED');
        expect(e.statusCode, 503);
      }
    });

    test('503 ONLINE_PAYMENTS_UNAVAILABLE → kind=unavailable', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          503,
          json.encode({
            'error': {
              'code': 'ONLINE_PAYMENTS_UNAVAILABLE',
              'message': 'gateway down',
            },
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      try {
        await repo.listPackages('biz-1');
        fail('expected FeaturingFailure');
      } on FeaturingFailure catch (e) {
        expect(e.kind, FeaturingFailureKind.unavailable);
      }
    });
  });

  group('HttpFeaturingRepository.subscribe', () {
    test('POSTs the subscribe path with {packageCode} and decodes',
        () async {
      // Phase 10 — the wire shape is now wrapped:
      // `{ subscription, payment }`. Cash settlement ships
      // payment.redirectUrl = null + status SUCCEEDED.
      final wrappedJson = json.encode({
        'subscription': json.decode(_subscriptionJson()),
        'payment': {
          'status': 'SUCCEEDED',
          'provider': 'CASH',
          'providerRef': null,
          'redirectUrl': null,
          'errorCode': null,
          'errorMessage': null,
        },
      });
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, wrappedJson),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      final result = await repo.subscribe('biz-1', 'FEATURING_7D');
      expect(result.subscription.id, 'sub-1');
      expect(result.subscription.isActive, isTrue);
      expect(result.payment.isSucceeded, isTrue);
      expect(result.payment.redirectUrl, isNull);

      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/businesses/biz-1/featuring/subscribe');
      final body = req.data as Map<String, dynamic>;
      expect(body['packageCode'], 'FEATURING_7D');
    });

    test(
      'Phase 10 — Chapa PENDING response surfaces redirectUrl',
      () async {
        final wrappedJson = json.encode({
          'subscription': json.decode(
              _subscriptionJson(status: 'PENDING_PAYMENT')),
          'payment': {
            'status': 'PENDING',
            'provider': 'CHAPA',
            'providerRef': 'feat-1-aaaa',
            'redirectUrl': 'https://checkout.chapa.test/sess-001',
            'errorCode': null,
            'errorMessage': null,
          },
        });
        final adapter = _RecordingAdapter([
          _AdapterResponse(200, wrappedJson),
        ]);
        final repo = HttpFeaturingRepository(_clientFor(adapter));

        final result = await repo.subscribe('biz-1', 'FEATURING_7D');
        expect(result.payment.isPending, isTrue);
        expect(
          result.payment.redirectUrl,
          'https://checkout.chapa.test/sess-001',
        );
        expect(result.payment.providerRef, 'feat-1-aaaa');
      },
    );

    test('409 CONFLICT → kind=alreadyActive', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          409,
          json.encode({
            'error': {
              'code': 'CONFLICT',
              'message': 'already active',
            },
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      try {
        await repo.subscribe('biz-1', 'FEATURING_7D');
        fail('expected FeaturingFailure');
      } on FeaturingFailure catch (e) {
        expect(e.kind, FeaturingFailureKind.alreadyActive);
      }
    });

    test('402 PAYMENT_REQUIRED → kind=paymentRequired', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          402,
          json.encode({
            'error': {
              'code': 'PAYMENT_REQUIRED',
              'message': 'gateway returned FAILED',
            },
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      try {
        await repo.subscribe('biz-1', 'FEATURING_7D');
        fail('expected FeaturingFailure');
      } on FeaturingFailure catch (e) {
        expect(e.kind, FeaturingFailureKind.paymentRequired);
      }
    });

    test('401 → kind=unauthenticated', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          401,
          json.encode({
            'error': {
              'code': 'UNAUTHENTICATED',
              'message': 'expired',
            },
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      try {
        await repo.subscribe('biz-1', 'FEATURING_7D');
        fail('expected FeaturingFailure');
      } on FeaturingFailure catch (e) {
        expect(e.kind, FeaturingFailureKind.unauthenticated);
      }
    });

    test('403 → kind=forbidden', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          403,
          json.encode({
            'error': {
              'code': 'FORBIDDEN',
              'message': 'not owner',
            },
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      try {
        await repo.subscribe('biz-1', 'FEATURING_7D');
        fail('expected FeaturingFailure');
      } on FeaturingFailure catch (e) {
        expect(e.kind, FeaturingFailureKind.forbidden);
      }
    });

    test('400 → kind=validation', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          400,
          json.encode({
            'error': {
              'code': 'VALIDATION_ERROR',
              'message': 'bad packageCode',
            },
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      try {
        await repo.subscribe('biz-1', 'OOPS');
        fail('expected FeaturingFailure');
      } on FeaturingFailure catch (e) {
        expect(e.kind, FeaturingFailureKind.validation);
      }
    });

    test('500 → kind=network (5xx maps to network for retry)', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          500,
          json.encode({
            'error': {'code': 'INTERNAL_ERROR', 'message': 'boom'},
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      try {
        await repo.subscribe('biz-1', 'FEATURING_7D');
        fail('expected FeaturingFailure');
      } on FeaturingFailure catch (e) {
        expect(e.kind, FeaturingFailureKind.network);
      }
    });
  });

  group('HttpFeaturingRepository.getActive', () {
    test('GETs active path and decodes the subscription', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode({'active': json.decode(_subscriptionJson())}),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      final active = await repo.getActive('biz-1');
      expect(active, isNotNull);
      expect(active!.id, 'sub-1');
      expect(active.isActive, isTrue);

      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/businesses/biz-1/featuring/active');
    });

    test('null active → returns null', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, json.encode({'active': null})),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      final active = await repo.getActive('biz-1');
      expect(active, isNull);
    });

    test('404 → kind=notFound', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          404,
          json.encode({
            'error': {'code': 'NOT_FOUND', 'message': 'no biz'},
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      try {
        await repo.getActive('biz-1');
        fail('expected FeaturingFailure');
      } on FeaturingFailure catch (e) {
        expect(e.kind, FeaturingFailureKind.notFound);
      }
    });
  });

  group('HttpFeaturingRepository.listHistory', () {
    test('GETs history path and decodes the list', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode({
            'items': [
              json.decode(_subscriptionJson(status: 'EXPIRED')),
              json.decode(_subscriptionJson(
                  id: 'sub-2', source: 'ADMIN_COMP')),
            ],
          }),
        ),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      final history = await repo.listHistory('biz-1');
      expect(history, hasLength(2));
      expect(history[0].status, 'EXPIRED');
      expect(history[1].isComp, isTrue);

      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/businesses/biz-1/featuring/history');
      expect(req.queryParameters['limit'], isNull);
    });

    test('forwards limit query parameter', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, json.encode({'items': <dynamic>[]})),
      ]);
      final repo = HttpFeaturingRepository(_clientFor(adapter));

      await repo.listHistory('biz-1', limit: 25);
      expect(adapter.captured[0].queryParameters['limit'], 25);
    });
  });
}
