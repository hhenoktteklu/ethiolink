// EthioLink Mobile — BookingFlowScreen widget tests.

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/booking/booking_flow_screen.dart';
import 'package:ethiolink/features/booking/data/booking_repositories.dart';
import 'package:ethiolink/features/booking/models/appointment.dart';
import 'package:ethiolink/features/booking/models/slot.dart';
import 'package:ethiolink/features/browse/models/review.dart';
import 'package:ethiolink/features/browse/models/service.dart';
import 'package:ethiolink/features/browse/models/staff.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
);

const _service = Service(
  id: 'srv-1',
  businessId: 'biz-1',
  nameEn: 'Haircut',
  descriptionEn: null,
  durationMinutes: 30,
  priceEtb: 300,
  isActive: true,
);

final _onlyStaff = [
  const Staff(
    id: 'stf-1',
    businessId: 'biz-1',
    displayName: 'Hana',
    role: 'Stylist',
    isActive: true,
  ),
];

Slot _slot(int hour) {
  return Slot(
    startUtc: DateTime.utc(2030, 1, 1, hour),
    endUtc: DateTime.utc(2030, 1, 1, hour).add(const Duration(minutes: 30)),
  );
}

class FakeSlotsRepo implements SlotsRepository {
  FakeSlotsRepo({this.slots = const <Slot>[], this.throws});
  List<Slot> slots;
  Object? throws;
  @override
  Future<List<Slot>> list({
    required String businessId,
    required String staffId,
    required String serviceId,
    required String fromDate,
    required String toDate,
  }) async {
    if (throws != null) throw throws!;
    return slots;
  }
}

class FakeAppointmentsRepo implements AppointmentsRepository {
  FakeAppointmentsRepo({this.appointment, this.payment, this.throws});
  Appointment? appointment;

  /// Phase 10 — defaults to a synchronous SUCCEEDED summary
  /// matching cash; tests that exercise the online path override
  /// with a PENDING payment + redirectUrl.
  PaymentSummary? payment;
  Object? throws;
  bool created = false;
  String? lastPaymentMethod;

  @override
  Future<CreateAppointmentResponse> create({
    required String staffId,
    required String serviceId,
    required String startsAtIso,
    required String paymentMethod,
    String? notes,
  }) async {
    if (throws != null) throw throws!;
    created = true;
    lastPaymentMethod = paymentMethod;
    return CreateAppointmentResponse(
      appointment: appointment!,
      payment: payment ??
          const PaymentSummary(
            status: 'SUCCEEDED',
            provider: 'CASH',
            providerRef: null,
            redirectUrl: null,
            errorCode: null,
            errorMessage: null,
          ),
    );
  }

  @override
  Future<Appointment> cancel({
    required String appointmentId,
    String? reason,
  }) async {
    throw UnimplementedError('not used in booking flow tests');
  }

  @override
  Future<Review> review({
    required String appointmentId,
    required int rating,
    String? comment,
  }) async {
    throw UnimplementedError('not used in booking flow tests');
  }
}

Appointment _sampleAppointment() {
  return Appointment(
    id: 'apt-1',
    customerId: 'cust',
    businessId: 'biz-1',
    serviceId: 'srv-1',
    staffId: 'stf-1',
    startsAt: DateTime.utc(2030, 1, 1, 9),
    endsAt: DateTime.utc(2030, 1, 1, 9, 30),
    status: 'REQUESTED',
    paymentMethod: 'CASH',
    priceEtb: 300,
    notes: null,
  );
}

