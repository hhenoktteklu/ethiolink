// EthioLink Mobile — TelegramLinkRepository tests.
//
// `_RecordingAdapter` pattern. Covers the three operations and
// the failure-kind classifier on the documented status codes.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/profile/data/telegram_link_repository.dart';

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

void main() {
  group('HttpTelegramLinkRepository.startLink', () {
    test('POSTs /v1/me/link-telegram/start and decodes the body', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode({
            'deepLink': 'https://t.me/EthioLinkBot?start=ABCDEF',
            'expiresAt': '2026-05-15T10:30:00.000Z',
          }),
        ),
      ]);
      final repo = HttpTelegramLinkRepository(_clientFor(adapter));

      final result = await repo.startLink();
      expect(result.deepLink, 'https://t.me/EthioLinkBot?start=ABCDEF');
      expect(result.expiresAt, '2026-05-15T10:30:00.000Z');

      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/me/link-telegram/start');
    });

    test('503 → kind=unconfigured', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          503,
          json.encode({
            'error': {'code': 'INTERNAL_ERROR', 'message': 'not configured'},
          }),
        ),
      ]);
      final repo = HttpTelegramLinkRepository(_clientFor(adapter));

      try {
        await repo.startLink();
        fail('expected TelegramLinkFailure');
      } on TelegramLinkFailure catch (e) {
        expect(e.kind, TelegramLinkFailureKind.unconfigured);
        expect(e.statusCode, 503);
      }
    });

    test('401 → kind=unauthenticated', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          401,
          json.encode({
            'error': {'code': 'UNAUTHENTICATED', 'message': 'expired'},
          }),
        ),
      ]);
      final repo = HttpTelegramLinkRepository(_clientFor(adapter));

      try {
        await repo.startLink();
        fail('expected TelegramLinkFailure');
      } on TelegramLinkFailure catch (e) {
        expect(e.kind, TelegramLinkFailureKind.unauthenticated);
      }
    });

    test('500 → kind=network (server-side instability)', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          500,
          json.encode({
            'error': {'code': 'INTERNAL_ERROR', 'message': 'boom'},
          }),
        ),
      ]);
      final repo = HttpTelegramLinkRepository(_clientFor(adapter));

      try {
        await repo.startLink();
        fail('expected TelegramLinkFailure');
      } on TelegramLinkFailure catch (e) {
        expect(e.kind, TelegramLinkFailureKind.network);
      }
    });
  });

  group('HttpTelegramLinkRepository.getStatus', () {
    test('GETs /v1/me/telegram-status and decodes the body', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode({
            'linked': true,
            'linkedAt': '2026-05-15T09:42:00.000Z',
          }),
        ),
      ]);
      final repo = HttpTelegramLinkRepository(_clientFor(adapter));

      final result = await repo.getStatus();
      expect(result.linked, true);
      expect(result.linkedAt, '2026-05-15T09:42:00.000Z');

      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/me/telegram-status');
    });

    test('returns linked=false + null linkedAt for an unlinked user', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode({'linked': false, 'linkedAt': null}),
        ),
      ]);
      final repo = HttpTelegramLinkRepository(_clientFor(adapter));

      final result = await repo.getStatus();
      expect(result.linked, false);
      expect(result.linkedAt, isNull);
    });
  });

  group('HttpTelegramLinkRepository.unlink', () {
    test('DELETEs /v1/me/link-telegram', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, json.encode({'linked': false})),
      ]);
      final repo = HttpTelegramLinkRepository(_clientFor(adapter));

      await repo.unlink();

      final req = adapter.captured[0];
      expect(req.method, 'DELETE');
      expect(req.path, '/v1/me/link-telegram');
    });

    test('503 → kind=unconfigured', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          503,
          json.encode({
            'error': {'code': 'INTERNAL_ERROR', 'message': 'unconfigured'},
          }),
        ),
      ]);
      final repo = HttpTelegramLinkRepository(_clientFor(adapter));

      try {
        await repo.unlink();
        fail('expected TelegramLinkFailure');
      } on TelegramLinkFailure catch (e) {
        expect(e.kind, TelegramLinkFailureKind.unconfigured);
      }
    });
  });
}
