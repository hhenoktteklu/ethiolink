// EthioLink Mobile — Dio-backed HTTP client.
//
// Phase 9 Track 3, post-auth commit. Replaces the
// `UnimplementedError`-throwing scaffold stub. The client is
// thin on purpose: it owns the `Dio` instance, the auth-token
// interceptor wiring, and a small JSON helper. Per-domain
// repositories (`CategoriesRepository`, future bookings repo,
// etc.) layer on top.
//
// Auth-token attachment:
//   * Public endpoints (`GET /v1/categories`,
//     `GET /v1/businesses*`) work without an Authorization header.
//     The interceptor inspects each request — if a `TokenProvider`
//     returns a non-null token, the header is added; otherwise the
//     request goes out unauthenticated and the API serves it via
//     its `authorization = "NONE"` route handler.
//
//   * Authenticated endpoints attach the Cognito ID token directly
//     as the Authorization header value — `Authorization: <idToken>`,
//     with NO `Bearer ` scheme prefix. The backend authorizer is an
//     API Gateway REST API `COGNITO_USER_POOLS` authorizer (see
//     `infra/terraform/modules/api-gateway/main.tf` —
//     `aws_api_gateway_authorizer.cognito` with `identity_source =
//     "method.request.header.Authorization"` and no
//     `authorizationScopes` on the methods). That authorizer
//     extracts the verbatim Authorization-header value and validates
//     it as a JWT against the configured user pool. When the value
//     starts with `Bearer ` the authorizer treats the entire
//     `Bearer eyJ...` string as the candidate JWT, fails to parse
//     it (JWTs start with `eyJ`, not `Bearer `), and rejects the
//     request with 401 before the Lambda ever runs. The mobile app
//     was hitting exactly that on every authenticated route
//     (`/v1/me/appointments`, owner inbox, etc.) — CloudWatch had
//     no Lambda invocations because API Gateway short-circuited at
//     the authorizer. The fix is to send the raw ID token. The
//     Cognito hosted-UI `/oauth2/userInfo` endpoint, which DOES
//     follow the OAuth 2.0 bearer-token convention, takes the
//     access token with the `Bearer ` prefix — but `CognitoAuthService`
//     calls that endpoint directly via `flutter_appauth`'s
//     `userinfoEndpoint` helper, not through this interceptor, so
//     dropping the prefix here has no impact on it.
//
//   * Token type — ID token (not access token). With
//     `authorizationScopes` unset on the methods (which it is —
//     see API Gateway module Terraform), the COGNITO_USER_POOLS
//     authorizer expects the ID token; the `token_use` claim is
//     `id` for these. Access tokens (`token_use=access`) are only
//     required when the method declares specific OAuth scopes the
//     authorizer must enforce. We keep the access token in secure
//     storage anyway (see `cognito_auth_service.dart`'s
//     `cognito.access_token` key) for any future userinfo / scope-
//     gated call, but ApiClient never reads it.
//
//   The token comes from the same `flutter_secure_storage` cache
//   `CognitoAuthService` writes — we read by key, not by
//   inversion-of-control through `AuthService`, to keep the
//   interceptor synchronous-feeling at the call site (it still
//   issues the storage read async; the `onRequest` handler is
//   async-aware).
//
//   * 401 retry — when the API rejects an authenticated request,
//     the interceptor asks the `TokenProvider` to refresh once,
//     then retries the original request with the fresh token. The
//     production provider's `refresh()` calls
//     `CognitoAuthService.currentSession()` which already handles
//     near-expiry refresh; on failure it returns null and the
//     401 surfaces to the caller for re-login routing.
//
// Test seam:
//   * Tests inject a `Dio` configured with a `MockAdapter` from
//     `package:dio` (or the standard `package:dio_test` adapter
//     when it lands in pubspec; for scaffold tests we drive
//     repositories with a fake repo abstraction instead).
//   * The `TokenProvider` abstraction is the second seam — tests
//     pass an in-memory token (or `null`) without touching
//     `flutter_secure_storage`.

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../config/app_config.dart';

/// Provides the current id-token for outbound API requests, plus
/// a refresh hook the 401 retry path can call. Production uses
/// `SecureStorageTokenProvider`; tests use an in-memory stub.
abstract class TokenProvider {
  /// Current id token (null when the user is signed out). Called
  /// on every request the interceptor processes.
  Future<String?> currentIdToken();

  /// Best-effort refresh after a 401. Returns the new id token
  /// when refresh succeeded, `null` otherwise. The interceptor
  /// retries the original request with the new token; on null it
  /// surfaces the 401 to the caller.
  Future<String?> refresh();
}

/// Default production `TokenProvider`. Reads from
/// `flutter_secure_storage` under the same key
/// `CognitoAuthService` writes. The refresh hook is intentionally
/// left as a stub — wiring it through to `CognitoAuthService.currentSession`
/// requires the auth service instance; the next mobile commit
/// adds that DI wire-up. Today: on 401, the user re-logs in by
/// hand from the LoginScreen. Acceptable for the first browse-
/// fetch path because every authenticated endpoint behind it
/// already returns 401 gracefully.
class SecureStorageTokenProvider implements TokenProvider {
  const SecureStorageTokenProvider({this.storage = const FlutterSecureStorage()});

