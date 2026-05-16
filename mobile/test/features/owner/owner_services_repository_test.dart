// EthioLink Mobile — HttpOwnerServicesRepository tests.
//
// Reuses the `_RecordingAdapter` pattern from the other
// owner-side repository tests. Covers:
//
//   * `listServices` GETs `/v1/businesses/{id}/services` and
//     decodes the `ServiceList` envelope into `List<Service>`.
//   * `createService` POSTs to the collection path with the
//     `LocalizedText` name / `description` shape + numeric
//     `durationMinutes` + optional `priceEtb`.
//   * `updateService` PATCHes the resource path; explicit nulls
//     in the request body land for `description` / `priceEtb`
//     clear-paths only.
//   * `deactivateService` DELETEs the resource path and decodes
//     the soft-deleted row.
//   * Error classification for 400/403/404/409/500.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/owner/data/owner_services_repository.dart';

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

String _serviceJson({
  String id = 'svc-1',
  String name = 'Haircut',
  int duration = 30,
  bool active = true,
}) =>
    json.encode({
      'id': id,
      'businessId': 'biz-1',
      'name': {'en': name},
      'description': {'en': 'A nice cut.'},
      'durationMinutes': duration,
      'priceEtb': 250.0,
      'isActive': active,
    });

String _listJson(List<String> items) =>
    json.encode({'items': items.map<dynamic>(json.decode).toList()});

void main() {
  group('HttpOwnerServicesRepository.listServices', () {
    test('GETs /v1/businesses/{id}/services and decodes the list',
        () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _listJson([_serviceJson()])),
      ]);
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      final services = await repo.listServices('biz-1');
      expect(services, hasLength(1));
      expect(services.first.nameEn, 'Haircut');
      expect(services.first.durationMinutes, 30);

      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/businesses/biz-1/services');
    });

    test('404 → kind=notFound', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          404,
          json.encode({
            'error': {'code': 'NOT_FOUND', 'message': 'no biz'},
          }),
        ),
      ]);
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      try {
        await repo.listServices('biz-1');
        fail('expected OwnerServicesFailure');
      } on OwnerServicesFailure catch (e) {
        expect(e.kind, OwnerServicesFailureKind.notFound);
      }
    });
  });

  group('HttpOwnerServicesRepository.createService', () {
    test('POSTs the request body and decodes the response', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _serviceJson()),
      ]);
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      await repo.createService(
        'biz-1',
        const CreateServiceRequest(
          nameEn: 'Haircut',
          durationMinutes: 30,
          descriptionEn: 'A nice cut.',
          priceEtb: 250,
        ),
      );

      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/businesses/biz-1/services');
      final body = req.data as Map<String, dynamic>;
      expect(body['name'], <String, dynamic>{'en': 'Haircut'});
      expect(body['durationMinutes'], 30);
      expect(body['priceEtb'], 250);
      expect(
        body['description'],
        <String, dynamic>{'en': 'A nice cut.'},
      );
    });

    test('omits empty optional fields', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _serviceJson()),
      ]);
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      await repo.createService(
        'biz-1',
        const CreateServiceRequest(
          nameEn: 'Haircut',
          durationMinutes: 30,
          descriptionEn: '',
        ),
      );

      final body = adapter.captured[0].data as Map<String, dynamic>;
      expect(body.containsKey('description'), isFalse);
      expect(body.containsKey('priceEtb'), isFalse);
    });

    test('400 → kind=validation', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          400,
          json.encode({
            'error': {'code': 'VALIDATION_ERROR', 'message': 'bad'},
          }),
        ),
      ]);
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      try {
        await repo.createService(
          'biz-1',
          const CreateServiceRequest(nameEn: 'x', durationMinutes: 30),
        );
        fail('expected OwnerServicesFailure');
      } on OwnerServicesFailure catch (e) {
        expect(e.kind, OwnerServicesFailureKind.validation);
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
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      try {
        await repo.createService(
          'biz-1',
          const CreateServiceRequest(nameEn: 'x', durationMinutes: 30),
        );
        fail('expected OwnerServicesFailure');
      } on OwnerServicesFailure catch (e) {
        expect(e.kind, OwnerServicesFailureKind.forbidden);
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
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      try {
        await repo.createService(
          'biz-1',
          const CreateServiceRequest(nameEn: 'x', durationMinutes: 30),
        );
        fail('expected OwnerServicesFailure');
      } on OwnerServicesFailure catch (e) {
        expect(e.kind, OwnerServicesFailureKind.serverError);
      }
    });
  });

  group('HttpOwnerServicesRepository.updateService', () {
    test('PATCHes the resource path with the populated fields', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _serviceJson()),
      ]);
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      await repo.updateService(
        'biz-1',
        'svc-1',
        const UpdateServiceRequest(
          nameEn: 'Renamed',
          durationMinutes: 45,
          priceEtb: 300,
        ),
      );

      final req = adapter.captured[0];
      expect(req.method, 'PATCH');
      expect(req.path, '/v1/businesses/biz-1/services/svc-1');
      final body = req.data as Map<String, dynamic>;
      expect(body['name'], <String, dynamic>{'en': 'Renamed'});
      expect(body['durationMinutes'], 45);
      expect(body['priceEtb'], 300);
      expect(body.containsKey('description'), isFalse);
    });

    test('clearDescription + clearPrice → explicit null in body', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _serviceJson()),
      ]);
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      await repo.updateService(
        'biz-1',
        'svc-1',
        const UpdateServiceRequest(
          nameEn: 'x',
          durationMinutes: 30,
          clearDescription: true,
          clearPrice: true,
        ),
      );

      final body = adapter.captured[0].data as Map<String, dynamic>;
      expect(body.containsKey('description'), isTrue);
      expect(body['description'], isNull);
      expect(body.containsKey('priceEtb'), isTrue);
      expect(body['priceEtb'], isNull);
    });
  });

  group('HttpOwnerServicesRepository.deactivateService', () {
    test('DELETEs the resource path and decodes the soft-deleted row',
        () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _serviceJson(active: false)),
      ]);
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      final svc = await repo.deactivateService('biz-1', 'svc-1');
      expect(svc.isActive, isFalse);

      final req = adapter.captured[0];
      expect(req.method, 'DELETE');
      expect(req.path, '/v1/businesses/biz-1/services/svc-1');
    });

    test('409 → kind=conflict', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(
          409,
          json.encode({
            'error': {
              'code': 'CONFLICT',
              'message': 'already inactive',
            },
          }),
        ),
      ]);
      final repo = HttpOwnerServicesRepository(_clientFor(adapter));

      try {
        await repo.deactivateService('biz-1', 'svc-1');
        fail('expected OwnerServicesFailure');
      } on OwnerServicesFailure catch (e) {
        expect(e.kind, OwnerServicesFailureKind.conflict);
      }
    });
  });
}
