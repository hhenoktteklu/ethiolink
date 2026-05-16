// EthioLink Mobile — OwnerTab widget tests.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/models/business_detail.dart';
import 'package:ethiolink/features/owner/data/owner_business_repository.dart';
import 'package:ethiolink/features/owner/models/owner_business_view.dart';
import 'package:ethiolink/features/owner/owner_tab.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

OwnerBusinessView _sampleBusiness({String status = 'APPROVED'}) {
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
      phone: null,
      telegramHandle: null,
      whatsappPhone: null,
      featuredUntil: null,
      ratingAvg: 4.5,
      ratingCount: 10,
    ),
    status: status,
    ownerUserId: 'owner-1',
  );
}

class _FakeRepo implements OwnerBusinessRepository {
  _FakeRepo.value(OwnerBusinessView v) : _completer = (Completer<OwnerBusinessView>()..complete(v));
  _FakeRepo.error(Object e) : _completer = (Completer<OwnerBusinessView>()..completeError(e));
  _FakeRepo.pending() : _completer = Completer<OwnerBusinessView>();
  final Completer<OwnerBusinessView> _completer;

  @override
  Future<OwnerBusinessView> getMine() => _completer.future;
}

Future<void> _pump(
  WidgetTester tester, {
  required OwnerBusinessRepository repo,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: OwnerTab(repositoryOverride: repo),
      ),
    ),
  );
}

void main() {
  testWidgets('renders loading while the fetch is pending', (tester) async {
    final repo = _FakeRepo.pending();
    await _pump(tester, repo: repo);
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    // Settle the pending future cleanly.
    // ignore: invalid_use_of_protected_member
    repo._completer.complete(_sampleBusiness());
    await tester.pumpAndSettle();
  });

  testWidgets('renders the dashboard for an APPROVED business', (tester) async {
    await _pump(
      tester,
      repo: _FakeRepo.value(_sampleBusiness(status: 'APPROVED')),
    );
    await tester.pumpAndSettle();

    expect(find.text('Sunset Salon'), findsOneWidget);
    expect(find.text('APPROVED'), findsOneWidget);
    // Five dashboard cards.
    expect(find.text('Profile'), findsOneWidget);
    expect(find.text('Services'), findsOneWidget);
    expect(find.text('Staff'), findsOneWidget);
    expect(find.text('Availability'), findsOneWidget);
    expect(find.text('Bookings'), findsOneWidget);
    // No status banner on APPROVED.
    expect(find.text('Awaiting review'), findsNothing);
    expect(find.text('Draft'), findsNothing);
  });

  testWidgets('renders the PENDING_REVIEW banner', (tester) async {
    await _pump(
      tester,
      repo: _FakeRepo.value(_sampleBusiness(status: 'PENDING_REVIEW')),
    );
    await tester.pumpAndSettle();

    expect(find.text('Awaiting review'), findsOneWidget);
    expect(find.textContaining('admin is reviewing'), findsOneWidget);
  });

  testWidgets('renders the DRAFT submittable banner', (tester) async {
    await _pump(
      tester,
      repo: _FakeRepo.value(_sampleBusiness(status: 'DRAFT')),
    );
    await tester.pumpAndSettle();

    expect(find.text('Draft'), findsOneWidget);
    expect(find.textContaining('submit for review'), findsOneWidget);
  });

  testWidgets('renders the create-business CTA on 404', (tester) async {
    final repo = _FakeRepo.error(
      OwnerBusinessLoadFailure(
        kind: OwnerBusinessLoadFailureKind.notFound,
        message: 'no business',
        statusCode: 404,
      ),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('No business yet'), findsOneWidget);
    expect(
      find.widgetWithText(FilledButton, 'Create your business'),
      findsOneWidget,
    );
  });

  testWidgets('renders the forbidden banner on 403', (tester) async {
    final repo = _FakeRepo.error(
      OwnerBusinessLoadFailure(
        kind: OwnerBusinessLoadFailureKind.forbidden,
        message: 'role drift',
        statusCode: 403,
      ),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Access denied'), findsOneWidget);
    expect(
      find.textContaining('Sign out and back in'),
      findsOneWidget,
    );
  });

  testWidgets('renders the network error variant with retry', (tester) async {
    final repo = _FakeRepo.error(
      OwnerBusinessLoadFailure(
        kind: OwnerBusinessLoadFailureKind.network,
        message: 'fetch failed',
      ),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text("Can't reach the server"), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
  });
}
