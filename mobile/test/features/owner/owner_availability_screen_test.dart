// EthioLink Mobile — OwnerAvailabilityScreen widget tests.
//
// Drives the screen end-to-end against in-memory fakes for both
// the staff repository and the availability repository. Covers:
//
//   * No-staff empty state (the only "empty" surface the screen
//     can show — the schedule fetch always returns 7 grouped
//     buckets).
//   * Staff-load error.
//   * Pick staff → schedule loads → 7 weekday cards render.
//   * Add / remove a weekly window.
//   * Save with valid times → PUT issued with 7 days.
//   * Validation: empty start/end blocks save.
//   * Validation: end <= start blocks save.
//   * Add closed-date override → POST issued → re-fetched schedule
//     shows the new row.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/models/staff.dart';
import 'package:ethiolink/features/owner/data/availability_repository.dart';
import 'package:ethiolink/features/owner/data/owner_staff_repository.dart';
import 'package:ethiolink/features/owner/models/availability.dart';
import 'package:ethiolink/features/owner/owner_availability_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

Staff _staff({String id = 'staff-1', String name = 'Selam Tadesse'}) {
  return Staff(
    id: id,
    businessId: 'biz-1',
    displayName: name,
    role: null,
    isActive: true,
  );
}

AvailabilityWindow _weekly({
  required String id,
  required int weekday,
  String start = '09:00:00',
  String end = '17:00:00',
}) {
  return AvailabilityWindow(
    id: id,
    kind: 'WEEKLY',
    weekday: weekday,
    specificDate: null,
    startTime: start,
    endTime: end,
    isClosed: false,
  );
}

AvailabilityWindow _closedOverride(String date) {
  return AvailabilityWindow(
    id: 'o-$date',
    kind: 'OVERRIDE',
    weekday: null,
    specificDate: date,
    startTime: '00:00:00',
    endTime: '23:59:00',
    isClosed: true,
  );
}

class _FakeStaffRepo implements OwnerStaffRepository {
  _FakeStaffRepo(this.items);
  final List<Staff> items;
  @override
  Future<List<Staff>> listStaff(String businessId) async => items;

  @override
  Future<Staff> createStaff(String b, CreateStaffRequest r) async =>
      throw UnimplementedError();
  @override
  Future<Staff> updateStaff(String b, String s, UpdateStaffRequest r) async =>
      throw UnimplementedError();
  @override
  Future<Staff> deactivateStaff(String b, String s) async =>
      throw UnimplementedError();
}

class _FakeAvailRepo implements AvailabilityRepository {
  _FakeAvailRepo({AvailabilitySchedule? initial})
      : _schedule = initial ??
            const AvailabilitySchedule(weekly: [], overrides: []);

  AvailabilitySchedule _schedule;
  Object? scheduleError;
  Object? saveError;
  Object? overrideError;

  List<WeeklyDayInput>? lastReplaceDays;
  AvailabilityOverrideRequest? lastOverride;

  @override
  Future<AvailabilitySchedule> getSchedule(String b, String s) async {
    if (scheduleError != null) throw scheduleError!;
    return _schedule;
  }

  @override
  Future<AvailabilitySchedule> replaceWeekly(
    String b,
    String s,
    List<WeeklyDayInput> days,
  ) async {
    lastReplaceDays = days;
    if (saveError != null) throw saveError!;
    final newWindows = <AvailabilityWindow>[];
    for (final d in days) {
      for (var i = 0; i < d.windows.length; i++) {
        newWindows.add(AvailabilityWindow(
          id: 'w-${d.weekday}-$i',
          kind: 'WEEKLY',
          weekday: d.weekday,
          specificDate: null,
          startTime: d.windows[i].startTime,
          endTime: d.windows[i].endTime,
          isClosed: false,
        ));
      }
    }
    _schedule = AvailabilitySchedule(
      weekly: newWindows,
      overrides: _schedule.overrides,
    );
    return _schedule;
  }

