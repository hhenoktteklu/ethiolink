// EthioLink Mobile — OwnerBookingsScreen + detail widget tests.
//
// Drives both screens against an in-memory
// `OwnerBookingsRepository` fake. Covers:
//
//   * List loading / success / empty / error states.
//   * Filter chip changes refetch.
//   * Tap row → detail → Accept succeeds.
//   * Detail Reject success (with confirm dialog + reason).
//   * Detail Complete success (ACCEPTED → COMPLETED).
//   * Detail Cancel success (with confirm dialog).
//   * 409 conflict on Accept renders the inline banner.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/booking/models/appointment.dart';
import 'package:ethiolink/features/owner/data/owner_bookings_repository.dart';
import 'package:ethiolink/features/owner/owner_bookings_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

Appointment _appt({
  String id = 'appt-1',
  String status = 'REQUESTED',
}) {
  return Appointment(
    id: id,
    customerId: 'user-1',
    businessId: 'biz-1',
    serviceId: 'svc-1',
    staffId: 'staff-1',
    startsAt: DateTime.utc(2026, 6, 1, 9),
    endsAt: DateTime.utc(2026, 6, 1, 9, 30),
    status: status,
    paymentMethod: 'CASH',
    priceEtb: 250,
    notes: null,
  );
}

class _FakeRepo implements OwnerBookingsRepository {
  _FakeRepo({List<Appointment>? initial, this.listError}) : _items = [...?initial];

  final List<Appointment> _items;
  Object? listError;
  Object? acceptError;
  Object? rejectError;
  Object? cancelError;
  Object? completeError;

  String? lastListStatus;
  String? lastAcceptId;
  String? lastRejectId;
  String? lastRejectReason;
  String? lastCancelId;
  String? lastCancelReason;
  String? lastCompleteId;

  @override
  Future<List<Appointment>> listAppointments({
    required String businessId,
    String? status,
    String? fromIso,
    String? toIso,
  }) async {
    lastListStatus = status;
    if (listError != null) throw listError!;
    if (status == null) return List.unmodifiable(_items);
    return List.unmodifiable(_items.where((a) => a.status == status));
  }

  Appointment _replace(Appointment a) {
    final idx = _items.indexWhere((it) => it.id == a.id);
    if (idx >= 0) _items[idx] = a;
    return a;
  }

  @override
  Future<Appointment> acceptAppointment(String id) async {
    lastAcceptId = id;
    if (acceptError != null) throw acceptError!;
    return _replace(_appt(id: id, status: 'ACCEPTED'));
  }

  @override
  Future<Appointment> rejectAppointment(String id, {String? reason}) async {
    lastRejectId = id;
    lastRejectReason = reason;
    if (rejectError != null) throw rejectError!;
    return _replace(_appt(id: id, status: 'REJECTED'));
  }

  @override
  Future<Appointment> cancelAppointment(String id, {String? reason}) async {
    lastCancelId = id;
    lastCancelReason = reason;
    if (cancelError != null) throw cancelError!;
    return _replace(_appt(id: id, status: 'CANCELLED'));
  }

