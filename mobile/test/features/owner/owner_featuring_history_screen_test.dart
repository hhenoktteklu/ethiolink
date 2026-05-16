// EthioLink Mobile — OwnerFeaturingHistoryScreen widget tests.
//
// Verifies:
//
//   * Empty state when the API returns no rows.
//   * Populated list renders the rows + COMPED / PURCHASED chips.
//   * Network failure surfaces the retry banner.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/owner/data/featuring_repository.dart';
import 'package:ethiolink/features/owner/models/featuring.dart';
import 'package:ethiolink/features/owner/owner_featuring_history_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

FeaturingSubscription _sub({
  String id = 'sub-1',
  String status = 'EXPIRED',
  String source = 'OWNER_PURCHASE',
  String? cancelledReason,
}) {
  final ends = DateTime.utc(2026, 4, 1);
  return FeaturingSubscription(
    id: id,
    businessId: 'biz-1',
    packageCode: 'FEATURING_7D',
    priceEtb: 500,
    startsAt: ends.subtract(const Duration(days: 7)),
    endsAt: ends,
    status: status,
    source: source,
    cancelledAt: status == 'CANCELLED' ? ends : null,
    cancelledReason: cancelledReason,
    createdAt: ends.subtract(const Duration(days: 7)),
    updatedAt: ends.subtract(const Duration(days: 7)),
  );
}

class _FakeRepo implements FeaturingRepository {
  _FakeRepo({this.rows = const <FeaturingSubscription>[], this.error});
  List<FeaturingSubscription> rows;
  Object? error;

  @override
  Future<List<FeaturingSubscription>> listHistory(
    String businessId, {
    int? limit,
  }) async {
    if (error != null) throw error!;
    return List.unmodifiable(rows);
  }

  @override
  Future<List<FeaturingPackage>> listPackages(String businessId) async =>
      const <FeaturingPackage>[];
  @override
  Future<FeaturingSubscription?> getActive(String businessId) async => null;
  @override
  Future<FeaturingSubscription> subscribe(
    String businessId,
    String packageCode,
  ) async =>
      throw UnimplementedError('not used');
}

Future<void> _pump(WidgetTester tester, {required FeaturingRepository repo}) {
  return tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: OwnerFeaturingHistoryScreen(
          businessId: 'biz-1',
          repositoryOverride: repo,
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('renders empty state when no history rows', (tester) async {
    await _pump(tester, repo: _FakeRepo());
    await tester.pumpAndSettle();

    expect(find.text('No featuring history yet'), findsOneWidget);
  });

  testWidgets('renders rows + PURCHASED/COMPED chips', (tester) async {
    await _pump(
      tester,
      repo: _FakeRepo(rows: [
        _sub(),
        _sub(id: 'sub-2', status: 'ACTIVE', source: 'ADMIN_COMP'),
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.text('FEATURING_7D'), findsNWidgets(2));
    expect(find.text('PURCHASED'), findsOneWidget);
    expect(find.text('COMPED'), findsOneWidget);
    expect(find.text('EXPIRED'), findsOneWidget);
    expect(find.text('ACTIVE'), findsOneWidget);
  });

  testWidgets('cancelled rows show the reason', (tester) async {
    await _pump(
      tester,
      repo: _FakeRepo(rows: [
        _sub(
          status: 'CANCELLED',
          cancelledReason: 'Admin took it down',
        ),
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('Admin took it down'), findsOneWidget);
  });

  testWidgets('network failure shows the retry banner', (tester) async {
    await _pump(
      tester,
      repo: _FakeRepo(
        error: FeaturingFailure(
          kind: FeaturingFailureKind.network,
          message: 'fetch failed',
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("Can't reach the server"), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
  });
}
