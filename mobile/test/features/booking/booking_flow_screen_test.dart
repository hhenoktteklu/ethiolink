// EthioLink Mobile — BookingFlowScreen widget tests.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/booking/booking_flow_screen.dart';
import 'package:ethiolink/features/booking/data/booking_repositories.dart';
import 'package:ethiolink/features/booking/models/appointment.dart';
import 'package:ethiolink/features/booking/models/slot.dart';
import 'package:ethiolink/features/browse/models/service.dart';
import 'package:ethiolink/features/browse/models/staff.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

final _service = Service(
  id: 'srv-1',
  businessId: 'biz-1',
  nameEn: 'Haircut',
  descriptionEn: null,
  durationMinutes: 30,
  priceEtb: 300,
  isActive: true,
);

final _onlyStaff = [
  Staff(
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
  FakeAppointmentsRepo({this.appointment, this.throws});
  Appointment? appointment;
  Object? throws;
  bool created = false;
  @override
  Future<Appointment> create({
    required String staffId,
    required String serviceId,
    required String startsAtIso,
    required String paymentMethod,
    String? notes,
  }) async {
    if (throws != null) throw throws!;
    created = true;
    return appointment!;
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
      Staff(
        id: 'a',
        businessId: 'biz-1',
        displayName: 'Alice',
        role: 'Stylist',
        isActive: true,
      ),
      Staff(
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
}
