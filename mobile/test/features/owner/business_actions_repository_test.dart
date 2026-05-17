// EthioLink Mobile — HttpBusinessActionsRepository tests.
//
// Mirrors the `_RecordingAdapter` pattern from
// `owner_business_repository_test.dart` and the booking-flow
// repository tests. Verifies:
//
//   * `createBusiness` POSTs `/v1/businesses` with the request
//     body shape `{ categoryId, name, description: {en}, city,
//     phone, telegramHandle, whatsappPhone, addressLine }`,
//     decodes the response into an `OwnerBusinessView`, and
//     classifies common error responses.
//
//   * `submitBusiness` POSTs `/v1/businesses/{id}/submit` with no
//     body, decodes the response, and classifies the 409 source-
//     status-mismatch case.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/owner/data/business_actions_repository.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
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

String _draftJson({String status = 'DRAFT'}) => json.encode({
      'id': 'biz-1',
      'categoryId': 'cat-1',
      'name': 'Sunset Salon',
      'description': {'en': 'Best in town.'},
      'city': 'Addis Ababa',
      'addressLine': null,
      'latitude': null,
      'longitude': null,
      'phone': '+251911000001',
      'telegramHandle': null,
      'whatsappPhone': null,
      'featuredUntil': null,
      'ratingAvg': 0,
      'ratingCount': 0,
      'status': status,
      'ownerUserId': 'owner-1',
      'createdAt': '2026-05-01T00:00:00.000Z',
      'updatedAt': '2026-05-01T00:00:00.000Z',
    });

