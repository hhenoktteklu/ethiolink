// EthioLink Mobile — POST /v1/auth/sync client.
//
// Purpose: bootstrap the backend `users` row for a freshly
// authenticated Cognito user. Cognito holds identity (sub, email,
// groups), but the application database keeps its own users
// table with the app-level profile (locale, telegram chat id,
// etc.). The backend's `auth.sync` handler is idempotent — first
// call inserts a new row, every subsequent call returns the
// existing row — so it's safe to issue on every sign-in and on
// any restored-session path.
//
// Sequencing rule (see `login_screen.dart`):
//   * `AuthSyncRepository.sync()` MUST run after the Cognito
//     tokens are persisted in secure storage (so the ApiClient's
//     auth interceptor can attach the ID token) and BEFORE any
//     protected route is opened. The Bookings tab in particular
//     calls `GET /v1/me/appointments`, whose handler looks up the
//     users row by Cognito sub and returns 404 (`User profile
//     not found. Call POST /v1/auth/sync first.`) if the row
//     doesn't exist yet.
//
// Failure model:
//   * `AuthSyncFailureKind.unauthenticated` — 401 / token rejected.
//     The login screen surfaces this with a "sign in again" CTA;
//     re-running the OAuth flow is the only fix.
//   * `AuthSyncFailureKind.network` — 5xx / DNS / timeout. The
//     login screen surfaces this with a "Try again" CTA that
//     calls `sync()` once more without re-running the OAuth flow.
//   * `AuthSyncFailureKind.other` — 4xx outside the buckets above
//     (e.g. unexpected `VALIDATION_ERROR` from a future
//     change). Same affordance as `network` — retry the sync.
//
// The endpoint takes NO request body — the backend reads the
// Cognito principal off the JWT in the Authorization header.
// The response is the `UserView` shape, but we only need the
// success / failure signal so the repository returns `void`.

import '../api/api_client.dart' show ApiClient, ApiException;

/// Domain port. Production wires `HttpAuthSyncRepository`; tests
/// substitute a fake that records invocations + scripts
/// success / failure.
abstract class AuthSyncRepository {
  /// Idempotent. Returns normally on 200/201; throws
  /// `AuthSyncFailure` on every non-success outcome.
  Future<void> sync();
}

/// Bucketed classification of `sync()` failures so the login
/// screen can pick its CTA copy without parsing HTTP details.
enum AuthSyncFailureKind {
  /// HTTP 401 — Cognito token rejected by the backend authorizer.
  /// Re-authenticate.
  unauthenticated,

  /// HTTP 5xx / DNS / timeout — transient. Retry.
  network,

  /// 4xx outside the above bucket + response-decode errors.
  /// Retry — defensive against future shape changes.
  other,
}

class AuthSyncFailure implements Exception {
  AuthSyncFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final AuthSyncFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  /// Translate an `ApiException` from the Dio interceptor into the
  /// typed failure the login screen handles.
  factory AuthSyncFailure.fromApi(ApiException e) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    AuthSyncFailureKind k;
    if (e.isNetworkError) {
      k = AuthSyncFailureKind.network;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = AuthSyncFailureKind.unauthenticated;
    } else if (status != null && status >= 500) {
      k = AuthSyncFailureKind.network;
    } else {
      k = AuthSyncFailureKind.other;
    }
    return AuthSyncFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'AuthSyncFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}

/// Default production implementation. Issues
/// `POST /v1/auth/sync` over the supplied `ApiClient`; the
/// `AuthTokenInterceptor` on the client attaches the bare
/// Cognito ID token from secure storage (see
/// `api_client.dart`'s header rationale).
class HttpAuthSyncRepository implements AuthSyncRepository {
  HttpAuthSyncRepository(this._client);
  final ApiClient _client;

  static const _path = '/v1/auth/sync';

  @override
  Future<void> sync() async {
    try {
      // Empty body — handler reads the Cognito principal off the
      // request's `event.requestContext.authorizer.claims`.
      // `postJson` insists on a `parse` callback; we don't need
      // the `UserView` here, so the parser is a no-op.
      await _client.postJson<void>(_path, parse: (_) {});
    } on ApiException catch (e) {
      throw AuthSyncFailure.fromApi(e);
    }
  }
}
