// EthioLink Mobile — ApiClient + AuthTokenInterceptor tests.
//
// Pins the Authorization-header contract the rest of the app
// depends on. Specifically:
//
//   1. When the `TokenProvider` returns a non-null id token, the
//      interceptor attaches it as the BARE Authorization value
//      (no `Bearer ` prefix). The backend API Gateway REST API
//      `COGNITO_USER_POOLS` authorizer validates the raw header
//      value as a JWT — any `Bearer eyJ…` prefix breaks parsing
//      and the request is rejected with 401 before the Lambda
//      ever runs. We had exactly that bug before this commit;
//      this test class makes sure it can't silently regress.
//
//   2. When the `TokenProvider` returns null (signed-out / public
//      route), the interceptor sends NO Authorization header at
//      all. Public routes (`/v1/categories`,
//      `/v1/businesses` browse) must continue to work without
//      authentication.
//
//   3. The 401 retry path uses the same bare-token shape on the
//      retried request — a refreshed id token, no Bearer prefix.

import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class _StaticTokenProvider implements TokenProvider {
  _StaticTokenProvider({this.token, this.refreshed});
  final String? token;
  final String? refreshed;

  int refreshCallCount = 0;

  @override
  Future<String?> currentIdToken() async => token;

  @override
  Future<String?> refresh() async {
    refreshCallCount += 1;
    return refreshed;
  }
}

/// Records the headers Dio actually puts on the wire and serves
/// scripted responses. The interceptor sits between the call site
/// and this adapter, so the headers captured here are post-
/// interceptor — they reflect what API Gateway would see.
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

ApiClient _clientWith({
  required _RecordingAdapter adapter,
  required TokenProvider provider,
}) {
  final dio = Dio(BaseOptions(baseUrl: _testConfig.apiBaseUrl));
  dio.httpClientAdapter = adapter;
  return ApiClient(
    config: _testConfig,
    tokenProvider: provider,
    dio: dio,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  group('AuthTokenInterceptor — Authorization header contract', () {
    test('attaches the BARE id token (no Bearer prefix) when signed in',
        () async {
      final adapter = _RecordingAdapter([_AdapterResponse(200, '{}')]);
      final client = _clientWith(
        adapter: adapter,
        provider: _StaticTokenProvider(token: 'eyJraWQiOiJ0ZXN0In0.x.y'),
      );

      await client.getJson<void>('/v1/me/appointments', parse: (_) {});

      expect(adapter.captured, hasLength(1));
      final header = adapter.captured[0].headers['Authorization'];
      // Exact-value match — the bare token, nothing else.
      expect(header, 'eyJraWQiOiJ0ZXN0In0.x.y');
      // Hard-stop regression sentinel: if the prefix ever creeps
      // back in, the API Gateway REST COGNITO_USER_POOLS
      // authorizer fails to parse `Bearer eyJ…` as a JWT and
      // rejects every authenticated request with 401 before the
      // Lambda runs.
      expect(header, isNot(startsWith('Bearer ')));
    });

    test('does NOT attach an Authorization header when the token is null',
        () async {
      final adapter = _RecordingAdapter([_AdapterResponse(200, '{}')]);
      final client = _clientWith(
        adapter: adapter,
        provider: _StaticTokenProvider(token: null),
      );

      await client.getJson<void>('/v1/categories', parse: (_) {});

      expect(adapter.captured, hasLength(1));
      expect(
        adapter.captured[0].headers.containsKey('Authorization'),
        isFalse,
        reason:
            'Public routes must not carry an Authorization header — '
            'sending an empty/garbage value would trigger the API '
            'Gateway authorizer on routes that ARE gated.',
      );
    });

    test('does NOT attach an Authorization header when the token is empty',
        () async {
      // Defensive: the token-provider contract is "null when signed
      // out", but a future refactor could leak an empty string
      // through if a refresh resolves to "" on a transient error.
      // The interceptor must treat empty as no-token.
      final adapter = _RecordingAdapter([_AdapterResponse(200, '{}')]);
      final client = _clientWith(
        adapter: adapter,
        provider: _StaticTokenProvider(token: ''),
      );

      await client.getJson<void>('/v1/categories', parse: (_) {});

      expect(
        adapter.captured[0].headers.containsKey('Authorization'),
        isFalse,
      );
    });

    test('preserves an explicit Authorization header set by the caller',
        () async {
      // The interceptor docs guarantee it won't overwrite an
      // explicit header — tests can forward a different token
      // shape via `Options(headers: {...})`. Pin that contract
      // so a future "always attach" simplification doesn't quietly
      // break test injection.
      final adapter = _RecordingAdapter([_AdapterResponse(200, '{}')]);
      final client = _clientWith(
        adapter: adapter,
        provider: _StaticTokenProvider(token: 'auto-attached'),
      );

      await client.dio.get<dynamic>(
        '/v1/admin/probe',
        options: Options(headers: {'Authorization': 'explicit-override'}),
      );

      expect(
        adapter.captured[0].headers['Authorization'],
        'explicit-override',
      );
    });

    test('401 retry attaches the refreshed id token with no Bearer prefix',
        () async {
      final adapter = _RecordingAdapter([
        // First attempt — server returns 401.
        _AdapterResponse(401, '{"error":{"code":"UNAUTHENTICATED"}}'),
        // Retry attempt — succeeds.
        _AdapterResponse(200, '{}'),
      ]);
      final provider =
          _StaticTokenProvider(token: 'old-token', refreshed: 'fresh-token');
      final client = _clientWith(adapter: adapter, provider: provider);

      await client.getJson<void>('/v1/me/appointments', parse: (_) {});

      expect(provider.refreshCallCount, 1);
      expect(adapter.captured, hasLength(2));
      // First attempt sent the cached id token.
      expect(adapter.captured[0].headers['Authorization'], 'old-token');
      // Retry sent the refreshed id token — still no Bearer prefix.
      final retryHeader = adapter.captured[1].headers['Authorization'];
      expect(retryHeader, 'fresh-token');
      expect(retryHeader, isNot(startsWith('Bearer ')));
    });

    test('401 retry surfaces the original 401 when refresh returns null',
        () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(401, '{"error":{"code":"UNAUTHENTICATED"}}'),
      ]);
      final provider =
          _StaticTokenProvider(token: 'old-token', refreshed: null);
      final client = _clientWith(adapter: adapter, provider: provider);

      Object? thrown;
      try {
        await client.getJson<void>('/v1/me/appointments', parse: (_) {});
      } catch (e) {
        thrown = e;
      }

      expect(provider.refreshCallCount, 1);
      // Only the original attempt — no retry was issued because
      // the refresh hook returned null.
      expect(adapter.captured, hasLength(1));
      expect(thrown, isA<ApiException>());
      expect((thrown! as ApiException).statusCode, 401);
    });
  });
}
