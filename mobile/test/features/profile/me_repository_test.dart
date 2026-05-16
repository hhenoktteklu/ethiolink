// EthioLink Mobile — MeRepository tests.
//
// `_RecordingAdapter` pattern (mirrors `telegram_link_repository_test.dart`).
// Covers `PATCH /v1/me { locale }` request shape + failure-kind classification.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/profile/data/me_repository.dart';

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

String _sampleUserView({String locale = 'am'}) {
  return json.encode({
    'id': '00000000-0000-0000-0000-000000000001',
    'email': 'henok@example.com',
    'phone': null,
    'displayName': 'Henok',
    'role': 'CUSTOMER',
    'locale': locale,
    'createdAt': '2026-05-15T10:00:00.000Z',
    'updatedAt': '2026-05-16T11:00:00.000Z',
  });
}

void main() {
  group('HttpMeRepository.patchLocale — request shape', () {
    test('PATCHes /v1/me with the expected JSON body', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _sampleUserView(locale: 'am')),
      ]);
      final repo = HttpMeRepository(_clientFor(adapter));

      final returned = await repo.patchLocale('am');

      expect(returned, 'am');

      final req = adapter.captured.single;
      expect(req.method, 'PATCH');
      expect(req.path, '/v1/me');
      // Dio serialises the body to JSON before the adapter sees
      // it. The Map shape is preserved on `data`.
      expect(req.data, equals(<String, dynamic>{'locale': 'am'}));
    });

    test('echoes back the locale the server confirmed (en)', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _sampleUserView(locale: 'en')),
      ]);
      final repo = HttpMeRepository(_clientFor(adapter));

      final returned = await repo.patchLocale('en');
      expect(returned, 'en');
    });
  });

  group('HttpMeRepository.patchLocale — failure classification', () {
    test('400 VALIDATION_ERROR → kind=validation', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          400,
          json.encode({
            'error': {
              'code': 'VALIDATION_ERROR',
              'message': 'locale must be one of en, am.',
            },
          }),
        ),
      ]);
      final repo = HttpMeRepository(_clientFor(adapter));

      try {
        await repo.patchLocale('fr');
        fail('expected MeUpdateFailure');
      } on MeUpdateFailure catch (e) {
        expect(e.kind, MeUpdateFailureKind.validation);
        expect(e.statusCode, 400);
        expect(e.apiErrorCode, 'VALIDATION_ERROR');
      }
    });

    test('401 UNAUTHENTICATED → kind=unauthenticated', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          401,
          json.encode({
            'error': {'code': 'UNAUTHENTICATED', 'message': 'expired'},
          }),
        ),
      ]);
      final repo = HttpMeRepository(_clientFor(adapter));

      try {
        await repo.patchLocale('am');
        fail('expected MeUpdateFailure');
      } on MeUpdateFailure catch (e) {
        expect(e.kind, MeUpdateFailureKind.unauthenticated);
      }
    });

    test('404 NOT_FOUND → kind=notFound', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          404,
          json.encode({
            'error': {'code': 'NOT_FOUND', 'message': 'call /auth/sync first'},
          }),
        ),
      ]);
      final repo = HttpMeRepository(_clientFor(adapter));

      try {
        await repo.patchLocale('am');
        fail('expected MeUpdateFailure');
      } on MeUpdateFailure catch (e) {
        expect(e.kind, MeUpdateFailureKind.notFound);
      }
    });

    test('500 INTERNAL_ERROR → kind=network', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          500,
          json.encode({
            'error': {'code': 'INTERNAL_ERROR', 'message': 'boom'},
          }),
        ),
      ]);
      final repo = HttpMeRepository(_clientFor(adapter));

      try {
        await repo.patchLocale('am');
        fail('expected MeUpdateFailure');
      } on MeUpdateFailure catch (e) {
        expect(e.kind, MeUpdateFailureKind.network);
      }
    });

    test('malformed body (missing locale field) surfaces kind=other', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, json.encode({'id': 'u-1'})),
      ]);
      final repo = HttpMeRepository(_clientFor(adapter));

      try {
        await repo.patchLocale('am');
        fail('expected MeUpdateFailure');
      } on MeUpdateFailure catch (e) {
        expect(e.kind, MeUpdateFailureKind.other);
      }
    });
  });
}