  final FlutterSecureStorage storage;

  /// Mirrors the key constant in `cognito_auth_service.dart`. We
  /// reference the literal here (not the constant) to avoid an
  /// import cycle between `core/api/` and `core/auth/`. Renaming
  /// requires updating both sites — the trade-off is acceptable
  /// at scaffold scale.
  static const _kIdToken = 'cognito.id_token';

  @override
  Future<String?> currentIdToken() => storage.read(key: _kIdToken);

  @override
  Future<String?> refresh() async {
    // Phase 9 placeholder. Real refresh dispatch lands in the
    // next mobile commit when `CognitoAuthService` is injectable
    // here without creating an import cycle. For now we just
    // re-read — if the auth service refreshed the token on cold
    // start, the next request picks up the fresh value.
    return storage.read(key: _kIdToken);
  }
}

/// Thin wrapper around `Dio`. Repositories depend on this; the
/// `dio` getter exposes the underlying client for the rare case
/// a caller needs to send a request shape the helpers don't
/// cover.
class ApiClient {
  ApiClient({
    required AppConfig config,
    TokenProvider? tokenProvider,
    Dio? dio,
  })  : _tokenProvider = tokenProvider ?? const SecureStorageTokenProvider(),
        dio = _resolveDio(dio, config) {
    // After the initializer list runs, the parameter `dio` is no
    // longer in scope here (we deliberately moved interceptor
    // wiring into a separate method to avoid the
    // parameter-shadows-field analyzer warnings — `dio!` would be
    // an "unnecessary_non_null_assertion" because the field is
    // already non-null; bare `dio` would resolve to the nullable
    // parameter and demand the assertion. Calling the helper
    // sidesteps the dance entirely).
    _wireInterceptors();
  }

  final Dio dio;
  final TokenProvider _tokenProvider;

  static Dio _resolveDio(Dio? override, AppConfig config) {
    return override ??
        Dio(
          BaseOptions(
            baseUrl: config.apiBaseUrl,
            connectTimeout: const Duration(seconds: 10),
            receiveTimeout: const Duration(seconds: 15),
            responseType: ResponseType.json,
            headers: <String, String>{
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            },
          ),
        );
  }

  void _wireInterceptors() {
    dio.interceptors.add(AuthTokenInterceptor(_tokenProvider, dio: dio));
  }

