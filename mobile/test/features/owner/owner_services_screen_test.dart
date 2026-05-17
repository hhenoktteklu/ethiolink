// EthioLink Mobile — OwnerServicesScreen widget tests.
//
// Drives the screen end-to-end against an in-memory
// `OwnerServicesRepository` stub. Verifies the four operations
// + validation + error rendering.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/models/service.dart';
import 'package:ethiolink/features/owner/data/owner_services_repository.dart';
import 'package:ethiolink/features/owner/owner_services_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

Service _svc({
  String id = 'svc-1',
  String name = 'Haircut',
  int duration = 30,
  double? price = 250,
  bool active = true,
  String? description,
}) {
  return Service(
    id: id,
    businessId: 'biz-1',
    nameEn: name,
    descriptionEn: description,
    durationMinutes: duration,
    priceEtb: price,
    isActive: active,
  );
}

class _FakeRepo implements OwnerServicesRepository {
  _FakeRepo({
    List<Service>? initial,
  }) : _items = [...?initial];

  final List<Service> _items;
  // Each `*Error` is mutated via cascade assignment in the
  // matching failure-path test (`..listError = ...`, etc.). The
  // fields stay public; the constructor parameters were unused
  // (no test sets them through the constructor) so we drop them.
  Object? listError;
  Object? createError;
  Object? updateError;
  Object? deactivateError;

  CreateServiceRequest? lastCreate;
  UpdateServiceRequest? lastUpdate;
  String? lastDeactivateId;

  @override
  Future<List<Service>> listServices(String businessId) async {
    if (listError != null) throw listError!;
    return List.unmodifiable(_items);
  }

  @override
  Future<Service> createService(
    String businessId,
    CreateServiceRequest req,
  ) async {
    lastCreate = req;
    if (createError != null) throw createError!;
    final created = _svc(
      id: 'svc-new',
      name: req.nameEn,
      duration: req.durationMinutes,
      price: req.priceEtb,
      description: req.descriptionEn,
    );
    _items.add(created);
    return created;
  }

  @override
  Future<Service> updateService(
    String businessId,
    String serviceId,
    UpdateServiceRequest req,
  ) async {
    lastUpdate = req;
    if (updateError != null) throw updateError!;
    final idx = _items.indexWhere((s) => s.id == serviceId);
    final updated = _svc(
      id: serviceId,
      name: req.nameEn ?? _items[idx].nameEn,
      duration: req.durationMinutes ?? _items[idx].durationMinutes,
      price: req.clearPrice ? null : (req.priceEtb ?? _items[idx].priceEtb),
      description: req.clearDescription
          ? null
          : (req.descriptionEn ?? _items[idx].descriptionEn),
      active: _items[idx].isActive,
    );
    _items[idx] = updated;
    return updated;
  }

