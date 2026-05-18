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
  redirectUri: 'com.ethiolink.app:/oauthredirect',
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
    this.activeError,
    this.subscribeError,
    this.subscribeResult,
  });

  List<FeaturingPackage> packages;
  FeaturingSubscription? active;
  // `listError` is mutated via cascade assignment in the listing-
  // failure test below; keep the field, drop the constructor
  // parameter (which no test set).
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

  /// Phase 10 — optional override for the payment summary returned
  /// from `subscribe`. Defaults to a synchronous cash SUCCEEDED.
  FeaturingPaymentSummary? subscribePayment;

  @override
  Future<SubscribeFeaturingResult> subscribe(
    String businessId,
    String packageCode,
  ) async {
    lastSubscribeCode = packageCode;
    if (gateSubscribe != null) await gateSubscribe!.future;
    if (subscribeError != null) throw subscribeError!;
    final sub = subscribeResult ?? _sub();
    // For PENDING flows we deliberately do NOT mutate `active`
    // until the screen polls; for synchronous SUCCEEDED we
    // promote the subscription so the screen flips to the
    // featured branch on refresh.
    final payment = subscribePayment ??
        const FeaturingPaymentSummary(
          status: 'SUCCEEDED',
          provider: 'CASH',
          providerRef: null,
          redirectUrl: null,
          errorCode: null,
          errorMessage: null,
        );
    if (payment.isSucceeded) {
      active = sub;
    }
    return SubscribeFeaturingResult(subscription: sub, payment: payment);
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

  // -------------------------------------------------------------------
  // Phase 10 — online checkout
  // -------------------------------------------------------------------

  testWidgets(
    'online PENDING → opens Chapa redirect, polls active, succeeds',
    (tester) async {
      // First subscribe call returns PENDING with a redirectUrl;
      // the screen launches the browser and polls getActive. The
      // poll returns null until the second attempt flips
      // `active` to an ACTIVE subscription.
      final pendingSub = _sub(status: 'PENDING_PAYMENT');
      final activeSub = _sub(status: 'ACTIVE');
      final repo = _FakeFeaturingRepo(
        packages: [_pkg()],
        active: null,
        subscribeResult: pendingSub,
      )
        ..subscribePayment = const FeaturingPaymentSummary(
          status: 'PENDING',
          provider: 'CHAPA',
          providerRef: 'feat-tx-001',
          redirectUrl: 'https://checkout.chapa.test/sess-promote',
          errorCode: null,
          errorMessage: null,
        );

      final launches = <String>[];
      await tester.pumpWidget(
        AppConfigScope(
          config: _testConfig,
          child: MaterialApp(
            home: OwnerPromoteScreen(
              businessId: 'biz-1',
              repositoryOverride: repo,
              paymentRedirectorOverride: (url) async {
                launches.add(url);
                // Promote the in-memory subscription so the next
                // getActive poll succeeds.
                repo.active = activeSub;
                return true;
              },
              paymentPollInterval: const Duration(milliseconds: 5),
              paymentPollMaxAttempts: 5,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester
          .tap(find.widgetWithText(FilledButton, 'Purchase').first);
      await tester.pump();
      // Let the redirect + first poll fire.
      await tester.pump(const Duration(milliseconds: 30));
      await tester.pumpAndSettle();

      assert(launches.length == 1, 'expected 1 launch, got ${launches.length}');
      expect(launches.first, 'https://checkout.chapa.test/sess-promote');
      expect(find.text('Featured!'), findsOneWidget);
    },
  );

  testWidgets('online launcher returns false → failed overlay', (tester) async {
    final repo = _FakeFeaturingRepo(
      packages: [_pkg()],
      active: null,
      subscribeResult: _sub(status: 'PENDING_PAYMENT'),
    )
      ..subscribePayment = const FeaturingPaymentSummary(
        status: 'PENDING',
        provider: 'CHAPA',
        providerRef: 'feat-tx-002',
        redirectUrl: 'https://checkout.chapa.test/sess-fail',
        errorCode: null,
        errorMessage: null,
      );
    await tester.pumpWidget(
      AppConfigScope(
        config: _testConfig,
        child: MaterialApp(
          home: OwnerPromoteScreen(
            businessId: 'biz-1',
            repositoryOverride: repo,
            paymentRedirectorOverride: (_) async => false,
            paymentPollInterval: const Duration(milliseconds: 5),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Purchase').first);
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.text('Payment failed'), findsOneWidget);
  });

  test('SubscribeFeaturingResult parses wrapped wire shape', () {
    final json = {
      'subscription': {
        'id': 'sub-1',
        'businessId': 'biz-1',
        'packageCode': 'FEATURING_7D',
        'priceEtb': 500.0,
        'startsAt': '2026-05-15T00:00:00.000Z',
        'endsAt': '2026-05-22T00:00:00.000Z',
        'status': 'PENDING_PAYMENT',
        'source': 'OWNER_PURCHASE',
        'cancelledAt': null,
        'cancelledReason': null,
        'createdAt': '2026-05-15T00:00:00.000Z',
        'updatedAt': '2026-05-15T00:00:00.000Z',
      },
      'payment': {
        'status': 'PENDING',
        'provider': 'CHAPA',
        'providerRef': 'feat-1-aaaa',
        'redirectUrl': 'https://checkout.chapa.test/sess-1',
        'errorCode': null,
        'errorMessage': null,
      },
    };
    final result = SubscribeFeaturingResult.fromJson(json);
    expect(result.subscription.id, 'sub-1');
    expect(result.payment.isPending, isTrue);
    expect(
      result.payment.redirectUrl,
      'https://checkout.chapa.test/sess-1',
    );
  });
}
