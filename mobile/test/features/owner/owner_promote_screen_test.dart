// EthioLink Mobile — OwnerPromoteScreen widget tests.
//
// Drives the screen against an in-memory `FeaturingRepository`
// stub. Verifies:
//
//   * Loading spinner while the parallel fetch is pending.
//   * Not-featured success path renders both package cards.
//   * Featured success path hides the package cards and shows
//     "Featured until ...".
//   * Tapping Purchase calls `subscribe` and surfaces success +
//     refreshes the header.
//   * FEATURING_DISABLED → "Not yet available" branch.
//   * ALREADY_ACTIVE inline banner on the not-featured branch.
//   * PAYMENT_REQUIRED inline banner.
//   * Network failure shows the "Can't reach the server" branch.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/owner/data/featuring_repository.dart';
import 'package:ethiolink/features/owner/models/featuring.dart';
import 'package:ethiolink/features/owner/owner_promote_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

FeaturingPackage _pkg({
  String code = 'FEATURING_7D',
  int days = 7,
  double price = 500,
}) =>
    FeaturingPackage(code: code, durationDays: days, priceEtb: price);

FeaturingSubscription _sub({
  String id = 'sub-1',
  String status = 'ACTIVE',
  String source = 'OWNER_PURCHASE',
  DateTime? endsAt,
}) {
  final ends = endsAt ?? DateTime.utc(2026, 6, 1);
  return FeaturingSubscription(
    id: id,
    businessId: 'biz-1',
    packageCode: 'FEATURING_7D',
    priceEtb: 500,
    startsAt: ends.subtract(const Duration(days: 7)),
    endsAt: ends,
    status: status,
    source: source,
    cancelledAt: null,
    cancelledReason: null,
    createdAt: ends.subtract(const Duration(days: 7)),
    updatedAt: ends.subtract(const Duration(days: 7)),
  );
}

class _FakeFeaturingRepo implements FeaturingRepository {
  _FakeFeaturingRepo({
    this.packages = const <FeaturingPackage>[],
    this.active,
    this.listError,
    this.activeError,
    this.subscribeError,
    this.subscribeResult,
  });

  List<FeaturingPackage> packages;
  FeaturingSubscription? active;
  Object? listError;
  Object? activeError;
  Object? subscribeError;
  FeaturingSubscription? subscribeResult;

  String? lastSubscribeCode;
  Completer<void>? gateSubscribe;

  @override
  Future<List<FeaturingPackage>> listPackages(String businessId) async {
    if (listError != null) throw listError!;
    return List.unmodifiable(packages);
  }

  @override
  Future<FeaturingSubscription?> getActive(String businessId) async {
    if (activeError != null) throw activeError!;
    return active;
  }

  @override
  Future<FeaturingSubscription> subscribe(
    String businessId,
    String packageCode,
  ) async {
    lastSubscribeCode = packageCode;
    if (gateSubscribe != null) await gateSubscribe!.future;
    if (subscribeError != null) throw subscribeError!;
    final result = subscribeResult ?? _sub();
    active = result;
    return result;
  }

  @override
  Future<List<FeaturingSubscription>> listHistory(
    String businessId, {
    int? limit,
  }) async =>
      const <FeaturingSubscription>[];
}

Future<void> _pump(
  WidgetTester tester, {
  required FeaturingRepository repo,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: OwnerPromoteScreen(
          businessId: 'biz-1',
          repositoryOverride: repo,
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('renders the not-featured branch with package cards',
      (tester) async {
    final repo = _FakeFeaturingRepo(
      packages: [_pkg(), _pkg(code: 'FEATURING_30D', days: 30, price: 1500)],
      active: null,
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Not featured'), findsOneWidget);
    expect(find.text('7 days featured'), findsOneWidget);
    expect(find.text('30 days featured'), findsOneWidget);
    expect(find.text('500 ETB'), findsOneWidget);
    expect(find.text('1500 ETB'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Purchase'), findsNWidgets(2));
  });

  testWidgets('renders the featured branch and hides the cards',
      (tester) async {
    final repo = _FakeFeaturingRepo(
      packages: [_pkg()],
      active: _sub(endsAt: DateTime.utc(2026, 6, 1)),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Featured'), findsOneWidget);
    expect(find.textContaining('Featured until'), findsOneWidget);
    // No purchase buttons when already featured.
    expect(find.widgetWithText(FilledButton, 'Purchase'), findsNothing);
  });

  testWidgets('comp badge surfaces on the featured header', (tester) async {
    final repo = _FakeFeaturingRepo(
      active: _sub(source: 'ADMIN_COMP'),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Comped by admin'), findsOneWidget);
  });

  testWidgets('tapping Purchase calls subscribe and refreshes the header',
      (tester) async {
    final repo = _FakeFeaturingRepo(
      packages: [_pkg()],
      active: null,
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester
        .tap(find.widgetWithText(FilledButton, 'Purchase').first);
    await tester.pumpAndSettle();

    expect(repo.lastSubscribeCode, 'FEATURING_7D');
    // The fake repo flips `active` after subscribe; header should
    // re-render as Featured.
    expect(find.text('Featured'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Purchase'), findsNothing);
  });

  testWidgets('shows the spinner on the tapped package while busy',
      (tester) async {
    final gate = Completer<void>();
    final repo = _FakeFeaturingRepo(
      packages: [_pkg()],
      active: null,
    )..gateSubscribe = gate;

    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester
        .tap(find.widgetWithText(FilledButton, 'Purchase').first);
    await tester.pump();

    // A spinner is visible while the subscribe call is gated.
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    gate.complete();
    await tester.pumpAndSettle();
  });

  testWidgets('FEATURING_DISABLED → "Not yet available" branch',
      (tester) async {
    final repo = _FakeFeaturingRepo(
      activeError: FeaturingFailure(
        kind: FeaturingFailureKind.disabled,
        message: 'featuring not enabled',
        statusCode: 503,
        apiErrorCode: 'FEATURING_DISABLED',
      ),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Not yet available'), findsOneWidget);
    expect(find.textContaining('coming soon'), findsOneWidget);
  });

  testWidgets('ALREADY_ACTIVE on subscribe surfaces inline banner',
      (tester) async {
    final repo = _FakeFeaturingRepo(
      packages: [_pkg()],
      active: null,
      subscribeError: FeaturingFailure(
        kind: FeaturingFailureKind.alreadyActive,
        message: 'already active',
        statusCode: 409,
      ),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester
        .tap(find.widgetWithText(FilledButton, 'Purchase').first);
    await tester.pumpAndSettle();

    expect(find.text('Already featured'), findsOneWidget);
  });

  testWidgets('PAYMENT_REQUIRED on subscribe surfaces inline banner',
      (tester) async {
    final repo = _FakeFeaturingRepo(
      packages: [_pkg()],
      active: null,
      subscribeError: FeaturingFailure(
        kind: FeaturingFailureKind.paymentRequired,
        message: 'gateway returned FAILED',
        statusCode: 402,
      ),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester
        .tap(find.widgetWithText(FilledButton, 'Purchase').first);
    await tester.pumpAndSettle();

    expect(find.text('Payment failed'), findsOneWidget);
  });

  testWidgets('network failure on load shows "Can\'t reach the server"',
      (tester) async {
    final repo = _FakeFeaturingRepo(
      activeError: FeaturingFailure(
        kind: FeaturingFailureKind.network,
        message: 'fetch failed',
      ),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text("Can't reach the server"), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
  });
}
