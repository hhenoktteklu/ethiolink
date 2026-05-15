// EthioLink Mobile — minimal id-token claim decoder.
//
// The Cognito id token is a standard JWS with three
// base64url-encoded segments separated by `.`. We only need the
// middle segment (payload claims) on the client; the API enforces
// signature verification on its side via `aws-jwt-verify`. The
// client is the consumer, not the verifier.
//
// This file is intentionally tiny — it does ONE thing
// (`decodeIdTokenClaims`) and avoids pulling in `package:dart_jsonwebtoken`
// or `package:jose` solely for a base64 decode + JSON parse.
//
// If a future commit moves to client-side signature verification
// (we currently don't), swap this for a real JWT library and the
// call-site interface stays the same.

import 'dart:convert';

/// Decoded subset of the Cognito id-token payload the app actually
/// reads. `cognito:groups` lands as `groups` (renamed for Dart
/// idiom); `exp` is converted to a `DateTime` (the token uses
/// Unix-seconds).
class IdTokenClaims {
  const IdTokenClaims({
    required this.sub,
    required this.email,
    required this.groups,
    required this.expiresAt,
  });

  /// Cognito user `sub`. Stable across email/phone changes; the
  /// backend uses this to look up the `users` row.
  final String sub;

  /// Email claim. May be empty when the user signed up with phone
  /// only (Cognito allows either).
  final String email;

  /// Cognito groups the user belongs to. The app picks the
  /// highest-precedence one (ADMIN > BUSINESS_OWNER > CUSTOMER)
  /// when displaying role; the backend does the same mapping.
  final List<String> groups;

  /// Unix-seconds expiry. The token renewer refreshes ~5 minutes
  /// before this.
  final DateTime expiresAt;
}

/// Decode the payload (middle) segment of a JWS-encoded id token.
/// Throws `FormatException` when the token is structurally
/// invalid; the caller is expected to treat any throw here as a
/// "treat the session as missing" signal.
IdTokenClaims decodeIdTokenClaims(String idToken) {
  final segments = idToken.split('.');
  if (segments.length != 3) {
    throw const FormatException(
      'Cognito id token must have exactly 3 segments.',
    );
  }
  final payloadJson = utf8.decode(
    base64Url.decode(_padBase64(segments[1])),
  );
  final dynamic decoded = json.decode(payloadJson);
  if (decoded is! Map<String, dynamic>) {
    throw const FormatException(
      'Cognito id token payload must decode to a JSON object.',
    );
  }

  final sub = decoded['sub'];
  if (sub is! String || sub.isEmpty) {
    throw const FormatException(
      'Cognito id token payload missing `sub` claim.',
    );
  }

  final email = decoded['email'];
  final dynamic groupsClaim = decoded['cognito:groups'];
  final groups = <String>[];
  if (groupsClaim is List) {
    for (final g in groupsClaim) {
      if (g is String && g.isNotEmpty) groups.add(g);
    }
  }

  final exp = decoded['exp'];
  if (exp is! int) {
    throw const FormatException(
      'Cognito id token payload missing integer `exp` claim.',
    );
  }

  return IdTokenClaims(
    sub: sub,
    email: email is String ? email : '',
    groups: groups,
    expiresAt: DateTime.fromMillisecondsSinceEpoch(
      exp * 1000,
      isUtc: true,
    ),
  );
}

/// `base64Url.decode` is strict about padding. Cognito tokens omit
/// the `=` pad characters per RFC 7515; re-add them before
/// decoding.
String _padBase64(String input) {
  final remainder = input.length % 4;
  if (remainder == 0) return input;
  return input + ('=' * (4 - remainder));
}

/// Pick the highest-precedence role from a Cognito groups list.
/// Mirrors the backend's `ROLE_PRECEDENCE` ordering
/// (`ADMIN > BUSINESS_OWNER > CUSTOMER`) so the client and server
/// agree on what role a multi-group user has.
String pickRole(List<String> groups) {
  if (groups.contains('ADMIN')) return 'ADMIN';
  if (groups.contains('BUSINESS_OWNER')) return 'BUSINESS_OWNER';
  return 'CUSTOMER';
}
