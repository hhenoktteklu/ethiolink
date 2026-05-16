// EthioLink Mobile — HttpOwnerStaffRepository tests.
//
// Reuses the `_RecordingAdapter` pattern from the other owner-
// side repository tests. Covers:
//
//   * `listStaff` GETs `/v1/businesses/{id}/staff` and decodes
//     the `StaffList` envelope into `List<Staff>`.
//   * `createStaff` POSTs to the collection path with the
//     `{ displayName, role? }` shape.
//   * `updateStaff` PATCHes the resource path; `clearRole`
//     produces an explicit `null` in the body.
//   * `deactivateStaff` DELETEs the resource path and decodes
//     the soft-deleted row.
//   * Error classification for 400 / 403 / 404 / 409 / 500.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/api/api_client.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/features/owner/data/owner_staff_repository.dart';

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

String _staffJson({
  String id = 'staff-1',
  String name = 'Selam Tadesse',
  String? role = 'Senior Stylist',
  bool active = true,
}) =>
    json.encode({
      'id': id,
      'businessId': 'biz-1',
      'displayName': name,
      'role': role,
      'isActive': active,
    });

String _listJson(List<String> items) =>
    json.encode({'items': items.map<dynamic>(json.decode).toList()});

void main() {
  group('HttpOwnerStaffRepository.listStaff', () {
    test('GETs /v1/businesses/{id}/staff and decodes the list', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _listJson([_staffJson()])),
      ]);
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      final staff = await repo.listStaff('biz-1');
      expect(staff, hasLength(1));
      expect(staff.first.displayName, 'Selam Tadesse');
      expect(staff.first.role, 'Senior Stylist');

      final req = adapter.captured[0];
      expect(req.method, 'GET');
      expect(req.path, '/v1/businesses/biz-1/staff');
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
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      try {
        await repo.listStaff('biz-1');
        fail('expected OwnerStaffFailure');
      } on OwnerStaffFailure catch (e) {
        expect(e.kind, OwnerStaffFailureKind.notFound);
      }
    });
  });

  group('HttpOwnerStaffRepository.createStaff', () {
    test('POSTs the request body and decodes the response', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _staffJson()),
      ]);
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      await repo.createStaff(
        'biz-1',
        const CreateStaffRequest(
          displayName: 'Selam Tadesse',
          role: 'Senior Stylist',
        ),
      );

      final req = adapter.captured[0];
      expect(req.method, 'POST');
      expect(req.path, '/v1/businesses/biz-1/staff');
      final body = req.data as Map<String, dynamic>;
      expect(body['displayName'], 'Selam Tadesse');
      expect(body['role'], 'Senior Stylist');
    });

    test('omits empty role', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _staffJson()),
      ]);
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      await repo.createStaff(
        'biz-1',
        const CreateStaffRequest(displayName: 'Selam Tadesse'),
      );

      final body = adapter.captured[0].data as Map<String, dynamic>;
      expect(body.containsKey('role'), isFalse);
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
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      try {
        await repo.createStaff(
          'biz-1',
          const CreateStaffRequest(displayName: 'X'),
        );
        fail('expected OwnerStaffFailure');
      } on OwnerStaffFailure catch (e) {
        expect(e.kind, OwnerStaffFailureKind.validation);
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
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      try {
        await repo.createStaff(
          'biz-1',
          const CreateStaffRequest(displayName: 'X'),
        );
        fail('expected OwnerStaffFailure');
      } on OwnerStaffFailure catch (e) {
        expect(e.kind, OwnerStaffFailureKind.forbidden);
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
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      try {
        await repo.createStaff(
          'biz-1',
          const CreateStaffRequest(displayName: 'X'),
        );
        fail('expected OwnerStaffFailure');
      } on OwnerStaffFailure catch (e) {
        expect(e.kind, OwnerStaffFailureKind.serverError);
      }
    });
  });

  group('HttpOwnerStaffRepository.updateStaff', () {
    test('PATCHes the resource path with populated fields', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _staffJson()),
      ]);
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      await repo.updateStaff(
        'biz-1',
        'staff-1',
        const UpdateStaffRequest(
          displayName: 'Renamed',
          role: 'Lead',
        ),
      );

      final req = adapter.captured[0];
      expect(req.method, 'PATCH');
      expect(req.path, '/v1/businesses/biz-1/staff/staff-1');
      final body = req.data as Map<String, dynamic>;
      expect(body['displayName'], 'Renamed');
      expect(body['role'], 'Lead');
    });

    test('clearRole → explicit null in body', () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _staffJson(role: null)),
      ]);
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      await repo.updateStaff(
        'biz-1',
        'staff-1',
        const UpdateStaffRequest(displayName: 'X', clearRole: true),
      );

      final body = adapter.captured[0].data as Map<String, dynamic>;
      expect(body.containsKey('role'), isTrue);
      expect(body['role'], isNull);
    });
  });

  group('HttpOwnerStaffRepository.deactivateStaff', () {
    test('DELETEs the resource path and decodes the soft-deleted row',
        () async {
      final adapter = _RecordingAdapter([
        _AdapterResponse(200, _staffJson(active: false)),
      ]);
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      final staff = await repo.deactivateStaff('biz-1', 'staff-1');
      expect(staff.isActive, isFalse);

      final req = adapter.captured[0];
      expect(req.method, 'DELETE');
      expect(req.path, '/v1/businesses/biz-1/staff/staff-1');
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
      final repo = HttpOwnerStaffRepository(_clientFor(adapter));

      try {
        await repo.deactivateStaff('biz-1', 'staff-1');
        fail('expected OwnerStaffFailure');
      } on OwnerStaffFailure catch (e) {
        expect(e.kind, OwnerStaffFailureKind.conflict);
      }
    });
  });
}
