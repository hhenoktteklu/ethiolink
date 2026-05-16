// EthioLink Mobile — HttpOwnerBusinessRepository tests.
//
// Uses the same `_RecordingAdapter` pattern as the businesses
// repo tests — captures the request shape + scripts canned
// responses so we can verify the path/method and the 404/403
// classification branches.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/owner/data/owner_business_repository.dart';

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

const _validResponse = '''
{
  "id": "biz-1",
  "categoryId": "cat-1",
  "name": "Sunset Salon",
  "description": {"en": "Best in town."},
  "city": "Addis Ababa",
  "addressLine": null,
  "latitude": null,
  "longitude": null,
  "phone": "+251911000001",
  "telegramHandle": null,
  "whatsappPhone": null,
  "featuredUntil": null,
  "ratingAvg": 4.5,
  "ratingCount": 10,
  "status": "APPROVED",
  "ownerUserId": "owner-1",
  "createdAt": "2026-05-01T00:00:00.000Z",
  "updatedAt": "2026-05-01T00:00:00.000Z"
}
''';

void main() {
  group('HttpOwnerBusinessRepository.getMine — request shape', () {
    test('GETs /v1/me/business and decodes the OwnerBusinessView', () async {
      final adapter = _RecordingAdapter([_AdapterResponse(200, _validResponse)]);
      final repo = HttpOwnerBusinessRepository(_clientFor(adapter));

      final v = await repo.getMine();
      expect(v.status, 'APPROVED');
      expect(v.ownerUserId, 'owner-1');

      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/me/business');
    });
  });

  group('HttpOwnerBusinessRepository.getMine — error classification', () {
    test('404 → kind=notFound', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          404,
          json.encode({
            'error': {'code': 'NOT_FOUND', 'message': 'no business'},
          }),
        ),
      ]);
      final repo = HttpOwnerBusinessRepository(_clientFor(adapter));

      try {
        await repo.getMine();
        fail('expected OwnerBusinessLoadFailure');
      } on OwnerBusinessLoadFailure catch (e) {
        expect(e.kind, OwnerBusinessLoadFailureKind.notFound);
        expect(e.statusCode, 404);
      }
    });

    test('403 → kind=forbidden', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          403,
          json.encode({
            'error': {'code': 'FORBIDDEN', 'message': 'role drift'},
          }),
        ),
      ]);
      final repo = HttpOwnerBusinessRepository(_clientFor(adapter));

      try {
        await repo.getMine();
        fail('expected OwnerBusinessLoadFailure');
      } on OwnerBusinessLoadFailure catch (e) {
        expect(e.kind, OwnerBusinessLoadFailureKind.forbidden);
        expect(e.statusCode, 403);
      }
    });

    test('401 → kind=unauthenticated', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          401,
          json.encode({
            'error': {'code': 'UNAUTHENTICATED', 'message': 'missing'},
          }),
        ),
      ]);
      final repo = HttpOwnerBusinessRepository(_clientFor(adapter));

      try {
        await repo.getMine();
        fail('expected OwnerBusinessLoadFailure');
      } on OwnerBusinessLoadFailure catch (e) {
        expect(e.kind, OwnerBusinessLoadFailureKind.unauthenticated);
      }
    });

    test('500 → kind=serverError', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          500,
          json.encode({
            'error': {'code': 'INTERNAL_ERROR', 'message': 'boom'},
          }),
        ),
      ]);
      final repo = HttpOwnerBusinessRepository(_clientFor(adapter));

      try {
        await repo.getMine();
        fail('expected OwnerBusinessLoadFailure');
      } on OwnerBusinessLoadFailure catch (e) {
        expect(e.kind, OwnerBusinessLoadFailureKind.serverError);
      }
    });
  });
}