Future<void> _pump(
  WidgetTester tester, {
  required SlotsRepository slots,
  required AppointmentsRepository appointments,
  List<Staff>? staff,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: BookingFlowScreen(
          businessId: 'biz-1',
          businessName: 'Sunset Salon',
          service: _service,
          staff: staff ?? _onlyStaff,
          slotsRepositoryOverride: slots,
          appointmentsRepositoryOverride: appointments,
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('happy path: single staff → date → slot → confirm → success',
      (tester) async {
    final slots = FakeSlotsRepo(slots: [_slot(9), _slot(10)]);
    final appointments = FakeAppointmentsRepo(appointment: _sampleAppointment());

    await _pump(tester, slots: slots, appointments: appointments);
    await tester.pumpAndSettle();

    // Single staff → auto-advanced to date step.
    expect(find.text('Hana'), findsNothing); // staff step skipped.
    // Date step: tap the first date row.
    await tester.tap(find.byIcon(Icons.calendar_today).first);
    await tester.pumpAndSettle();

    // Slot step shows the times.
    expect(find.textContaining('Hana · '), findsOneWidget);
    final firstSlot = find.byType(OutlinedButton).first;
    await tester.tap(firstSlot);
    await tester.pumpAndSettle();

    // Confirm step.
    expect(find.text('Confirm your booking'), findsOneWidget);
    expect(find.text('Sunset Salon'), findsOneWidget);
    expect(find.text('Haircut'), findsOneWidget);
    expect(find.text('Hana'), findsOneWidget);
    expect(find.text('Cash at the business'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Book this slot'));
    await tester.pump(); // start loading state
    await tester.pumpAndSettle();

    // Success step.
    expect(find.text('Booking requested!'), findsOneWidget);
    expect(find.textContaining('Reference: apt-1'), findsOneWidget);
    expect(appointments.created, isTrue);
  });

  testWidgets('SLOT_UNAVAILABLE shows the "pick another slot" panel',
      (tester) async {
    final slots = FakeSlotsRepo(slots: [_slot(9)]);
    final appointments = FakeAppointmentsRepo(
      throws: AppointmentCreateFailure(
        kind: AppointmentCreateFailureKind.slotUnavailable,
        message: 'Slot just got taken.',
        statusCode: 409,
        apiErrorCode: 'SLOT_UNAVAILABLE',
      ),
    );

    await _pump(tester, slots: slots, appointments: appointments);
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.calendar_today).first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(OutlinedButton).first);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Book this slot'));
    await tester.pumpAndSettle();

    // Error panel rendered with the dedicated copy + action.
    expect(find.text('Slot just got taken'), findsOneWidget);
    expect(
      find.widgetWithText(FilledButton, 'Pick another slot'),
      findsOneWidget,
    );

    // Tapping the action routes back to the slot step + re-fetches.
    await tester.tap(find.widgetWithText(FilledButton, 'Pick another slot'));
    await tester.pumpAndSettle();
    // Slot step shows the staff header again.
    expect(find.textContaining('Hana · '), findsOneWidget);
  });

  testWidgets('no slots → empty state + retry', (tester) async {
    final slots = FakeSlotsRepo(slots: const <Slot>[]);
    final appointments = FakeAppointmentsRepo();

    await _pump(tester, slots: slots, appointments: appointments);
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.calendar_today).first);
    await tester.pumpAndSettle();

    expect(find.text('No open slots'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Retry'), findsOneWidget);
  });

  testWidgets('multi-staff: shows the staff step', (tester) async {
    final multi = <Staff>[
      const Staff(
        id: 'a',
        businessId: 'biz-1',
        displayName: 'Alice',
        role: 'Stylist',
        isActive: true,
      ),
      const Staff(
        id: 'b',
        businessId: 'biz-1',
        displayName: 'Bob',
        role: 'Barber',
        isActive: true,
      ),
    ];
    final slots = FakeSlotsRepo(slots: [_slot(9)]);
    final appointments = FakeAppointmentsRepo();

    await _pump(
      tester,
      slots: slots,
      appointments: appointments,
      staff: multi,
    );
    await tester.pumpAndSettle();

    expect(find.text('Alice'), findsOneWidget);
    expect(find.text('Bob'), findsOneWidget);
  });

  // -----------------------------------------------------------------
  // Phase 10 — online checkout
  // -----------------------------------------------------------------

  testWidgets('online PENDING → opens Chapa redirect + polls history',
      (tester) async {
    final slots = FakeSlotsRepo(slots: [_slot(9)]);
    final appointments = FakeAppointmentsRepo(
      appointment: _sampleAppointment(),
      payment: const PaymentSummary(
        status: 'PENDING',
        provider: 'CHAPA',
        providerRef: 'apt-tx-001',
        redirectUrl: 'https://checkout.chapa.test/sess-001',
        errorCode: null,
        errorMessage: null,
      ),
    );
    final history = _RecordingHistoryRepo(initial: [_sampleAppointment()]);
    final launches = <String>[];

    await tester.pumpWidget(
      AppConfigScope(
        config: _testConfig,
        child: MaterialApp(
          locale: const Locale('en'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: BookingFlowScreen(
            businessId: 'biz-1',
            businessName: 'Sunset Salon',
            service: _service,
            staff: _onlyStaff,
            slotsRepositoryOverride: slots,
            appointmentsRepositoryOverride: appointments,
            historyRepositoryOverride: history,
            paymentRedirectorOverride: (url) async {
              launches.add(url);
              return true;
            },
            // Tighten the poll interval so the test doesn't sit
            // around for 3 seconds.
            paymentPollInterval: const Duration(milliseconds: 10),
            paymentPollMaxAttempts: 5,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Date / slot / confirm progression — single staff auto-skipped.
    await tester.tap(find.byIcon(Icons.calendar_today).first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(OutlinedButton).first);
    await tester.pumpAndSettle();

    // Confirm step — switch to ONLINE_PENDING.
    expect(find.text('Pay now (Chapa)'), findsOneWidget);
    await tester.tap(find.text('Pay now (Chapa)'));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Book this slot'));
    // Pump enough times for the redirect + first poll to fire.
    await tester.pump(); // create call in flight
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();

    // Launcher saw the Chapa URL exactly once.
    assert(launches.length == 1, 'expected 1 launch, got ${launches.length}');
    expect(launches.first, 'https://checkout.chapa.test/sess-001');
    expect(appointments.lastPaymentMethod, 'ONLINE_PENDING');
    // History was polled at least once.
    expect(history.calls, greaterThanOrEqualTo(1));
    // Final phase should be SUCCEEDED (the appointment isn't CANCELLED,
    // so the proxy treats any subsequent fetch as success).
    expect(find.text('Payment received'), findsOneWidget);
  });

  testWidgets('online launcher returns false → failed branch',
      (tester) async {
    final slots = FakeSlotsRepo(slots: [_slot(9)]);
    final appointments = FakeAppointmentsRepo(
      appointment: _sampleAppointment(),
      payment: const PaymentSummary(
        status: 'PENDING',
        provider: 'CHAPA',
        providerRef: 'apt-tx-002',
        redirectUrl: 'https://checkout.chapa.test/sess-002',
        errorCode: null,
        errorMessage: null,
      ),
    );
    final history = _RecordingHistoryRepo(initial: [_sampleAppointment()]);

    await tester.pumpWidget(
      AppConfigScope(
        config: _testConfig,
        child: MaterialApp(
          locale: const Locale('en'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: BookingFlowScreen(
            businessId: 'biz-1',
            businessName: 'Sunset Salon',
            service: _service,
            staff: _onlyStaff,
            slotsRepositoryOverride: slots,
            appointmentsRepositoryOverride: appointments,
            historyRepositoryOverride: history,
            paymentRedirectorOverride: (url) async => false,
            paymentPollInterval: const Duration(milliseconds: 10),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.calendar_today).first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(OutlinedButton).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pay now (Chapa)'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Book this slot'));
    await tester.pump();
    await tester.pumpAndSettle();

    expect(find.text('Payment failed'), findsOneWidget);
    // History was never polled — the launcher refused.
    expect(history.calls, 0);
  });

  testWidgets('online poll exhausted → timed-out branch', (tester) async {
    final slots = FakeSlotsRepo(slots: [_slot(9)]);
    final appointments = FakeAppointmentsRepo(
      appointment: _sampleAppointment(),
      payment: const PaymentSummary(
        status: 'PENDING',
        provider: 'CHAPA',
        providerRef: 'apt-tx-003',
        redirectUrl: 'https://checkout.chapa.test/sess-003',
        errorCode: null,
        errorMessage: null,
      ),
    );
    // History repo throws on every read → poll keeps trying until
    // the budget exhausts.
    final history = _RecordingHistoryRepo(throws: Exception('network'));

    await tester.pumpWidget(
      AppConfigScope(
        config: _testConfig,
        child: MaterialApp(
          locale: const Locale('en'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: BookingFlowScreen(
            businessId: 'biz-1',
            businessName: 'Sunset Salon',
            service: _service,
            staff: _onlyStaff,
            slotsRepositoryOverride: slots,
            appointmentsRepositoryOverride: appointments,
            historyRepositoryOverride: history,
            paymentRedirectorOverride: (_) async => true,
            paymentPollInterval: const Duration(milliseconds: 5),
            paymentPollMaxAttempts: 3,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.calendar_today).first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(OutlinedButton).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pay now (Chapa)'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Book this slot'));
    await tester.pump();
    // Pump a few times to let the poll budget drain.
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    await tester.pumpAndSettle();

    expect(find.text('Still processing'), findsOneWidget);
    expect(history.calls, 3);
  });

  testWidgets('online CANCELLED appointment from history → failed branch',
      (tester) async {
    final slots = FakeSlotsRepo(slots: [_slot(9)]);
    final appointments = FakeAppointmentsRepo(
      appointment: _sampleAppointment(),
      payment: const PaymentSummary(
        status: 'PENDING',
        provider: 'CHAPA',
        providerRef: 'apt-tx-004',
        redirectUrl: 'https://checkout.chapa.test/sess-004',
        errorCode: null,
        errorMessage: null,
      ),
    );
    final cancelled = Appointment(
      id: 'apt-1',
      customerId: 'cust',
      businessId: 'biz-1',
      serviceId: 'srv-1',
      staffId: 'stf-1',
      startsAt: DateTime.utc(2030, 1, 1, 9),
      endsAt: DateTime.utc(2030, 1, 1, 9, 30),
      status: 'CANCELLED',
      paymentMethod: 'ONLINE_PENDING',
      priceEtb: 300,
      notes: null,
    );
    final history = _RecordingHistoryRepo(initial: [cancelled]);

    await tester.pumpWidget(
      AppConfigScope(
        config: _testConfig,
        child: MaterialApp(
          locale: const Locale('en'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: BookingFlowScreen(
            businessId: 'biz-1',
            businessName: 'Sunset Salon',
            service: _service,
            staff: _onlyStaff,
            slotsRepositoryOverride: slots,
            appointmentsRepositoryOverride: appointments,
            historyRepositoryOverride: history,
            paymentRedirectorOverride: (_) async => true,
            paymentPollInterval: const Duration(milliseconds: 5),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.calendar_today).first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(OutlinedButton).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pay now (Chapa)'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Book this slot'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 20));
    await tester.pumpAndSettle();

    expect(find.text('Payment failed'), findsOneWidget);
  });

  test('CreateAppointmentResponse parses wrapped wire shape', () {
    final json = {
      'appointment': {
        'id': 'apt-1',
        'customerId': 'cust',
        'businessId': 'biz-1',
        'serviceId': 'srv-1',
        'staffId': 'stf-1',
        'startsAt': '2030-01-01T09:00:00.000Z',
        'endsAt': '2030-01-01T09:30:00.000Z',
        'status': 'REQUESTED',
        'paymentMethod': 'ONLINE_PENDING',
        'priceEtb': 300,
        'notes': null,
        'cancelledBy': null,
        'cancelReason': null,
      },
      'payment': {
        'status': 'PENDING',
        'provider': 'CHAPA',
        'providerRef': 'apt-1-aaaa',
        'redirectUrl': 'https://checkout.chapa.test/sess-001',
        'errorCode': null,
        'errorMessage': null,
      },
    };
    final parsed = CreateAppointmentResponse.fromJson(json);
    expect(parsed.appointment.id, 'apt-1');
    expect(parsed.payment.status, 'PENDING');
    expect(parsed.payment.redirectUrl, 'https://checkout.chapa.test/sess-001');
    expect(parsed.payment.providerRef, 'apt-1-aaaa');
  });
}

/// Phase 10 — recording history fake used by the payment-waiting
/// poll tests. `initial` is what `listMine` returns; `throws`, if
/// set, is thrown on every call.
class _RecordingHistoryRepo implements AppointmentHistoryRepository {
  _RecordingHistoryRepo({List<Appointment>? initial, this.throws})
      : _items = initial ?? const <Appointment>[];
  final List<Appointment> _items;
  Object? throws;
  int calls = 0;

  @override
  Future<List<Appointment>> listMine() async {
    calls += 1;
    if (throws != null) throw throws!;
    return _items;
  }
}
