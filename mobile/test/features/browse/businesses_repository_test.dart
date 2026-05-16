// EthioLink Mobile — HttpBusinessesRepository tests.
//
// Uses a custom `HttpClientAdapter` that records every request
// and returns a scriptable response, so we can assert on:
//
//   * The path Dio actually called.
//   * The query parameters Dio serialized (category / cursor /
//     limit are conditional).
//   * That repository translates a captured 4xx / 5xx body into
//     `BusinessesLoadFailure`.
//
// Mirrors the unit-test pattern from the backend's
// `paymentGateways.test.ts` — capture the call shape, don't
// hit the network.

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/browse/data/businesses_repository.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

/// Token provider that never returns a token — keeps the
/// `Authorization` header off the captured request.
class _NoTokenProvider implements TokenProvider {
  const _NoTokenProvider();
  @override
  Future<String?> currentIdToken() async => null;
  @override
  Future<String?> refresh() async => null;
}

/// Recording adapter. Captures every call and replays a scripted
/// `ResponseBody` so the repository thinks it talked to the real
/// API.
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
    if (responses.isEmpty) {
      throw StateError('No more scripted responses');
    }
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
  group('HttpBusinessesRepository.list — URL + query', () {
    test('issues GET /v1/businesses with no params when filters are null',
        () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, json.encode({'items': [], 'nextCursor': null})),
      ]);
      final repo = HttpBusinessesRepository(_clientFor(adapter));

      await repo.list();

      expect(adapter.captured, hasLength(1));
      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/businesses');
      // Dio leaves queryParameters as a Map; empty filters → empty/null.
      expect(req.queryParameters, isEmpty);
    });

    test('passes category, cursor, and limit when provided', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, json.encode({'items': [], 'nextCursor': null})),
      ]);
      final repo = HttpBusinessesRepository(_clientFor(adapter));

      await repo.list(category: 'salon', cursor: 'cur-1', limit: 20);

      final req = adapter.captured[0];
      expect(req.queryParameters['category'], 'salon');
      expect(req.queryParameters['cursor'], 'cur-1');
      expect(req.queryParameters['limit'], 20);
    });

    test('drops empty-string category and cursor', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, json.encode({'items': [], 'nextCursor': null})),
      ]);
      final repo = HttpBusinessesRepository(_clientFor(adapter));

      await repo.list(category: '', cursor: '');

      final req = adapter.captured[0];
      expect(req.queryParameters, isEmpty);
    });
  });

  group('HttpBusinessesRepository.list — error translation', () {
    test('translates a 5xx into BusinessesLoadFailure with statusCode', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(500, json.encode({'error': {'code': 'INTERNAL_ERROR', 'message': 'boom'}})),
      ]);
      final repo = HttpBusinessesRepository(_clientFor(adapter));

      try {
        await repo.list(category: 'salon');
        fail('expected BusinessesLoadFailure');
      } on BusinessesLoadFailure catch (e) {
        expect(e.statusCode, 500);
        expect(e.isNetworkError, isFalse);
      }
    });

    test('translates a malformed body into BusinessesLoadFailure', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, json.encode({'items': 'not-a-list'})),
      ]);
      final repo = HttpBusinessesRepository(_clientFor(adapter));

      try {
        await repo.list(category: 'salon');
        fail('expected BusinessesLoadFailure');
      } on BusinessesLoadFailure catch (e) {
        expect(e.message, contains('malformed'));
        expect(e.isNetworkError, isFalse);
      }
    });
  });

  group('HttpBusinessesRepository.list — Phase 9 Track 6 search params', () {
    test('passes q, city, ratingMin, featuredOnly, and sort verbatim',
        () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode({'items': [], 'nextCursor': null}),
        ),
      ]);
      final repo = HttpBusinessesRepository(_clientFor(adapter));

      await repo.list(
        q: 'habesha',
        city: 'Addis Ababa',
        ratingMin: 4.0,
        featuredOnly: true,
        sort: BusinessSort.relevance,
      );

      final req = adapter.captured.single;
      expect(req.path, '/v1/businesses');
      expect(req.queryParameters['q'], 'habesha');
      expect(req.queryParameters['city'], 'Addis Ababa');
      expect(req.queryParameters['ratingMin'], 4.0);
      expect(req.queryParameters['featuredOnly'], 'true');
      expect(req.queryParameters['sort'], 'relevance');
    });

    test('trims and drops whitespace-only q + city', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode({'items': [], 'nextCursor': null}),
        ),
      ]);
      final repo = HttpBusinessesRepository(_clientFor(adapter));

      await repo.list(q: '   ', city: '\t');

      final req = adapter.captured.single;
      expect(req.queryParameters.containsKey('q'), isFalse);
      expect(req.queryParameters.containsKey('city'), isFalse);
    });

    test('omits featuredOnly when false (preserves backwards-compat shape)',
        () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          200,
          json.encode({'items': [], 'nextCursor': null}),
        ),
      ]);
      final repo = HttpBusinessesRepository(_clientFor(adapter));

      await repo.list(q: 'habesha', featuredOnly: false);

      final req = adapter.captured.single;
      expect(req.queryParameters['q'], 'habesha');
      expect(req.queryParameters.containsKey('featuredOnly'), isFalse);
    });

    test('emits sort=rating / sort=newest / sort=featured wire values',
        () async {
      for (final pair in [
        [BusinessSort.rating, 'rating'],
        [BusinessSort.newest, 'newest'],
        [BusinessSort.featured, 'featured'],
      ]) {
        final adapter = _RecordingAdapter([
          _AdapterResponse(
            200,
            json.encode({'items': [], 'nextCursor': null}),
          ),
        ]);
        final repo = HttpBusinessesRepository(_clientFor(adapter));
        await repo.list(q: 'habesha', sort: pair[0] as BusinessSort);
        expect(
          adapter.captured.single.queryParameters['sort'],
          pair[1] as String,
        );
      }
    });
  });
}