  @override
  Future<AvailabilityWindow> addOverride(
    String b,
    String s,
    AvailabilityOverrideRequest req,
  ) async {
    lastOverride = req;
    if (overrideError != null) throw overrideError!;
    final w = AvailabilityWindow(
      id: 'o-${req.specificDate}',
      kind: 'OVERRIDE',
      weekday: null,
      specificDate: req.specificDate,
      startTime: req.startTime,
      endTime: req.endTime,
      isClosed: req.isClosed,
    );
    _schedule = AvailabilitySchedule(
      weekly: _schedule.weekly,
      overrides: [..._schedule.overrides, w],
    );
    return w;
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required OwnerStaffRepository staffRepo,
  required AvailabilityRepository availRepo,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: OwnerAvailabilityScreen(
          businessId: 'biz-1',
          staffRepositoryOverride: staffRepo,
          availabilityRepositoryOverride: availRepo,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _pickStaff(WidgetTester tester, String name) async {
  await tester.tap(find.byType(DropdownButtonFormField<String>));
  await tester.pumpAndSettle();
  await tester.tap(find.text(name).last);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('renders the no-staff prompt when there are no active staff',
      (tester) async {
    await _pump(
      tester,
      staffRepo: _FakeStaffRepo([]),
      availRepo: _FakeAvailRepo(),
    );

    expect(find.text('No active staff'), findsOneWidget);
  });

  testWidgets('renders the staff-load error variant', (tester) async {
    await _pump(
      tester,
      staffRepo: _FakeStaffRepo([])..error = Exception('boom'),
      availRepo: _FakeAvailRepo(),
    );

    expect(find.text('Could not load staff'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
  });

  testWidgets('picking staff loads the schedule + renders 7 weekday cards',
      (tester) async {
    final availRepo = _FakeAvailRepo(
      initial: AvailabilitySchedule(
        weekly: [_weekly(id: 'w-1', weekday: 1)],
        overrides: const [],
      ),
    );
    await _pump(
      tester,
      staffRepo: _FakeStaffRepo([_staff()]),
      availRepo: availRepo,
    );

    await _pickStaff(tester, 'Selam Tadesse');

    // All 7 weekday cards visible.
    for (final name in const [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ]) {
      expect(find.text(name), findsOneWidget);
    }
    // The Monday window is editable — its start field carries 09:00.
    final tfs = find.byType(TextField);
    expect(tfs, findsWidgets);
    final filled = tester.widgetList<TextField>(tfs).where(
          (t) => t.controller?.text == '09:00',
        );
    expect(filled, isNotEmpty);
  });

  testWidgets('adding then removing a weekly window mutates the editor',
      (tester) async {
    final availRepo = _FakeAvailRepo();
    await _pump(
      tester,
      staffRepo: _FakeStaffRepo([_staff()]),
      availRepo: availRepo,
    );
    await _pickStaff(tester, 'Selam Tadesse');

    final addButtons = find.widgetWithText(TextButton, 'Add interval');
    expect(addButtons, findsNWidgets(7)); // one per weekday

    // Tap the first day's "Add interval" → a delete-icon appears.
    await tester.tap(addButtons.first);
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.delete_outline), findsOneWidget);

    // Tap delete → the new row is gone.
    await tester.tap(find.byIcon(Icons.delete_outline));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.delete_outline), findsNothing);
  });

  testWidgets('save: happy path PUTs all 7 days', (tester) async {
    final availRepo = _FakeAvailRepo(
      initial: AvailabilitySchedule(
        weekly: [_weekly(id: 'w-1', weekday: 1)],
        overrides: const [],
      ),
    );
    await _pump(
      tester,
      staffRepo: _FakeStaffRepo([_staff()]),
      availRepo: availRepo,
    );
    await _pickStaff(tester, 'Selam Tadesse');

    final saveBtn =
        find.widgetWithText(FilledButton, 'Save weekly schedule');
    await tester.ensureVisible(saveBtn);
    await tester.pumpAndSettle();
    await tester.tap(saveBtn);
    await tester.pumpAndSettle();

    expect(availRepo.lastReplaceDays, isNotNull);
    expect(availRepo.lastReplaceDays!.length, 7);
    // Day 1 carries the existing 09:00-17:00 window.
    final monday =
        availRepo.lastReplaceDays!.firstWhere((d) => d.weekday == 1);
    expect(monday.windows, hasLength(1));
    expect(monday.windows.first.startTime, '09:00');
    expect(monday.windows.first.endTime, '17:00');

    expect(find.text('Schedule saved.'), findsOneWidget);
  });

  testWidgets('save: validation blocks when end <= start', (tester) async {
    final availRepo = _FakeAvailRepo();
    await _pump(
      tester,
      staffRepo: _FakeStaffRepo([_staff()]),
      availRepo: availRepo,
    );
    await _pickStaff(tester, 'Selam Tadesse');

    // Add a row to Sunday (the first weekday card).
    await tester
        .tap(find.widgetWithText(TextButton, 'Add interval').first);
    await tester.pumpAndSettle();

    // Two TextFields: start + end. They live in the same Row, so
    // we find them by their decoration labels via ancestor lookup.
    final starts = tester.widgetList<TextField>(find.byType(TextField));
    // Set start = 09:00, end = 09:00 (end == start → invalid).
    starts.elementAt(0).controller!.text = '09:00';
    starts.elementAt(1).controller!.text = '09:00';

    final saveBtn =
        find.widgetWithText(FilledButton, 'Save weekly schedule');
    await tester.ensureVisible(saveBtn);
    await tester.pumpAndSettle();
    await tester.tap(saveBtn);
    await tester.pumpAndSettle();

    expect(availRepo.lastReplaceDays, isNull);
    expect(find.text('Check your schedule'), findsOneWidget);
    expect(
      find.textContaining('end time must be after start time'),
      findsOneWidget,
    );
  });

  testWidgets(
      'save: validation blocks when start or end is empty',
      (tester) async {
    final availRepo = _FakeAvailRepo();
    await _pump(
      tester,
      staffRepo: _FakeStaffRepo([_staff()]),
      availRepo: availRepo,
    );
    await _pickStaff(tester, 'Selam Tadesse');

    // Add an empty row.
    await tester
        .tap(find.widgetWithText(TextButton, 'Add interval').first);
    await tester.pumpAndSettle();

    final saveBtn =
        find.widgetWithText(FilledButton, 'Save weekly schedule');
    await tester.ensureVisible(saveBtn);
    await tester.pumpAndSettle();
    await tester.tap(saveBtn);
    await tester.pumpAndSettle();

    expect(availRepo.lastReplaceDays, isNull);
    expect(
      find.textContaining(
        'both start and end times are required',
      ),
      findsOneWidget,
    );
  });

  testWidgets('add closed override calls addOverride and re-renders the row',
      (tester) async {
    final availRepo = _FakeAvailRepo();
    await _pump(
      tester,
      staffRepo: _FakeStaffRepo([_staff()]),
      availRepo: availRepo,
    );
    await _pickStaff(tester, 'Selam Tadesse');

    // Open the date picker.
    final addBtn =
        find.widgetWithText(OutlinedButton, 'Add closed date');
    await tester.ensureVisible(addBtn);
    await tester.pumpAndSettle();
    await tester.tap(addBtn);
    await tester.pumpAndSettle();

    // Accept the date the picker landed on.
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();

    expect(availRepo.lastOverride, isNotNull);
    expect(availRepo.lastOverride!.isClosed, isTrue);
    expect(availRepo.lastOverride!.startTime, '00:00');
    expect(availRepo.lastOverride!.endTime, '23:59');

    // The overrides list shows the new row (`CLOSED · …`).
    expect(find.textContaining('CLOSED · '), findsOneWidget);
  });

  testWidgets('renders overrides from the initial schedule', (tester) async {
    final availRepo = _FakeAvailRepo(
      initial: AvailabilitySchedule(
        weekly: const [],
        overrides: [_closedOverride('2026-12-25')],
      ),
    );
    await _pump(
      tester,
      staffRepo: _FakeStaffRepo([_staff()]),
      availRepo: availRepo,
    );
    await _pickStaff(tester, 'Selam Tadesse');

    expect(find.text('CLOSED · 2026-12-25'), findsOneWidget);
  });
}
