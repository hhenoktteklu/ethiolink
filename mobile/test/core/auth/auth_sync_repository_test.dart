// EthioLink Mobile — AuthSyncFailure classification tests.
//
// Pins the mapping between transport-level `ApiException`
// outcomes and the typed `AuthSyncFailureKind` the login screen
// switches on. If the mapping drifts the login screen would
// either re-issue sync against an unusable session
// (unauthenticated leaking into network/other) or force a
// pointless re-OAuth on a transient blip (network leaking into
// unauthenticated).
//
// We also assert the integration: `HttpAuthSyncRepository.sync()`
// POSTs to `/v1/auth/sync` with no body and translates ApiException
// → AuthSyncFailure verbatim.

import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/auth/auth_sync_repository.dart';
import 'package:ethiolink/core/config/app_config.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
);

class _StaticTokenProvider implements TokenProvider {
  const _StaticTokenProvider(this.token);
  final String token;
  @override
  Future<String?> currentIdToken() async => token;
  @override
  Future<String?> refresh() async => null;
}

class _ScriptedAdapter implements HttpClientAdapter {
  _ScriptedAdapter(this.responses);
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

ApiClient _clientWith(_ScriptedAdapter adapter) {
  final dio = Dio(BaseOptions(baseUrl: _testConfig.apiBaseUrl));
  dio.httpClientAdapter = adapter;
  return ApiClient(
    config: _testConfig,
    tokenProvider: const _StaticTokenProvider('id-token-stub'),
    dio: dio,
  );
}

void main() {
  group('AuthSyncFailure.fromApi — classification', () {
    test('401 maps to unauthenticated', () {
      final mapped = AuthSyncFailure.fromApi(
        ApiException(message: 'unauth', statusCode: 401),
      );
      expect(mapped.kind, AuthSyncFailureKind.unauthenticated);
      expect(mapped.statusCode, 401);
    });

    test('apiErrorCode UNAUTHENTICATED maps to unauthenticated', () {
      // Defensive: server returns 200 with an error envelope on
      // some legacy paths. We classify by code in that case.
      final mapped = AuthSyncFailure.fromApi(
        ApiException(
          message: 'unauth',
          statusCode: 200,
          apiErrorCode: 'UNAUTHENTICATED',
        ),
      );
      expect(mapped.kind, AuthSyncFailureKind.unauthenticated);
    });

    test('5xx maps to network (retryable)', () {
      final mapped = AuthSyncFailure.fromApi(
        ApiException(message: 'oops', statusCode: 503),
      );
      expect(mapped.kind, AuthSyncFailureKind.network);
    });

    test('transport error maps to network', () {
      final mapped = AuthSyncFailure.fromApi(
        ApiException(message: 'timeout', isNetworkError: true),
      );
      expect(mapped.kind, AuthSyncFailureKind.network);
    });

    test('400 with no known code maps to other', () {
      // A defensive bucket for shape drift; surfaces "Try again"
      // copy without claiming the session is dead.
      final mapped = AuthSyncFailure.fromApi(
        ApiException(message: 'bad', statusCode: 400),
      );
      expect(mapped.kind, AuthSyncFailureKind.other);
    });
  });

  group('HttpAuthSyncRepository.sync — wire shape', () {
    test('POSTs /v1/auth/sync with no body and resolves on 200', () async {
      final adapter = _ScriptedAdapter([_AdapterResponse(200, '{}')]);
      final repo = HttpAuthSyncRepository(_clientWith(adapter));

      await repo.sync();

      expect(adapter.captured, hasLength(1));
      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/auth/sync');
      // Body is empty by design — the backend reads the Cognito
      // principal off the JWT in the Authorization header.
      expect(req.data, isNull);
      // The bare ID-token interceptor attached the token.
      expect(req.headers['Authorization'], 'id-token-stub');
    });

    test('translates 401 into AuthSyncFailure(unauthenticated)', () async {
      final adapter = _ScriptedAdapter([
        _AdapterResponse(
          401,
          '{"error":{"code":"UNAUTHENTICATED","message":"bad token"}}',
        ),
      ]);
      final repo = HttpAuthSyncRepository(_clientWith(adapter));

      AuthSyncFailure? captured;
      try {
        await repo.sync();
      } on AuthSyncFailure catch (e) {
        captured = e;
      }
      expect(captured, isNotNull);
      expect(captured!.kind, AuthSyncFailureKind.unauthenticated);
      expect(captured.statusCode, 401);
    });

    test('translates 503 into AuthSyncFailure(network)', () async {
      final adapter = _ScriptedAdapter([
        _AdapterResponse(503, '{"error":{"code":"SERVER_ERROR"}}'),
      ]);
      final repo = HttpAuthSyncRepository(_clientWith(adapter));

      AuthSyncFailure? captured;
      try {
        await repo.sync();
      } on AuthSyncFailure catch (e) {
        captured = e;
      }
      expect(captured?.kind, AuthSyncFailureKind.network);
    });
  });
}