  /// Convenience GET that decodes the JSON body via the supplied
  /// `parse` callback. Throws `ApiException` on non-2xx responses
  /// + on transport errors.
  Future<T> getJson<T>(
    String path, {
    Map<String, dynamic>? queryParameters,
    required T Function(dynamic body) parse,
  }) async {
    try {
      final response = await dio.get<dynamic>(
        path,
        queryParameters: queryParameters,
      );
      return parse(response.data);
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// Convenience POST. Authenticated routes get the bearer header
  /// via the `AuthTokenInterceptor`; nothing extra to do at the
  /// call site. Throws `ApiException` on non-2xx — the booking
  /// flow inspects `apiErrorCode` to branch on `SLOT_UNAVAILABLE`.
  Future<T> postJson<T>(
    String path, {
    Object? body,
    required T Function(dynamic body) parse,
  }) async {
    try {
      final response = await dio.post<dynamic>(path, data: body);
      return parse(response.data);
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// Convenience PUT. Mirrors `postJson`. The availability editor
  /// uses this for the "replace the whole weekly schedule" call —
  /// PUT is the right verb when the server semantically replaces
  /// the addressed resource with the request body.
  Future<T> putJson<T>(
    String path, {
    Object? body,
    required T Function(dynamic body) parse,
  }) async {
    try {
      final response = await dio.put<dynamic>(path, data: body);
      return parse(response.data);
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// Convenience PATCH. Mirrors `postJson` — the API returns the
  /// updated resource in the response body, so the caller passes
  /// a `parse` callback. Body is optional (an empty patch is a
  /// valid no-op for several endpoints).
  Future<T> patchJson<T>(
    String path, {
    Object? body,
    required T Function(dynamic body) parse,
  }) async {
    try {
      final response = await dio.patch<dynamic>(path, data: body);
      return parse(response.data);
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }

  /// Convenience DELETE. Many EthioLink "delete" endpoints are
  /// soft-deletes that return the deactivated resource (e.g.
  /// services + staff). The caller passes `parse` to decode the
  /// response body just like `getJson`. Endpoints with empty
  /// bodies can pass a no-op parser.
  Future<T> deleteJson<T>(
    String path, {
    required T Function(dynamic body) parse,
  }) async {
    try {
      final response = await dio.delete<dynamic>(path);
      return parse(response.data);
    } on DioException catch (e) {
      throw ApiException.fromDio(e);
    }
  }
}

/// Dio interceptor that attaches the Cognito id token to every
/// request when one is available, and runs a one-shot 401 retry
/// path after asking the `TokenProvider` to refresh.
class AuthTokenInterceptor extends Interceptor {
  AuthTokenInterceptor(this._tokenProvider, {required this.dio});

  final TokenProvider _tokenProvider;
  final Dio dio;

  static const _retryFlag = '__ethiolink_auth_retried';

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    // Don't overwrite an explicit Authorization header — the
    // caller may have a reason (e.g. forwarding a different
    // token in a test). Otherwise attach the bare Cognito ID
    // token when one exists (see header rationale in the file
    // docs — API Gateway REST `COGNITO_USER_POOLS` rejects a
    // `Bearer eyJ…` value with 401 before the Lambda runs).
    if (!options.headers.containsKey('Authorization')) {
      final token = await _tokenProvider.currentIdToken();
      if (token != null && token.isNotEmpty) {
        options.headers['Authorization'] = token;
      }
    }
    handler.next(options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    // 401 retry path. Only retries once — the `_retryFlag` extra
    // prevents an infinite loop when the refresh succeeds but the
    // API still rejects (e.g. revoked user, role demotion).
    final response = err.response;
    if (response?.statusCode != 401 ||
        err.requestOptions.extra[_retryFlag] == true) {
      handler.next(err);
      return;
    }

    final fresh = await _tokenProvider.refresh();
    if (fresh == null || fresh.isEmpty) {
      handler.next(err);
      return;
    }

    final retryOptions = err.requestOptions.copyWith(
      headers: <String, dynamic>{
        ...err.requestOptions.headers,
        // Bare ID token, no `Bearer ` prefix — see file docs.
        'Authorization': fresh,
      },
      extra: <String, dynamic>{
        ...err.requestOptions.extra,
        _retryFlag: true,
      },
    );

    try {
      final retried = await dio.fetch<dynamic>(retryOptions);
      handler.resolve(retried);
    } on DioException catch (retryErr) {
      handler.next(retryErr);
    }
  }
}

/// Domain-friendly wrapper for transport + HTTP errors. The
/// underlying `DioException` is preserved on `.cause` for
/// debugging; the public surface is `statusCode` + `message` +
/// `isNetworkError` + `apiErrorCode`. Repositories may further
/// translate specific 4xx codes into typed domain errors.
class ApiException implements Exception {
  ApiException({
    required this.message,
    this.statusCode,
    this.isNetworkError = false,
    this.apiErrorCode,
    this.apiErrorDetails,
    this.cause,
  });

  final String message;
  final int? statusCode;
  final bool isNetworkError;

  /// Server-side error code from the `{error:{code, ...}}` body,
  /// when present. Mirrors the OpenAPI `Error.code` enum
  /// (`VALIDATION_ERROR`, `SLOT_UNAVAILABLE`, `CONFLICT`,
  /// `UNAUTHENTICATED`, …). Callers switch on this to render
  /// domain-specific copy.
  final String? apiErrorCode;

  /// Server-side `{error: {details: {...}}}` payload, when
  /// present. Free-shape per-endpoint — e.g. the submit-business
  /// 400 returns `{missing: [<field>, ...]}` so the owner can be
  /// told exactly which fields are blocking. Repositories that
  /// know an endpoint's shape parse the relevant keys; the raw
  /// map stays here so unforeseen surfaces don't need a new
  /// release of the client.
  final Map<String, dynamic>? apiErrorDetails;

  final Object? cause;

  factory ApiException.fromDio(DioException err) {
    final status = err.response?.statusCode;
    if (status != null) {
      // 4xx / 5xx with a parsed response. Try to pull
      // `body.error.code` + `body.error.message` + `body.error.details`
      // per the OpenAPI Error schema. The interceptor / Dio parses
      // JSON automatically.
      final data = err.response?.data;
      String? code;
      String? serverMessage;
      Map<String, dynamic>? errorDetails;
      if (data is Map<String, dynamic>) {
        final errBody = data['error'];
        if (errBody is Map<String, dynamic>) {
          final c = errBody['code'];
          if (c is String && c.isNotEmpty) code = c;
          final m = errBody['message'];
          if (m is String && m.isNotEmpty) serverMessage = m;
          final d = errBody['details'];
          if (d is Map<String, dynamic>) errorDetails = d;
        }
      }
      return ApiException(
        message: serverMessage ??
            'HTTP $status from ${err.requestOptions.path}.',
        statusCode: status,
        apiErrorCode: code,
        apiErrorDetails: errorDetails,
        cause: err,
      );
    }
    // No response — network / timeout / abort.
    return ApiException(
      message:
          'Network error: ${err.type.name}${err.message != null ? " (${err.message})" : ""}.',
      isNetworkError: true,
      cause: err,
    );
  }

  @override
  String toString() => 'ApiException: $message';
}
