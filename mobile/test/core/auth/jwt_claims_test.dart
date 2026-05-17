// EthioLink Mobile — id-token claim decoder tests.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/auth/jwt_claims.dart';

/// Build a fake JWT (`header.payload.signature`). Only the
/// payload segment is consumed by `decodeIdTokenClaims` — the
/// header + signature are placeholders.
String makeIdToken(Map<String, dynamic> payload) {
  String b64(Map<String, dynamic> obj) =>
      base64Url.encode(utf8.encode(json.encode(obj))).replaceAll('=', '');
  return '${b64({"alg": "RS256"})}.${b64(payload)}.signature-placeholder';
}

void main() {
  group('decodeIdTokenClaims', () {
    test('parses sub + email + groups + exp', () {
      final token = makeIdToken({
        'sub': '11111111-1111-1111-1111-111111111111',
        'email': 'test@example.com',
        'cognito:groups': ['CUSTOMER'],
        // Digit-separator literals (1_800_000_000) require Dart 3.6+;
        // analyzer pinned to the older language version flagged them
        // as syntax errors. Plain integers compile under every
        // supported toolchain.
        'exp': 1800000000,
      });
      final claims = decodeIdTokenClaims(token);
      expect(claims.sub, '11111111-1111-1111-1111-111111111111');
      expect(claims.email, 'test@example.com');
      expect(claims.groups, ['CUSTOMER']);
      expect(claims.expiresAt.isUtc, isTrue);
    });

    test('treats missing email as empty', () {
      final token = makeIdToken({
        'sub': 'sub-x',
        'exp': 1700000000,
      });
      final claims = decodeIdTokenClaims(token);
      expect(claims.email, '');
      expect(claims.groups, isEmpty);
    });

    test('throws when sub is missing', () {
      final token = makeIdToken({'exp': 1});
      expect(() => decodeIdTokenClaims(token), throwsFormatException);
    });

    test('throws on a non-3-segment token', () {
      expect(
        () => decodeIdTokenClaims('not-a-jwt'),
        throwsFormatException,
      );
    });
  });

  group('pickRole', () {
    test('ADMIN beats BUSINESS_OWNER beats CUSTOMER', () {
      expect(
        pickRole(['CUSTOMER', 'ADMIN', 'BUSINESS_OWNER']),
        'ADMIN',
      );
      expect(pickRole(['CUSTOMER', 'BUSINESS_OWNER']), 'BUSINESS_OWNER');
      expect(pickRole(['CUSTOMER']), 'CUSTOMER');
    });

    test('falls back to CUSTOMER when no groups', () {
      expect(pickRole(<String>[]), 'CUSTOMER');
    });
  });
}
