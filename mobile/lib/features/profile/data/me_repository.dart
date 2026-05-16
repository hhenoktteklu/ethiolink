// EthioLink Mobile — `PATCH /v1/me` repository.
//
// Phase 9 Track 5 — covers the slice of `/v1/me` the mobile app
// actually drives today: the locale field. `displayName` will
// land here when an in-app profile editor surfaces (currently
// the field is set only by Cognito-side sign-up flows). The shape
// matches the OpenAPI `PatchMeRequest` schema:
//
//     PATCH /v1/me
//     { "locale": "en" | "am" }
//
//   * `locale` does NOT accept `null` — the column is `NOT NULL`.
//     Omit the field to leave it unchanged; this repository's
//     `patchLocale` always sets it explicitly.
//   * 400 `VALIDATION_ERROR` → unknown locale value. Surface as
//     `MeUpdateFailureKind.validation` so the picker can show
//     "Couldn't save your language" copy.
//   * 401 `UNAUTHENTICATED` → session expired. Surface as
//     `MeUpdateFailureKind.unauthenticated`.
//   * Network / 5xx → `MeUpdateFailureKind.network` (matches the
//     pattern in `TelegramLinkRepository`).
//
// The repository deliberately returns the parsed locale only —
// not the full `UserView` — because the locale picker is the
// only caller today. A future profile-edit screen will swap to a
// typed `MeView` shape; the port surface widens additively.

import '../../../core/api/api_client.dart';

/// Domain port. Production wires `HttpMeRepository`; tests pass
/// `_RecordingMeRepository` or similar.
abstract class MeRepository {
  /// Persist the user's preferred UI / notification locale. The
  /// argument is the wire shape (`'en'` or `'am'`); returns the
  /// locale the server confirmed it saved. Throws
  /// `MeUpdateFailure` on any non-success outcome.
  Future<String> patchLocale(String locale);
}

/// Failure classification consumed by the locale picker. The
/// kinds mirror the `TelegramLinkFailureKind` shape so the
/// profile screen can switch on them consistently.
enum MeUpdateFailureKind {
  /// HTTP 400 — usually `VALIDATION_ERROR` for an unknown locale
  /// value. The picker only sends `'en'` / `'am'`, so this case
  /// is defensive (e.g. backend tightened the enum mid-deploy).
  validation,

  /// HTTP 401 — the user's session expired or the token was
  /// rejected. The picker rolls back the optimistic state and
  /// the user re-signs in to retry.
  unauthenticated,

  /// HTTP 404 — `/v1/auth/sync` was never called for this user.
  /// Rare; surfaced as a generic retry.
  notFound,

  /// HTTP 5xx / DNS / timeout — transport-level failure.
  network,

  /// 4xx outside the buckets above + decode errors.
  other,
}

class MeUpdateFailure implements Exception {
  MeUpdateFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final MeUpdateFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  factory MeUpdateFailure.fromApi(ApiException e) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    MeUpdateFailureKind k;
    if (e.isNetworkError) {
      k = MeUpdateFailureKind.network;
    } else if (status == 400 || code == 'VALIDATION_ERROR') {
      k = MeUpdateFailureKind.validation;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = MeUpdateFailureKind.unauthenticated;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = MeUpdateFailureKind.notFound;
    } else if (status != null && status >= 500) {
      k = MeUpdateFailureKind.network;
    } else {
      k = MeUpdateFailureKind.other;
    }
    return MeUpdateFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'MeUpdateFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}

class HttpMeRepository implements MeRepository {
  HttpMeRepository(this._client);
  final ApiClient _client;

  static const _path = '/v1/me';

  @override
  Future<String> patchLocale(String locale) async {
    try {
      // Body shape mirrors `PatchMeRequest` from the OpenAPI doc.
      // The backend returns the updated `UserView`; we only need
      // the confirmed `locale` to echo back.
      return await _client.patchJson<String>(
        _path,
        body: <String, dynamic>{'locale': locale},
        parse: _parseLocale,
      );
    } on FormatException catch (e) {
      throw MeUpdateFailure(
        kind: MeUpdateFailureKind.other,
        message: 'PATCH /v1/me response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw MeUpdateFailure.fromApi(e);
    }
  }
}

/// Reads the `locale` field off the returned `UserView` JSON body.
/// We deliberately don't try to parse the full view here — the
/// repository surface is intentionally narrow.
String _parseLocale(dynamic body) {
  if (body is! Map<String, dynamic>) {
    throw const FormatException('UserView body must be an object.');
  }
  final locale = body['locale'];
  if (locale is! String || locale.isEmpty) {
    throw const FormatException('locale field missing or non-string.');
  }
  return locale;
}
