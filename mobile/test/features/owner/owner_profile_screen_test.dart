// EthioLink Mobile — OwnerProfileScreen widget tests.
//
// Covers:
//
//   * Pre-fill: every form field is populated from the loaded
//     `OwnerBusinessView`.
//   * Validation: empty required fields surface inline errors.
//   * Save happy-path: PATCH request body carries the updated
//     fields + the category dropdown picks the chosen id.
//   * Clearing an optional field encodes as explicit `null` so
//     the server clears the column.
//   * 403 / 409 / 500 surface the matching inline banner.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/data/categories_repository.dart';
import 'package:ethiolink/features/browse/models/business_detail.dart';
import 'package:ethiolink/features/browse/models/category.dart';
import 'package:ethiolink/features/owner/data/business_actions_repository.dart';
import 'package:ethiolink/features/owner/models/owner_business_view.dart';
import 'package:ethiolink/features/owner/owner_profile_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

OwnerBusinessView _view({
  String name = 'Sunset Salon',
  String city = 'Addis Ababa',
  String? address = '123 Bole St',
  String? phone = '+251911000001',
  String? telegram = '@sunset',
  String? whatsapp = '+251911000002',
  String? description = 'Best in town.',
  String categoryId = 'cat-1',
  String status = 'APPROVED',
}) {
  return OwnerBusinessView(
    detail: BusinessDetail(
      id: 'biz-1',
      categoryId: categoryId,
      name: name,
      descriptionEn: description,
      descriptionAm: null,
      city: city,
      addressLine: address,
      latitude: null,
      longitude: null,
      phone: phone,
      telegramHandle: telegram,
      whatsappPhone: whatsapp,
      featuredUntil: null,
      ratingAvg: 4.5,
      ratingCount: 10,
    ),
    status: status,
    ownerUserId: 'owner-1',
  );
}

class _FakeCategoriesRepo implements CategoriesRepository {
  _FakeCategoriesRepo(this.items);
  final List<Category> items;
  @override
  Future<List<Category>> list() async => items;
}

Category _cat(String id, String name) {
  return Category(
    id: id,
    slug: name.toLowerCase(),
    nameEn: name,
    nameAm: null,
    sortOrder: 1,
  );
}

class _FakeActionsRepo implements BusinessActionsRepository {
  _FakeActionsRepo({this.updateResult, this.updateError});
  PatchBusinessRequest? lastUpdate;
  String? lastUpdateId;
  OwnerBusinessView? updateResult;
  Object? updateError;