  @override
  Future<Service> deactivateService(
    String businessId,
    String serviceId,
  ) async {
    lastDeactivateId = serviceId;
    if (deactivateError != null) throw deactivateError!;
    final idx = _items.indexWhere((s) => s.id == serviceId);
    final removed = _items[idx];
    // Mirror the API: soft-delete by removing from the listing.
    _items.removeAt(idx);
    return _svc(
      id: removed.id,
      name: removed.nameEn,
      duration: removed.durationMinutes,
      price: removed.priceEtb,
      description: removed.descriptionEn,
      active: false,
    );
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required OwnerServicesRepository repo,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: OwnerServicesScreen(
          businessId: 'biz-1',
          repositoryOverride: repo,
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('renders the empty state when no services exist',
      (tester) async {
    await _pump(tester, repo: _FakeRepo());
    await tester.pumpAndSettle();

    expect(find.text('No services yet'), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsOneWidget);
  });

  testWidgets('renders the list of services', (tester) async {
    final repo = _FakeRepo(initial: [
      _svc(name: 'Haircut', duration: 30, price: 250),
      _svc(id: 'svc-2', name: 'Manicure', duration: 45, price: 400),
    ]);
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Haircut'), findsOneWidget);
    expect(find.text('Manicure'), findsOneWidget);
    expect(find.text('30 min · 250 ETB'), findsOneWidget);
    expect(find.text('45 min · 400 ETB'), findsOneWidget);
  });

  testWidgets('renders the error state on a list failure', (tester) async {
    final repo = _FakeRepo()
      ..listError = OwnerServicesFailure(
        kind: OwnerServicesFailureKind.network,
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

    // Open the form.
    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();
    expect(find.text('Add service'), findsAtLeastNWidgets(1));

    // Fill in the form.
    final nameField = find.byType(TextFormField).at(0);
    final durationField = find.byType(TextFormField).at(1);
    final priceField = find.byType(TextFormField).at(2);
    await tester.enterText(nameField, 'Massage');
    await tester.enterText(durationField, '60');
    await tester.enterText(priceField, '800');

    // Submit.
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(repo.lastCreate, isNotNull);
    expect(repo.lastCreate!.nameEn, 'Massage');
    expect(repo.lastCreate!.durationMinutes, 60);
    expect(repo.lastCreate!.priceEtb, 800);

    // The new row is now in the list.
    expect(find.text('Massage'), findsOneWidget);
    expect(find.text('60 min · 800 ETB'), findsOneWidget);
  });

  testWidgets('create: validation errors block submit', (tester) async {
    final repo = _FakeRepo();
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();

    // Submit empty.
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(find.text('Service name is required.'), findsOneWidget);
    expect(find.text('Duration is required.'), findsOneWidget);
    expect(repo.lastCreate, isNull);
  });

  testWidgets('create: invalid duration blocks submit', (tester) async {
    final repo = _FakeRepo();
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(0), 'X');
    await tester.enterText(find.byType(TextFormField).at(1), '0');
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(find.text('Duration must be greater than 0.'), findsOneWidget);
    expect(repo.lastCreate, isNull);
  });

  testWidgets('create: negative price blocks submit', (tester) async {
    final repo = _FakeRepo();
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(0), 'X');
    await tester.enterText(find.byType(TextFormField).at(1), '30');
    await tester.enterText(find.byType(TextFormField).at(2), '-10');
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(find.text('Price must be 0 or more.'), findsOneWidget);
    expect(repo.lastCreate, isNull);
  });

  testWidgets('edit: tapping a row opens the form pre-filled and PATCHes',
      (tester) async {
    final repo = _FakeRepo(initial: [
      _svc(name: 'Haircut', duration: 30, price: 250, description: 'A nice cut'),
    ]);
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    // Tap the row.
    await tester.tap(find.text('Haircut'));
    await tester.pumpAndSettle();

    // The form opens with "Edit service" title.
    expect(find.text('Edit service'), findsOneWidget);

    // Update the name + duration.
    final nameField = find.byType(TextFormField).at(0);
    final durationField = find.byType(TextFormField).at(1);
    await tester.enterText(nameField, 'Cut + Style');
    await tester.enterText(durationField, '45');

    await tester.tap(find.widgetWithText(FilledButton, 'Save changes'));
    await tester.pumpAndSettle();

    expect(repo.lastUpdate, isNotNull);
    expect(repo.lastUpdate!.nameEn, 'Cut + Style');
    expect(repo.lastUpdate!.durationMinutes, 45);

    // The list re-renders with the updated row.
    expect(find.text('Cut + Style'), findsOneWidget);
  });

  testWidgets('deactivate: confirm dialog → repository called → list refreshes',
      (tester) async {
    final repo = _FakeRepo(initial: [
      _svc(name: 'Haircut', duration: 30, price: 250),
    ]);
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    // Tap the trash icon.
    await tester.tap(find.byIcon(Icons.delete_outline));
    await tester.pumpAndSettle();

    // Confirm.
    expect(find.text('Deactivate service?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Deactivate'));
    await tester.pumpAndSettle();

    expect(repo.lastDeactivateId, 'svc-1');
    // Row no longer in the listing.
    expect(find.text('Haircut'), findsNothing);
    expect(find.text('No services yet'), findsOneWidget);
  });

  testWidgets('create: 403 from the API renders the access-denied banner',
      (tester) async {
    final repo = _FakeRepo()
      ..createError = OwnerServicesFailure(
        kind: OwnerServicesFailureKind.forbidden,
        message: 'role drift',
        statusCode: 403,
        apiErrorCode: 'FORBIDDEN',
      );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField).at(0), 'Haircut');
    await tester.enterText(find.byType(TextFormField).at(1), '30');
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(find.text('Access denied'), findsOneWidget);
  });
}
