// EthioLink Mobile — AdminReviewQueueScreen widget tests.
//
// Pins the mobile review-queue UX:
//
//   * Empty state when the backend returns no pending rows.
//   * Pending businesses render as cards with Approve / Reject
//     actions.
//   * Tapping Approve calls the repository's approve(id).
//   * Tapping Reject opens a dialog; submitting WITHOUT a reason
//     surfaces an inline error and does NOT close the dialog;
//     submitting WITH a reason calls reject(id, notes=<reason>).
//
// The widget uses the role theme via the surrounding shell in
// production; the test pumps it as a standalone MaterialApp.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/admin/admin_review_queue_screen.dart';
import 'package:ethiolink/features/admin/data/admin_businesses_repository.dart';
import 'package:ethiolink/features/browse/models/business_detail.dart';
import 'package:ethiolink/features/owner/models/owner_business_view.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
);

OwnerBusinessView _pending({
  String id = 'biz-1',
  String name = 'Sunset Salon',
  String city = 'Addis Ababa',
}) {
  return OwnerBusinessView(
    detail: BusinessDetail(
      id: id,
      categoryId: 'cat-1',
      name: name,
      descriptionEn: 'A test salon.',
      descriptionAm: null,
      city: city,
      addressLine: null,
      latitude: null,
      longitude: null,
      phone: null,
      telegramHandle: null,
      whatsappPhone: null,
      featuredUntil: null,
      ratingAvg: 0,
      ratingCount: 0,
    ),
    status: 'PENDING_REVIEW',
    ownerUserId: 'owner-1',
  );
}

class _RecordingRepo implements AdminBusinessesRepository {
  _RecordingRepo({this.initial = const <OwnerBusinessView>[]});

  final List<OwnerBusinessView> initial;
  String? lastApprovedId;
  String? lastRejectedId;
  String? lastRejectedNotes;
  int listCalls = 0;

  @override
  Future<List<OwnerBusinessView>> list({
    String status = 'PENDING_REVIEW',
    int? limit,
  }) async {
    listCalls += 1;
    return initial;
  }

  @override
  Future<OwnerBusinessView> approve(String id, {String? notes}) async {
    lastApprovedId = id;
    return initial.firstWhere((b) => b.id == id);
  }

  @override
  Future<OwnerBusinessView> reject(
    String id, {
    required String notes,
  }) async {
    lastRejectedId = id;
    lastRejectedNotes = notes;
    return initial.firstWhere((b) => b.id == id);
  }
}

class _PendingRepo implements AdminBusinessesRepository {
  @override
  Future<List<OwnerBusinessView>> list({
    String status = 'PENDING_REVIEW',
    int? limit,
  }) =>
      Completer<List<OwnerBusinessView>>().future;
  @override
  Future<OwnerBusinessView> approve(String id, {String? notes}) =>
      throw UnimplementedError();
  @override
  Future<OwnerBusinessView> reject(String id, {required String notes}) =>
      throw UnimplementedError();
}

Future<void> _pump(
  WidgetTester tester, {
  required AdminBusinessesRepository repo,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: AdminReviewQueueScreen(repositoryOverride: repo),
      ),
    ),
  );
}

void main() {
  testWidgets('renders a loading indicator while the list is pending',
      (tester) async {
    await _pump(tester, repo: _PendingRepo());
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('renders the empty state when no businesses are pending',
      (tester) async {
    await _pump(tester, repo: _RecordingRepo());
    await tester.pumpAndSettle();

    expect(find.text('Queue is clear'), findsOneWidget);
    expect(
      find.textContaining('No businesses are waiting for review'),
      findsOneWidget,
    );
  });

  testWidgets('renders pending businesses as cards with Approve / Reject',
      (tester) async {
    final repo = _RecordingRepo(initial: [
      _pending(id: 'biz-1', name: 'Habesha Tej House', city: 'Addis Ababa'),
      _pending(id: 'biz-2', name: "Sami's Cuts", city: 'Addis Ababa'),
    ]);
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Habesha Tej House'), findsOneWidget);
    expect(find.text("Sami's Cuts"), findsOneWidget);
    // Both cards expose Approve / Reject (so the actions are
    // findsNWidgets(2) in aggregate).
    expect(find.widgetWithText(FilledButton, 'Approve'), findsNWidgets(2));
    expect(find.widgetWithText(OutlinedButton, 'Reject'), findsNWidgets(2));
  });

  testWidgets('tapping Approve calls repo.approve with the matching id',
      (tester) async {
    final repo = _RecordingRepo(initial: [_pending(id: 'biz-7')]);
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('admin-approve-biz-7')));
    await tester.pumpAndSettle();

    expect(repo.lastApprovedId, 'biz-7');
    // The list re-fetches after a successful approve.
    expect(repo.listCalls, greaterThan(1));
  });

  testWidgets(
    'Reject dialog blocks submit when the reason field is empty',
    (tester) async {
      final repo = _RecordingRepo(initial: [_pending(id: 'biz-9')]);
      await _pump(tester, repo: repo);
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('admin-reject-biz-9')));
      await tester.pumpAndSettle();

      // Dialog open, reason field present.
      expect(find.byKey(const Key('admin-reject-reason-input')), findsOneWidget);

      // Submit with blank reason — should surface inline error,
      // NOT close the dialog, NOT call repo.reject.
      await tester.tap(find.byKey(const Key('admin-reject-submit')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('admin-reject-reason-input')), findsOneWidget);
      expect(
        find.textContaining('Please enter a reason'),
        findsOneWidget,
      );
      expect(repo.lastRejectedId, isNull);
    },
  );

  testWidgets(
    'Reject dialog with a reason calls repo.reject(id, notes) + refreshes',
    (tester) async {
      final repo = _RecordingRepo(initial: [_pending(id: 'biz-11')]);
      await _pump(tester, repo: repo);
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('admin-reject-biz-11')));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('admin-reject-reason-input')),
        'License photo is unreadable.',
      );
      await tester.tap(find.byKey(const Key('admin-reject-submit')));
      await tester.pumpAndSettle();

      expect(repo.lastRejectedId, 'biz-11');
      expect(repo.lastRejectedNotes, 'License photo is unreadable.');
      // Initial + post-action refresh.
      expect(repo.listCalls, greaterThanOrEqualTo(2));
    },
  );
}
