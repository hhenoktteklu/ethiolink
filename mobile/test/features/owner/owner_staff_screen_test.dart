// EthioLink Mobile — OwnerStaffScreen widget tests.
//
// Drives the screen end-to-end against an in-memory
// `OwnerStaffRepository` stub. Mirrors the
// `OwnerServicesScreen` test surface.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/models/staff.dart';
import 'package:ethiolink/features/owner/data/owner_staff_repository.dart';
import 'package:ethiolink/features/owner/owner_staff_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

Staff _staff({
  String id = 'staff-1',
  String name = 'Selam Tadesse',
  String? role = 'Senior Stylist',
  bool active = true,
}) {
  return Staff(
    id: id,
    businessId: 'biz-1',
    displayName: name,
    role: role,
    isActive: active,
  );
}

class _FakeRepo implements OwnerStaffRepository {
  _FakeRepo({
    List<Staff>? initial,
    this.listError,
    this.createError,
    this.updateError,
    this.deactivateError,
  }) : _items = [...?initial];

  final List<Staff> _items;
  Object? listError;
  Object? createError;
  Object? updateError;
  Object? deactivateError;

  CreateStaffRequest? lastCreate;
  UpdateStaffRequest? lastUpdate;
  String? lastDeactivateId;

  @override
  Future<List<Staff>> listStaff(String businessId) async {
    if (listError != null) throw listError!;
    return List.unmodifiable(_items);
  }

  @override
  Future<Staff> createStaff(
    String businessId,
    CreateStaffRequest req,
  ) async {
    lastCreate = req;
    if (createError != null) throw createError!;
    final created = _staff(
      id: 'staff-new',
      name: req.displayName,
      role: req.role,
    );
    _items.add(created);
    return created;
  }

  @override
  Future<Staff> updateStaff(
    String businessId,
    String staffId,
    UpdateStaffRequest req,
  ) async {
    lastUpdate = req;
    if (updateError != null) throw updateError!;
    final idx = _items.indexWhere((s) => s.id == staffId);
    final updated = _staff(
      id: staffId,
      name: req.displayName ?? _items[idx].displayName,
      role: req.clearRole ? null : (req.role ?? _items[idx].role),
      active: _items[idx].isActive,
    );
    _items[idx] = updated;
    return updated;
  }

  @override
  Future<Staff> deactivateStaff(
    String businessId,
    String staffId,
  ) async {
    lastDeactivateId = staffId;
    if (deactivateError != null) throw deactivateError!;
    final idx = _items.indexWhere((s) => s.id == staffId);
    final removed = _items[idx];
    _items.removeAt(idx);
    return _staff(
      id: removed.id,
      name: removed.displayName,
      role: removed.role,
      active: false,
    );
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required OwnerStaffRepository repo,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: OwnerStaffScreen(
          businessId: 'biz-1',
          repositoryOverride: repo,
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('renders the empty state when no staff exist', (tester) async {
    await _pump(tester, repo: _FakeRepo());
    await tester.pumpAndSettle();

    expect(find.text('No staff yet'), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsOneWidget);
  });

  testWidgets('renders the list of staff', (tester) async {
    final repo = _FakeRepo(initial: [
      _staff(name: 'Selam Tadesse', role: 'Senior Stylist'),
      _staff(id: 'staff-2', name: 'Daniel Mekonnen', role: 'Barber'),
    ]);
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Selam Tadesse'), findsOneWidget);
    expect(find.text('Daniel Mekonnen'), findsOneWidget);
    expect(find.text('Senior Stylist'), findsOneWidget);
    expect(find.text('Barber'), findsOneWidget);
  });

  testWidgets('renders the error state on a list failure', (tester) async {
    final repo = _FakeRepo()
      ..listError = OwnerStaffFailure(
        kind: OwnerStaffFailureKind.network,
        message: 'no network',
      );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text("Can't reach the server"), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
  });

  testWidgets('create: happy path posts the request and refreshes the list',
      (tester) async {
    final repo = _FakeRepo();
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();
    expect(find.text('Add staff'), findsAtLeastNWidgets(1));

    final nameField = find.byType(TextFormField).at(0);
    final roleField = find.byType(TextFormField).at(1);
    await tester.enterText(nameField, 'Helen Yohannes');
    await tester.enterText(roleField, 'Therapist');

    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(repo.lastCreate, isNotNull);
    expect(repo.lastCreate!.displayName, 'Helen Yohannes');
    expect(repo.lastCreate!.role, 'Therapist');

    // The new row is in the list.
    expect(find.text('Helen Yohannes'), findsOneWidget);
    expect(find.text('Therapist'), findsOneWidget);
  });

  testWidgets('create: validation blocks submit when displayName is empty',
      (tester) async {
    final repo = _FakeRepo();
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(find.text('Display name is required.'), findsOneWidget);
    expect(repo.lastCreate, isNull);
  });

  testWidgets('edit: tapping a row opens the form pre-filled and PATCHes',
      (tester) async {
    final repo = _FakeRepo(initial: [
      _staff(name: 'Selam Tadesse', role: 'Senior Stylist'),
    ]);
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.text('Selam Tadesse'));
    await tester.pumpAndSettle();

    expect(find.text('Edit staff member'), findsOneWidget);

    final nameField = find.byType(TextFormField).at(0);
    final roleField = find.byType(TextFormField).at(1);
    await tester.enterText(nameField, 'Selam T.');
    await tester.enterText(roleField, 'Lead Stylist');

    await tester.tap(find.widgetWithText(FilledButton, 'Save changes'));
    await tester.pumpAndSettle();

    expect(repo.lastUpdate, isNotNull);
    expect(repo.lastUpdate!.displayName, 'Selam T.');
    expect(repo.lastUpdate!.role, 'Lead Stylist');
    expect(repo.lastUpdate!.clearRole, isFalse);

    expect(find.text('Selam T.'), findsOneWidget);
  });

  testWidgets('edit: clearing the role sends clearRole=true',
      (tester) async {
    final repo = _FakeRepo(initial: [
      _staff(name: 'Selam Tadesse', role: 'Senior Stylist'),
    ]);
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.text('Selam Tadesse'));
    await tester.pumpAndSettle();

    // Clear the role field.
    await tester.enterText(find.byType(TextFormField).at(1), '');
    await tester.tap(find.widgetWithText(FilledButton, 'Save changes'));
    await tester.pumpAndSettle();

    expect(repo.lastUpdate!.clearRole, isTrue);
  });

  testWidgets('deactivate: confirm dialog → repository called → list refreshes',
      (tester) async {
    final repo = _FakeRepo(initial: [
      _staff(name: 'Selam Tadesse', role: 'Senior Stylist'),
    ]);
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.delete_outline));
    await tester.pumpAndSettle();

    expect(find.text('Deactivate staff member?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Deactivate'));
    await tester.pumpAndSettle();

    expect(repo.lastDeactivateId, 'staff-1');
    expect(find.text('Selam Tadesse'), findsNothing);
    expect(find.text('No staff yet'), findsOneWidget);
  });

  testWidgets('create: 403 renders the access-denied banner',
      (tester) async {
    final repo = _FakeRepo()
      ..createError = OwnerStaffFailure(
        kind: OwnerStaffFailureKind.forbidden,
        message: 'role drift',
        statusCode: 403,
        apiErrorCode: 'FORBIDDEN',
      );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).at(0), 'X');
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(find.text('Access denied'), findsOneWidget);
  });
}
