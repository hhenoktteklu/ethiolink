// EthioLink Mobile — CreateBusinessFlow widget tests.
//
// Covers the four-step wizard end-to-end with an in-memory
// `BusinessActionsRepository` + `CategoriesRepository`. Tests:
//
//   * Happy-path create: fill basics + advance through every
//     step → tap Create → repository invoked with the expected
//     request → success step renders.
//   * Happy-path submit: from the success step, tap "Submit for
//     review" → repository invoked → "Awaiting review" rendered.
//   * Validation: empty required fields surface inline errors on
//     Next; invalid phone surfaces a phone error.
//   * Failure: 409 CONFLICT renders the "already have a business"
//     banner; 403 renders the "access denied" banner; 500 renders
//     the generic retry banner.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/data/categories_repository.dart';
import 'package:ethiolink/features/browse/models/business_detail.dart';
import 'package:ethiolink/features/browse/models/category.dart';
import 'package:ethiolink/features/owner/create_business_flow.dart';
import 'package:ethiolink/features/owner/data/business_actions_repository.dart';
import 'package:ethiolink/features/owner/models/owner_business_view.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

OwnerBusinessView _draftView({String status = 'DRAFT'}) {
  return OwnerBusinessView(
    detail: const BusinessDetail(
      id: 'biz-1',
      categoryId: 'cat-1',
      name: 'Sunset Salon',
      descriptionEn: 'Best in town.',
      descriptionAm: null,
      city: 'Addis Ababa',
      addressLine: null,
      latitude: null,
      longitude: null,
      phone: '+251911000001',
      telegramHandle: null,
      whatsappPhone: null,
      featuredUntil: null,
      ratingAvg: 0,
      ratingCount: 0,
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

class _FakeActionsRepo implements BusinessActionsRepository {
  _FakeActionsRepo({
    this.createResult,
    this.createError,
    this.submitResult,
    this.submitError,
  });

  CreateBusinessRequest? lastCreateRequest;
  String? lastSubmitId;

  OwnerBusinessView? createResult;
  Object? createError;
  OwnerBusinessView? submitResult;
  Object? submitError;

  @override
  Future<OwnerBusinessView> createBusiness(CreateBusinessRequest req) async {
    lastCreateRequest = req;
    if (createError != null) throw createError!;
    return createResult!;
  }

  @override
  Future<OwnerBusinessView> submitBusiness(String id) async {
    lastSubmitId = id;
    if (submitError != null) throw submitError!;
    return submitResult!;
  }
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

Future<void> _pumpFlow(
  WidgetTester tester, {
  required CategoriesRepository categoriesRepo,
  required BusinessActionsRepository actionsRepo,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: CreateBusinessFlow(
          categoriesRepositoryOverride: categoriesRepo,
          actionsRepositoryOverride: actionsRepo,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _fillBasicsAndAdvance(
  WidgetTester tester, {
  String name = 'Sunset Salon',
  String city = 'Addis Ababa',
}) async {
  await tester.enterText(find.byType(TextFormField).at(0), name);
  // Open the dropdown and pick the first option.
  await tester.tap(find.byType(DropdownButtonFormField<String>));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Salon').last);
  await tester.pumpAndSettle();
  await tester.enterText(find.byType(TextFormField).at(1), city);
  await tester.tap(find.widgetWithText(FilledButton, 'Next'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('happy path: create + submit', (tester) async {
    final categoriesRepo = _FakeCategoriesRepo([_cat('cat-1', 'Salon')]);
    final actionsRepo = _FakeActionsRepo(
      createResult: _draftView(status: 'DRAFT'),
      submitResult: _draftView(status: 'PENDING_REVIEW'),
    );
    await _pumpFlow(
      tester,
      categoriesRepo: categoriesRepo,
      actionsRepo: actionsRepo,
    );

    // Step 0: basics.
    await _fillBasicsAndAdvance(tester);

    // Step 1: contact (all optional). Just advance.
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();

    // Step 2: description (optional). Advance.
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();

    // Step 3: review — summary card visible.
    expect(find.text('Review your details'), findsOneWidget);
    expect(find.text('Sunset Salon'), findsOneWidget);
    expect(find.text('Addis Ababa'), findsOneWidget);

    // Tap Create.
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    // Step 4: draft success.
    expect(find.text('Draft saved'), findsOneWidget);
    expect(
      find.widgetWithText(FilledButton, 'Submit for review'),
      findsOneWidget,
    );

    // Repository captured the request.
    final req = actionsRepo.lastCreateRequest!;
    expect(req.categoryId, 'cat-1');
    expect(req.name, 'Sunset Salon');
    expect(req.city, 'Addis Ababa');

    // Tap Submit for review.
    await tester.tap(find.widgetWithText(FilledButton, 'Submit for review'));
    await tester.pumpAndSettle();

    // Step 5: submitted.
    expect(find.text('Awaiting review'), findsOneWidget);
    expect(actionsRepo.lastSubmitId, 'biz-1');
  });

  testWidgets('validation: empty required fields block advance',
      (tester) async {
    final categoriesRepo = _FakeCategoriesRepo([_cat('cat-1', 'Salon')]);
    final actionsRepo = _FakeActionsRepo(
      createResult: _draftView(),
      submitResult: _draftView(status: 'PENDING_REVIEW'),
    );
    await _pumpFlow(
      tester,
      categoriesRepo: categoriesRepo,
      actionsRepo: actionsRepo,
    );

    // Tap Next without filling anything.
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();

    // The two TextFormFields surface their inline errors.
    expect(find.text('Business name is required.'), findsOneWidget);
    expect(find.text('City is required.'), findsOneWidget);

    // Still on the basics step — review-step header not yet shown.
    expect(find.text('Review your details'), findsNothing);
  });

  testWidgets('validation: missing category surfaces the banner',
      (tester) async {
    final categoriesRepo = _FakeCategoriesRepo([_cat('cat-1', 'Salon')]);
    final actionsRepo = _FakeActionsRepo(
      createResult: _draftView(),
      submitResult: _draftView(status: 'PENDING_REVIEW'),
    );
    await _pumpFlow(
      tester,
      categoriesRepo: categoriesRepo,
      actionsRepo: actionsRepo,
    );

    // Fill name + city but skip the category.
    await tester.enterText(
      find.byType(TextFormField).at(0),
      'Sunset Salon',
    );
    await tester.enterText(
      find.byType(TextFormField).at(1),
      'Addis Ababa',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();

    // The top-of-screen banner explains the missing category.
    expect(
      find.textContaining('Pick a category'),
      findsOneWidget,
    );
  });

  testWidgets('validation: invalid phone blocks advance', (tester) async {
    final categoriesRepo = _FakeCategoriesRepo([_cat('cat-1', 'Salon')]);
    final actionsRepo = _FakeActionsRepo(
      createResult: _draftView(),
      submitResult: _draftView(status: 'PENDING_REVIEW'),
    );
    await _pumpFlow(
      tester,
      categoriesRepo: categoriesRepo,
      actionsRepo: actionsRepo,
    );

    await _fillBasicsAndAdvance(tester);

    // On the contact step (step 1). Index 1 is the phone field.
    await tester.enterText(find.byType(TextFormField).at(1), '@@@');
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('Use digits + spaces / hyphens'),
      findsOneWidget,
    );
  });

  testWidgets('conflict: 409 from create renders the "already have one" copy',
      (tester) async {
    final categoriesRepo = _FakeCategoriesRepo([_cat('cat-1', 'Salon')]);
    final actionsRepo = _FakeActionsRepo(
      createError: BusinessActionFailure(
        kind: BusinessActionFailureKind.conflict,
        message: 'owner already has a business',
        statusCode: 409,
        apiErrorCode: 'CONFLICT',
      ),
      submitResult: _draftView(status: 'PENDING_REVIEW'),
    );
    await _pumpFlow(
      tester,
      categoriesRepo: categoriesRepo,
      actionsRepo: actionsRepo,
    );

    await _fillBasicsAndAdvance(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(find.text('You already have a business'), findsOneWidget);
    // Still on the review step (no success header).
    expect(find.text('Draft saved'), findsNothing);
  });

  testWidgets('forbidden: 403 from create renders the access-denied banner',
      (tester) async {
    final categoriesRepo = _FakeCategoriesRepo([_cat('cat-1', 'Salon')]);
    final actionsRepo = _FakeActionsRepo(
      createError: BusinessActionFailure(
        kind: BusinessActionFailureKind.forbidden,
        message: 'role drift',
        statusCode: 403,
        apiErrorCode: 'FORBIDDEN',
      ),
      submitResult: _draftView(status: 'PENDING_REVIEW'),
    );
    await _pumpFlow(
      tester,
      categoriesRepo: categoriesRepo,
      actionsRepo: actionsRepo,
    );

    await _fillBasicsAndAdvance(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(find.text('Access denied'), findsOneWidget);
  });

  testWidgets('serverError: 500 renders the generic retry banner',
      (tester) async {
    final categoriesRepo = _FakeCategoriesRepo([_cat('cat-1', 'Salon')]);
    final actionsRepo = _FakeActionsRepo(
      createError: BusinessActionFailure(
        kind: BusinessActionFailureKind.serverError,
        message: 'boom',
        statusCode: 500,
      ),
      submitResult: _draftView(status: 'PENDING_REVIEW'),
    );
    await _pumpFlow(
      tester,
      categoriesRepo: categoriesRepo,
      actionsRepo: actionsRepo,
    );

    await _fillBasicsAndAdvance(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Next'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Create'));
    await tester.pumpAndSettle();

    expect(find.text('Something went wrong'), findsOneWidget);
  });
}