  @override
  Future<Appointment> completeAppointment(String id) async {
    lastCompleteId = id;
    if (completeError != null) throw completeError!;
    return _replace(_appt(id: id, status: 'COMPLETED'));
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required OwnerBookingsRepository repo,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: OwnerBookingsScreen(
          businessId: 'biz-1',
          repositoryOverride: repo,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('renders the empty state with no appointments', (tester) async {
    await _pump(tester, repo: _FakeRepo());
    expect(find.text('Nothing in this view'), findsOneWidget);
  });

  testWidgets('renders the list of appointments', (tester) async {
    final repo = _FakeRepo(initial: [
      _appt(id: 'a1', status: 'REQUESTED'),
      _appt(id: 'a2', status: 'ACCEPTED'),
    ]);
    await _pump(tester, repo: repo);

    expect(find.text('REQUESTED'), findsOneWidget);
    expect(find.text('ACCEPTED'), findsOneWidget);
    expect(find.textContaining('250 ETB'), findsNWidgets(2));
  });

  testWidgets('renders the error state on a list failure', (tester) async {
    final repo = _FakeRepo()
      ..listError = OwnerBookingsFailure(
        kind: OwnerBookingsFailureKind.network,
        message: 'no network',
      );
    await _pump(tester, repo: repo);

    expect(find.text("Can't reach the server"), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
  });

  testWidgets('filter chips re-issue the list with the right status param',
      (tester) async {
    final repo = _FakeRepo(initial: [
      _appt(id: 'a1', status: 'REQUESTED'),
      _appt(id: 'a2', status: 'ACCEPTED'),
    ]);
    await _pump(tester, repo: repo);

    // Default: "All" → null status param.
    expect(repo.lastListStatus, isNull);

    // Tap "Accepted".
    await tester.tap(find.widgetWithText(ChoiceChip, 'Accepted'));
    await tester.pumpAndSettle();
    expect(repo.lastListStatus, 'ACCEPTED');
    expect(find.text('REQUESTED'), findsNothing);

    // Tap "Requested".
    await tester.tap(find.widgetWithText(ChoiceChip, 'Requested'));
    await tester.pumpAndSettle();
    expect(repo.lastListStatus, 'REQUESTED');
    expect(find.text('ACCEPTED'), findsNothing);
  });

  testWidgets('tap row → detail → Accept succeeds and refreshes the list',
      (tester) async {
    final repo = _FakeRepo(initial: [_appt(id: 'a1', status: 'REQUESTED')]);
    await _pump(tester, repo: repo);

    // Tap the row.
    await tester.tap(find.textContaining('250 ETB').first);
    await tester.pumpAndSettle();

    // On detail screen now.
    expect(find.text('Appointment'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Accept'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
    await tester.pumpAndSettle();

    expect(repo.lastAcceptId, 'a1');
    // The status badge on the detail flipped to ACCEPTED.
    expect(find.text('ACCEPTED'), findsOneWidget);
    // Both Accept and Reject hidden; Cancel + Mark complete shown.
    expect(find.widgetWithText(FilledButton, 'Accept'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Mark complete'), findsOneWidget);
  });

  testWidgets('Reject opens a dialog, accepts the reason, and POSTs',
      (tester) async {
    final repo = _FakeRepo(initial: [_appt(id: 'a1', status: 'REQUESTED')]);
    await _pump(tester, repo: repo);

    await tester.tap(find.textContaining('250 ETB').first);
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(OutlinedButton, 'Reject'));
    await tester.pumpAndSettle();

    expect(find.text('Reject this appointment?'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'Outside hours');
    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pumpAndSettle();

    expect(repo.lastRejectId, 'a1');
    expect(repo.lastRejectReason, 'Outside hours');
    expect(find.text('REJECTED'), findsOneWidget);
  });

  testWidgets('Complete: ACCEPTED → COMPLETED', (tester) async {
    final repo = _FakeRepo(initial: [_appt(id: 'a1', status: 'ACCEPTED')]);
    await _pump(tester, repo: repo);

    await tester.tap(find.textContaining('250 ETB').first);
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Mark complete'));
    await tester.pumpAndSettle();

    expect(repo.lastCompleteId, 'a1');
    expect(find.text('COMPLETED'), findsOneWidget);
  });

  testWidgets('Cancel: dialog → POST with reason', (tester) async {
    final repo = _FakeRepo(initial: [_appt(id: 'a1', status: 'ACCEPTED')]);
    await _pump(tester, repo: repo);

    await tester.tap(find.textContaining('250 ETB').first);
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(OutlinedButton, 'Cancel'));
    await tester.pumpAndSettle();

    expect(find.text('Cancel this appointment?'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'Sick day');
    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pumpAndSettle();

    expect(repo.lastCancelId, 'a1');
    expect(repo.lastCancelReason, 'Sick day');
    expect(find.text('CANCELLED'), findsOneWidget);
  });

  testWidgets('409 conflict on Accept renders the inline banner',
      (tester) async {
    final repo = _FakeRepo(initial: [_appt(id: 'a1', status: 'REQUESTED')])
      ..acceptError = OwnerBookingsFailure(
        kind: OwnerBookingsFailureKind.conflict,
        message: 'fromStatus is not REQUESTED',
        statusCode: 409,
        apiErrorCode: 'CONFLICT',
        action: 'accept',
      );
    await _pump(tester, repo: repo);

    await tester.tap(find.textContaining('250 ETB').first);
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
    await tester.pumpAndSettle();

    expect(find.textContaining('Cannot accept'), findsOneWidget);
    // Accept/Reject still rendered (status didn't transition).
    expect(find.widgetWithText(FilledButton, 'Accept'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Reject'), findsOneWidget);
  });

  testWidgets('REJECTED detail shows the read-only hint', (tester) async {
    final repo = _FakeRepo(initial: [_appt(id: 'a1', status: 'REJECTED')]);
    await _pump(tester, repo: repo);

    await tester.tap(find.textContaining('250 ETB').first);
    await tester.pumpAndSettle();

    expect(
      find.text('No further actions available from this state.'),
      findsOneWidget,
    );
    expect(find.widgetWithText(FilledButton, 'Accept'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Mark complete'), findsNothing);
  });
}