void main() {
  group('HttpBusinessActionsRepository.createBusiness', () {
    test('POSTs /v1/businesses with the expected body', () async {
      final adapter = _RecordingAdapter([_AdapterResponse(200, _draftJson())]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      final view = await repo.createBusiness(
        const CreateBusinessRequest(
          categoryId: 'cat-1',
          name: 'Sunset Salon',
          descriptionEn: 'Best in town.',
          city: 'Addis Ababa',
          phone: '+251911000001',
          telegramHandle: '@sunset',
        ),
      );

      // Response decoded.
      expect(view.id, 'biz-1');
      expect(view.status, 'DRAFT');

      // Request shape captured.
      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/businesses');
      final body = req.data as Map<String, dynamic>;
      expect(body['categoryId'], 'cat-1');
      expect(body['name'], 'Sunset Salon');
      expect(body['description'], <String, dynamic>{'en': 'Best in town.'});
      expect(body['city'], 'Addis Ababa');
      expect(body['phone'], '+251911000001');
      expect(body['telegramHandle'], '@sunset');
      // Optional fields not supplied → not present in the body.
      expect(body.containsKey('whatsappPhone'), isFalse);
      expect(body.containsKey('addressLine'), isFalse);
    });

    test('omits empty optional fields', () async {
      final adapter = _RecordingAdapter([_AdapterResponse(200, _draftJson())]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      await repo.createBusiness(
        const CreateBusinessRequest(
          categoryId: 'cat-1',
          name: 'Sunset Salon',
          city: 'Addis Ababa',
          phone: '',
          telegramHandle: '',
          whatsappPhone: '',
          descriptionEn: '',
          addressLine: '',
        ),
      );

      final body = adapter.captured[0].data as Map<String, dynamic>;
      expect(body.keys, containsAll(<String>['categoryId', 'name', 'city']));
      expect(body.containsKey('phone'), isFalse);
      expect(body.containsKey('description'), isFalse);
      expect(body.containsKey('addressLine'), isFalse);
    });

    test('400 → kind=validation', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          400,
          json.encode({
            'error': {'code': 'VALIDATION_ERROR', 'message': 'bad body'},
          }),
        ),
      ]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      try {
        await repo.createBusiness(
          const CreateBusinessRequest(categoryId: 'cat-1'),
        );
        fail('expected BusinessActionFailure');
      } on BusinessActionFailure catch (e) {
        expect(e.kind, BusinessActionFailureKind.validation);
        expect(e.statusCode, 400);
      }
    });

    test('403 → kind=forbidden', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          403,
          json.encode({
            'error': {'code': 'FORBIDDEN', 'message': 'role drift'},
          }),
        ),
      ]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      try {
        await repo.createBusiness(
          const CreateBusinessRequest(categoryId: 'cat-1'),
        );
        fail('expected BusinessActionFailure');
      } on BusinessActionFailure catch (e) {
        expect(e.kind, BusinessActionFailureKind.forbidden);
      }
    });

    test('409 → kind=conflict (already have a business)', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          409,
          json.encode({
            'error': {
              'code': 'CONFLICT',
              'message': 'owner already has a business',
            },
          }),
        ),
      ]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      try {
        await repo.createBusiness(
          const CreateBusinessRequest(categoryId: 'cat-1'),
        );
        fail('expected BusinessActionFailure');
      } on BusinessActionFailure catch (e) {
        expect(e.kind, BusinessActionFailureKind.conflict);
      }
    });

    test('500 → kind=serverError', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          500,
          json.encode({
            'error': {'code': 'INTERNAL_ERROR', 'message': 'boom'},
          }),
        ),
      ]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      try {
        await repo.createBusiness(
          const CreateBusinessRequest(categoryId: 'cat-1'),
        );
        fail('expected BusinessActionFailure');
      } on BusinessActionFailure catch (e) {
        expect(e.kind, BusinessActionFailureKind.serverError);
      }
    });
  });

  group('HttpBusinessActionsRepository.submitBusiness', () {
    test('POSTs /v1/businesses/{id}/submit and decodes the view', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _draftJson(status: 'PENDING_REVIEW')),
      ]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      final view = await repo.submitBusiness('biz-1');
      expect(view.status, 'PENDING_REVIEW');

      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/businesses/biz-1/submit');
    });

    test('409 → kind=conflict (source status not submittable)', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          409,
          json.encode({
            'error': {
              'code': 'CONFLICT',
              'message': 'source status APPROVED is not submittable',
            },
          }),
        ),
      ]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      try {
        await repo.submitBusiness('biz-1');
        fail('expected BusinessActionFailure');
      } on BusinessActionFailure catch (e) {
        expect(e.kind, BusinessActionFailureKind.conflict);
      }
    });

    test('400 → kind=validation (missing required fields)', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          400,
          json.encode({
            'error': {
              'code': 'VALIDATION_ERROR',
              'message': 'business is missing required fields',
              'details': {
                'missing': ['name', 'city'],
              },
            },
          }),
        ),
      ]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      try {
        await repo.submitBusiness('biz-1');
        fail('expected BusinessActionFailure');
      } on BusinessActionFailure catch (e) {
        expect(e.kind, BusinessActionFailureKind.validation);
      }
    });
  });

  group('HttpBusinessActionsRepository.updateBusiness', () {
    test('PATCHes /v1/businesses/{id} with populated fields', () async {
      final adapter = _RecordingAdapter([_AdapterResponse(200, _draftJson())]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      await repo.updateBusiness(
        'biz-1',
        const PatchBusinessRequest(
          categoryId: 'cat-1',
          name: 'Renamed',
          city: 'Addis Ababa',
          descriptionEn: 'Best in town.',
          phone: '+251911000001',
        ),
      );

      final req = adapter.captured[0];
      expect(req.method, 'PATCH');
      expect(req.path, '/v1/businesses/biz-1');
      final body = req.data as Map<String, dynamic>;
      expect(body['categoryId'], 'cat-1');
      expect(body['name'], 'Renamed');
      expect(body['city'], 'Addis Ababa');
      expect(body['description'], <String, dynamic>{'en': 'Best in town.'});
      expect(body['phone'], '+251911000001');
      // Untouched optional fields stay absent.
      expect(body.containsKey('addressLine'), isFalse);
      expect(body.containsKey('telegramHandle'), isFalse);
      expect(body.containsKey('whatsappPhone'), isFalse);
    });

    test('clear flags encode optional fields as explicit null', () async {
      final adapter = _RecordingAdapter([_AdapterResponse(200, _draftJson())]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      await repo.updateBusiness(
        'biz-1',
        const PatchBusinessRequest(
          categoryId: 'cat-1',
          name: 'X',
          city: 'Y',
          clearDescription: true,
          clearAddress: true,
          clearPhone: true,
          clearTelegram: true,
          clearWhatsapp: true,
        ),
      );

      final body = adapter.captured[0].data as Map<String, dynamic>;
      for (final key in const [
        'description',
        'addressLine',
        'phone',
        'telegramHandle',
        'whatsappPhone',
      ]) {
        expect(body.containsKey(key), isTrue, reason: '$key key missing');
        expect(body[key], isNull, reason: '$key should be null');
      }
    });

    test('403 → kind=forbidden', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          403,
          json.encode({
            'error': {'code': 'FORBIDDEN', 'message': 'not owner'},
          }),
        ),
      ]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      try {
        await repo.updateBusiness(
          'biz-1',
          const PatchBusinessRequest(categoryId: 'cat-1'),
        );
        fail('expected BusinessActionFailure');
      } on BusinessActionFailure catch (e) {
        expect(e.kind, BusinessActionFailureKind.forbidden);
      }
    });

    test('409 → kind=conflict', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          409,
          json.encode({
            'error': {'code': 'CONFLICT', 'message': 'category mismatch'},
          }),
        ),
      ]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      try {
        await repo.updateBusiness(
          'biz-1',
          const PatchBusinessRequest(categoryId: 'cat-2'),
        );
        fail('expected BusinessActionFailure');
      } on BusinessActionFailure catch (e) {
        expect(e.kind, BusinessActionFailureKind.conflict);
      }
    });

    test('500 → kind=serverError', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          500,
          json.encode({
            'error': {'code': 'INTERNAL_ERROR', 'message': 'boom'},
          }),
        ),
      ]);
      final repo = HttpBusinessActionsRepository(_clientFor(adapter));

      try {
        await repo.updateBusiness(
          'biz-1',
          const PatchBusinessRequest(categoryId: 'cat-1'),
        );
        fail('expected BusinessActionFailure');
      } on BusinessActionFailure catch (e) {
        expect(e.kind, BusinessActionFailureKind.serverError);
      }
    });
  });
}