  @override
  Future<OwnerBusinessView> createBusiness(CreateBusinessRequest req) async =>
      throw UnimplementedError();
  @override
  Future<OwnerBusinessView> submitBusiness(String id) async =>
      throw UnimplementedError();
  @override
  Future<OwnerBusinessView> updateBusiness(
    String businessId,
    PatchBusinessRequest req,
  ) async {
    lastUpdateId = businessId;
    lastUpdate = req;
    if (updateError != null) throw updateError!;
    return updateResult!;
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required OwnerBusinessView business,
  required BusinessActionsRepository actionsRepo,
  required CategoriesRepository categoriesRepo,
}) async {
  // The profile editor lives in a `ListView` with 7 `TextFormField`s
  // (name, city, address, phone, telegram handle, whatsapp,
  // description) plus a category picker and Save button. Flutter's
  // default test viewport (800×600) was too short for the
  // underlying `SliverList` to instantiate all of them, which
  // dropped the whatsapp + description fields from the rendered
  // Element tree (the assertion `expect(values.length, 7)` was
  // seeing only 5). A taller viewport keeps every form row
  // mounted so `find.byType(TextFormField).at(N)` resolves the
  // expected indexes, and `ensureVisible(saveBtn)` doesn't have
  // to scroll past unbuilt slivers.
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: OwnerProfileScreen(
          business: business,
          actionsRepositoryOverride: actionsRepo,
          categoriesRepositoryOverride: categoriesRepo,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('pre-fills every form field from the OwnerBusinessView',
      (tester) async {
    await _pump(
      tester,
      business: _view(),
      actionsRepo: _FakeActionsRepo(updateResult: _view()),
      categoriesRepo: _FakeCategoriesRepo([_cat('cat-1', 'Salon')]),
    );

    final fields = tester.widgetList<TextFormField>(find.byType(TextFormField));
    final values =
        fields.map((f) => f.controller?.text).whereType<String>().toList();
    // Order: name, city, address, phone, telegram, whatsapp, description.
    expect(values, [
      'Sunset Salon',
      'Addis Ababa',
      '123 Bole St',
      '+251911000001',
      '@sunset',
      '+251911000002',
      'Best in town.',
    ]);
  });

  testWidgets('save: happy path PATCHes with the updated fields',
      (tester) async {
    final actions = _FakeActionsRepo(updateResult: _view(name: 'Renamed'));
    await _pump(
      tester,
      business: _view(),
      actionsRepo: actions,
      categoriesRepo: _FakeCategoriesRepo([_cat('cat-1', 'Salon')]),
    );

    // Edit the name.
    await tester.enterText(find.byType(TextFormField).at(0), 'Renamed');

    final saveBtn = find.widgetWithText(FilledButton, 'Save changes');
    await tester.ensureVisible(saveBtn);
    await tester.pumpAndSettle();
    await tester.tap(saveBtn);
    await tester.pumpAndSettle();

    expect(actions.lastUpdateId, 'biz-1');
    expect(actions.lastUpdate, isNotNull);
    expect(actions.lastUpdate!.name, 'Renamed');
    expect(actions.lastUpdate!.categoryId, 'cat-1');
    expect(actions.lastUpdate!.city, 'Addis Ababa');
  });

  testWidgets('clearing an optional field sets the clear flag',
      (tester) async {
    final actions = _FakeActionsRepo(updateResult: _view());
    await _pump(
      tester,
      business: _view(),
      actionsRepo: actions,
      categoriesRepo: _FakeCategoriesRepo([_cat('cat-1', 'Salon')]),
    );

    // Clear the telegram handle field (index 4).
    await tester.enterText(find.byType(TextFormField).at(4), '');

    final saveBtn = find.widgetWithText(FilledButton, 'Save changes');
    await tester.ensureVisible(saveBtn);
    await tester.pumpAndSettle();
    await tester.tap(saveBtn);
    await tester.pumpAndSettle();

    expect(actions.lastUpdate!.clearTelegram, isTrue);
    expect(actions.lastUpdate!.toJson()['telegramHandle'], isNull);
  });

  testWidgets('validation: empty name + city block save', (tester) async {
    final actions = _FakeActionsRepo(updateResult: _view());
    await _pump(
      tester,
      business: _view(),
      actionsRepo: actions,
      categoriesRepo: _FakeCategoriesRepo([_cat('cat-1', 'Salon')]),
    );

    await tester.enterText(find.byType(TextFormField).at(0), ''); // name
    await tester.enterText(find.byType(TextFormField).at(1), ''); // city

    final saveBtn = find.widgetWithText(FilledButton, 'Save changes');
    await tester.ensureVisible(saveBtn);
    await tester.pumpAndSettle();
    await tester.tap(saveBtn);
    await tester.pumpAndSettle();

    expect(find.text('Business name is required.'), findsOneWidget);
    expect(find.text('City is required.'), findsOneWidget);
    expect(actions.lastUpdate, isNull);
  });

  testWidgets('validation: invalid phone blocks save', (tester) async {
    final actions = _FakeActionsRepo(updateResult: _view());
    await _pump(
      tester,
      business: _view(),
      actionsRepo: actions,
      categoriesRepo: _FakeCategoriesRepo([_cat('cat-1', 'Salon')]),
    );

    // Phone is field index 3.
    await tester.enterText(find.byType(TextFormField).at(3), '@@@');

    final saveBtn = find.widgetWithText(FilledButton, 'Save changes');
    await tester.ensureVisible(saveBtn);
    await tester.pumpAndSettle();
    await tester.tap(saveBtn);
    await tester.pumpAndSettle();

    expect(
      find.textContaining('Use digits + spaces / hyphens'),
      findsOneWidget,
    );
    expect(actions.lastUpdate, isNull);
  });

  testWidgets('403 from the API renders the access-denied banner',
      (tester) async {
    final actions = _FakeActionsRepo(
      updateError: BusinessActionFailure(
        kind: BusinessActionFailureKind.forbidden,
        message: 'role drift',
        statusCode: 403,
        apiErrorCode: 'FORBIDDEN',
      ),
    );
    await _pump(
      tester,
      business: _view(),
      actionsRepo: actions,
      categoriesRepo: _FakeCategoriesRepo([_cat('cat-1', 'Salon')]),
    );

    final saveBtn = find.widgetWithText(FilledButton, 'Save changes');
    await tester.ensureVisible(saveBtn);
    await tester.pumpAndSettle();
    await tester.tap(saveBtn);
    await tester.pumpAndSettle();

    expect(find.text('Access denied'), findsOneWidget);
  });

  testWidgets('409 renders the conflicting-state banner', (tester) async {
    final actions = _FakeActionsRepo(
      updateError: BusinessActionFailure(
        kind: BusinessActionFailureKind.conflict,
        message: 'state conflict',
        statusCode: 409,
        apiErrorCode: 'CONFLICT',
      ),
    );
    await _pump(
      tester,
      business: _view(),
      actionsRepo: actions,
      categoriesRepo: _FakeCategoriesRepo([_cat('cat-1', 'Salon')]),
    );

    final saveBtn = find.widgetWithText(FilledButton, 'Save changes');
    await tester.ensureVisible(saveBtn);
    await tester.pumpAndSettle();
    await tester.tap(saveBtn);
    await tester.pumpAndSettle();

    expect(find.text('Conflicting state'), findsOneWidget);
  });

  testWidgets('500 renders the generic retry banner', (tester) async {
    final actions = _FakeActionsRepo(
      updateError: BusinessActionFailure(
        kind: BusinessActionFailureKind.serverError,
        message: 'boom',
        statusCode: 500,
      ),
    );
    await _pump(
      tester,
      business: _view(),
      actionsRepo: actions,
      categoriesRepo: _FakeCategoriesRepo([_cat('cat-1', 'Salon')]),
    );

    final saveBtn = find.widgetWithText(FilledButton, 'Save changes');
    await tester.ensureVisible(saveBtn);
    await tester.pumpAndSettle();
    await tester.tap(saveBtn);
    await tester.pumpAndSettle();

    expect(find.text('Something went wrong'), findsOneWidget);
  });
}
