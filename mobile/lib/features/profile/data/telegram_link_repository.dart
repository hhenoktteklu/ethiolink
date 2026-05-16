// EthioLink Mobile — Telegram-link repository.
//
// Phase 9 Track 2 mobile UI commit. Wraps the three customer-/
// owner-facing Telegram linking endpoints:
//
//   * `POST   /v1/me/link-telegram/start` — issue a single-use
//     code + return the `t.me/<bot>?start=<code>` deep link.
//   * `GET    /v1/me/telegram-status`    — read the caller's
//     `users.telegram_chat_id` state.
//   * `DELETE /v1/me/link-telegram`      — clear the chat id
//     (idempotent).
//
// All three are authenticated — the `ApiClient`'s
// `AuthTokenInterceptor` attaches the Cognito id token from
// `flutter_secure_storage`. The repository exposes a typed
// failure surface so the screen can render distinct copy for
// the "operator hasn't configured Telegram in this env" (503)
// case vs. the generic network / 5xx fallbacks.

import '../../../core/api/api_client.dart';

/// Started linking session — what the UI shows on tap.
class TelegramLinkStart {
  const TelegramLinkStart({required this.deepLink, required this.expiresAt});

  /// `https://t.me/<bot>?start=<code>` deep link, ready to open
  /// with `url_launcher`.
  final String deepLink;

  /// ISO-8601 UTC instant after which the code stops being
  /// valid. The screen shows a "code expires at HH:MM" hint and
  /// stops polling after this moment.
  final String expiresAt;
}

/// Current linking status. `linkedAt` is the user row's
/// `updated_at` when `linked` is `true`; `null` when unlinked.
class TelegramLinkStatus {
  const TelegramLinkStatus({required this.linked, required this.linkedAt});

  final bool linked;
  final String? linkedAt;
}

/// Domain port. Production wires `HttpTelegramLinkRepository`;
/// tests pass an in-memory fake or a `_RecordingAdapter`-backed
/// implementation.
abstract class TelegramLinkRepository {
  Future<TelegramLinkStart> startLink();
  Future<TelegramLinkStatus> getStatus();
  Future<void> unlink();
}

/// Failure classification consumed by `LinkTelegramScreen`. The
/// kinds are stable codes the screen switches on for copy.
enum TelegramLinkFailureKind {
  /// HTTP 503 — the operator has not wired Telegram in this env
  /// (`config.telegramProvider` is `null`). The screen renders
  /// dedicated "Telegram is not yet enabled for this environment"
  /// copy and hides the Link CTA.
  unconfigured,

  /// HTTP 401 — the user's session expired or the token was
  /// rejected. Surfaced as "Sign in again".
  unauthenticated,

  /// HTTP 404 — the user row is missing (caller forgot
  /// `/v1/auth/sync`). Rare; surfaced as a generic retry.
  notFound,

  /// HTTP 5xx / DNS / timeout — transport-level failure.
  network,

  /// 4xx outside the buckets above + decode errors.
  other,
}

class TelegramLinkFailure implements Exception {
  TelegramLinkFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final TelegramLinkFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  factory TelegramLinkFailure.fromApi(ApiException e) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    TelegramLinkFailureKind k;
    if (e.isNetworkError) {
      k = TelegramLinkFailureKind.network;
    } else if (status == 503) {
      k = TelegramLinkFailureKind.unconfigured;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = TelegramLinkFailureKind.unauthenticated;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = TelegramLinkFailureKind.notFound;
    } else if (status != null && status >= 500) {
      k = TelegramLinkFailureKind.network;
    } else {
      k = TelegramLinkFailureKind.other;
    }
    return TelegramLinkFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'TelegramLinkFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}

class HttpTelegramLinkRepository implements TelegramLinkRepository {
  HttpTelegramLinkRepository(this._client);
  final ApiClient _client;

  static const _startPath = '/v1/me/link-telegram/start';
  static const _statusPath = '/v1/me/telegram-status';
  static const _unlinkPath = '/v1/me/link-telegram';

  @override
  Future<TelegramLinkStart> startLink() async {
    try {
      return await _client.postJson<TelegramLinkStart>(
        _startPath,
        // Body is intentionally absent — the backend handler
        // derives every input from the caller's principal.
        parse: _parseStart,
      );
    } on FormatException catch (e) {
      throw TelegramLinkFailure(
        kind: TelegramLinkFailureKind.other,
        message: 'Start response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw TelegramLinkFailure.fromApi(e);
    }
  }

  @override
  Future<TelegramLinkStatus> getStatus() async {
    try {
      return await _client.getJson<TelegramLinkStatus>(
        _statusPath,
        parse: _parseStatus,
      );
    } on FormatException catch (e) {
      throw TelegramLinkFailure(
        kind: TelegramLinkFailureKind.other,
        message: 'Status response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw TelegramLinkFailure.fromApi(e);
    }
  }

  @override
  Future<void> unlink() async {
    try {
      // The backend returns `{ linked: false }`; we ignore the
      // body — the caller flips back to the not-linked state
      // either way.
      await _client.deleteJson<void>(_unlinkPath, parse: (_) {});
    } on ApiException catch (e) {
      throw TelegramLinkFailure.fromApi(e);
    }
  }
}

// ---------------------------------------------------------------------------
// JSON parsers — kept module-private; throw `FormatException` so
// the repository can translate them into the typed failure surface.
// ---------------------------------------------------------------------------

TelegramLinkStart _parseStart(dynamic body) {
  if (body is! Map<String, dynamic>) {
    throw const FormatException('TelegramLinkStart body must be an object.');
  }
  final deepLink = body['deepLink'];
  final expiresAt = body['expiresAt'];
  if (deepLink is! String || deepLink.isEmpty) {
    throw const FormatException('deepLink missing or non-string.');
  }
  if (expiresAt is! String || expiresAt.isEmpty) {
    throw const FormatException('expiresAt missing or non-string.');
  }
  return TelegramLinkStart(deepLink: deepLink, expiresAt: expiresAt);
}

TelegramLinkStatus _parseStatus(dynamic body) {
  if (body is! Map<String, dynamic>) {
    throw const FormatException('TelegramLinkStatus body must be an object.');
  }
  final linked = body['linked'];
  if (linked is! bool) {
    throw const FormatException('linked missing or non-boolean.');
  }
  final linkedAt = body['linkedAt'];
  return TelegramLinkStatus(
    linked: linked,
    linkedAt: linkedAt is String && linkedAt.isNotEmpty ? linkedAt : null,
  );
}
