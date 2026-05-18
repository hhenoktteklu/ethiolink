// EthioLink Mobile — BookingsScreen + AppointmentDetailScreen tests.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/auth/auth_service.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/booking/data/booking_repositories.dart';
import 'package:ethiolink/features/booking/models/appointment.dart';
import 'package:ethiolink/features/bookings/appointment_detail_screen.dart';
import 'package:ethiolink/features/bookings/bookings_screen.dart';
import 'package:ethiolink/features/browse/models/review.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
);

final _testSession = AuthSession(
  userId: 'user-1',
  email: 'test@example.com',
  role: 'CUSTOMER',
  expiresAt: DateTime.utc(2030),
);

Appointment _apt({
  String id = 'apt-1',
  String status = 'ACCEPTED',
  DateTime? startsAt,
}) {
  return Appointment(
    id: id,
    customerId: 'cust',
    businessId: 'biz',
    serviceId: 'srv',
    staffId: 'stf',
    startsAt: startsAt ?? DateTime.utc(2030, 1, 1, 9),
    endsAt: (startsAt ?? DateTime.utc(2030, 1, 1, 9))
        .add(const Duration(minutes: 30)),
    status: status,
    paymentMethod: 'CASH',
    priceEtb: 300,
    notes: null,
  );
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeHistoryRepo implements AppointmentHistoryRepository {
  FakeHistoryRepo({this.values, this.throws, this.pending = false});
  List<Appointment>? values;
  Object? throws;
  bool pending;
  Completer<List<Appointment>>? _pendingCompleter;

  @override
  Future<List<Appointment>> listMine() {
    if (pending) {
      _pendingCompleter ??= Completer<List<Appointment>>();
      return _pendingCompleter!.future;
    }
    if (throws != null) return Future<List<Appointment>>.error(throws!);
    return Future<List<Appointment>>.value(values ?? <Appointment>[]);
  }
}

class FakeAppointmentsRepo implements AppointmentsRepository {
  FakeAppointmentsRepo({this.cancelResult, this.cancelThrows});
  Appointment? cancelResult;
  Object? cancelThrows;
  bool cancelCalled = false;

  @override
  // Phase 10 widened `create()` to return a wrapped
  // `CreateAppointmentResponse` (appointment + payment summary +
  // optional redirect URL). The fake never builds appointments —
  // every test in this file exercises cancel/review — so an
  // `UnimplementedError` is still the correct stand-in; only the
  // return type needs to match the interface.
  Future<CreateAppointmentResponse> create({
    required String staffId,
    required String serviceId,
    required String startsAtIso,
    required String paymentMethod,
    String? notes,
  }) =>
      throw UnimplementedError();

  @override
  Future<Appointment> cancel({
    required String appointmentId,
    String? reason,
  }) async {
    cancelCalled = true;
    if (cancelThrows != null) throw cancelThrows!;
    return cancelResult!;
  }

  @override
  Future<Review> review({
    required String appointmentId,
    required int rating,
    String? comment,
  }) =>
      throw UnimplementedError();
}

Future<void> _pumpBookings(
  WidgetTester tester, {
  required AppointmentHistoryRepository repo,
  AppointmentsRepository? appointmentsRepo,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: BookingsScreen(
          session: _testSession,
          historyRepositoryOverride: repo,
          appointmentsRepositoryOverride: appointmentsRepo,
        ),
      ),
    ),
  );
}

Future<void> _pumpDetail(
  WidgetTester tester, {
  required Appointment appointment,
  required AppointmentsRepository repo,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: AppointmentDetailScreen(
          appointment: appointment,
          appointmentsRepositoryOverride: repo,
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  testWidgets('renders loading then the upcoming/past groups',
      (tester) async {
    final repo = FakeHistoryRepo(values: [
      _apt(id: 'a', status: 'ACCEPTED', startsAt: DateTime.utc(2030, 1, 1)),
      _apt(id: 'b', status: 'COMPLETED', startsAt: DateTime.utc(2020, 1, 1)),
    ]);
    await _pumpBookings(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Upcoming'), findsOneWidget);
    expect(find.text('Past'), findsOneWidget);
    expect(find.text('ACCEPTED'), findsNothing); // status is in the badge icon, not text
    // Both appointments rendered as rows.
    expect(find.byType(ListTile), findsNWidgets(2));
  });

  testWidgets('renders the empty state when the API returns no items',
      (tester) async {
    final repo = FakeHistoryRepo(values: const <Appointment>[]);
    await _pumpBookings(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('No bookings yet'), findsOneWidget);
  });

  testWidgets('renders the error state on a repository failure',
      (tester) async {
    final repo = FakeHistoryRepo(
      throws: AppointmentHistoryLoadFailure('boom', isNetworkError: true),
    );
    await _pumpBookings(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text("Can't reach the server"), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('cancel happy path updates the appointment status',
      (tester) async {
    final original = _apt(status: 'ACCEPTED');
    final updated = _apt(status: 'CANCELLED').copyWith();
    final repo = FakeAppointmentsRepo(cancelResult: updated);

    await _pumpDetail(tester, appointment: original, repo: repo);
    await tester.pumpAndSettle();

    expect(find.widgetWithText(OutlinedButton, 'Cancel booking'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, 'Cancel booking'));
    await tester.pumpAndSettle();

    expect(repo.cancelCalled, isTrue);
    // After cancellation, the row Status text now reads CANCELLED.
    expect(find.text('CANCELLED'), findsWidgets);
    // Cancel section disappears once the appointment is no longer cancellable.
    expect(
      find.widgetWithText(OutlinedButton, 'Cancel booking'),
      findsNothing,
    );
  });

  testWidgets('cancel cutoff conflict renders the dedicated error copy',
      (tester) async {
    final repo = FakeAppointmentsRepo(
      cancelThrows: AppointmentActionFailure(
        kind: AppointmentActionFailureKind.conflict,
        message: 'Past the cancellation cutoff.',
        statusCode: 409,
        apiErrorCode: 'CONFLICT',
      ),
    );

    await _pumpDetail(
      tester,
      appointment: _apt(status: 'ACCEPTED'),
      repo: repo,
    );
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(OutlinedButton, 'Cancel booking'));
    await tester.pumpAndSettle();

    expect(find.text('Past the cancellation cutoff'), findsOneWidget);
    expect(
      find.textContaining('Contact the business directly'),
      findsOneWidget,
    );
  });
}

// `Appointment` is immutable + has no copyWith — declare a tiny
// extension here to keep the cancel test concise.
extension on Appointment {
  Appointment copyWith() {
    return Appointment(
      id: id,
      customerId: customerId,
      businessId: businessId,
      serviceId: serviceId,
      staffId: staffId,
      startsAt: startsAt,
      endsAt: endsAt,
      status: status,
      paymentMethod: paymentMethod,
      priceEtb: priceEtb,
      notes: notes,
      cancelledBy: cancelledBy,
      cancelReason: cancelReason,
    );
  }
}
