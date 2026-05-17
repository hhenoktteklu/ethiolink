// EthioLink Mobile — availability model tests.
//
// Covers the decode side (`AvailabilityWindow.fromJson` +
// `AvailabilitySchedule.fromJson`) and the encode side
// (`WeeklyDayInput` + `WeeklyWindowInput` + `AvailabilityOverrideRequest`).

import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/features/owner/models/availability.dart';

void main() {
  group('AvailabilityWindow.fromJson', () {
    test('parses a WEEKLY row', () {
      final w = AvailabilityWindow.fromJson({
        'id': 'win-1',
        'kind': 'WEEKLY',
        'weekday': 1,
        'specificDate': null,
        'startTime': '09:00:00',
        'endTime': '17:00:00',
        'isClosed': false,
      });
      expect(w.id, 'win-1');
      expect(w.kind, 'WEEKLY');
      expect(w.weekday, 1);
      expect(w.specificDate, isNull);
      expect(w.startTime, '09:00:00');
      expect(w.startTimeShort, '09:00');
      expect(w.endTimeShort, '17:00');
      expect(w.isClosed, isFalse);
    });

    test('parses an OVERRIDE row with isClosed', () {
      final w = AvailabilityWindow.fromJson({
        'id': 'win-2',
        'kind': 'OVERRIDE',
        'weekday': null,
        'specificDate': '2026-12-25',
        'startTime': '00:00:00',
        'endTime': '23:59:00',
        'isClosed': true,
      });
      expect(w.kind, 'OVERRIDE');
      expect(w.weekday, isNull);
      expect(w.specificDate, '2026-12-25');
      expect(w.isClosed, isTrue);
    });

    test('throws when kind is invalid', () {
      expect(
        () => AvailabilityWindow.fromJson({
          'id': 'x',
          'kind': 'GARBAGE',
          'startTime': '09:00',
          'endTime': '17:00',
          'isClosed': false,
        }),
        throwsA(isA<FormatException>()),
      );
    });

    test('throws when isClosed missing', () {
      expect(
        () => AvailabilityWindow.fromJson({
          'id': 'x',
          'kind': 'WEEKLY',
          'startTime': '09:00',
          'endTime': '17:00',
        }),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('AvailabilitySchedule.fromJson', () {
    test('parses weekly + overrides', () {
      final s = AvailabilitySchedule.fromJson({
        'weekly': [
          {
            'id': 'a',
            'kind': 'WEEKLY',
            'weekday': 1,
            'startTime': '09:00:00',
            'endTime': '12:00:00',
            'isClosed': false,
          },
          {
            'id': 'b',
            'kind': 'WEEKLY',
            'weekday': 5,
            'startTime': '13:00:00',
            'endTime': '18:00:00',
            'isClosed': false,
          },
        ],
        'overrides': [
          {
            'id': 'o',
            'kind': 'OVERRIDE',
            'specificDate': '2026-12-25',
            'startTime': '00:00:00',
            'endTime': '23:59:00',
            'isClosed': true,
          },
        ],
      });
      expect(s.weekly, hasLength(2));
      expect(s.overrides, hasLength(1));
    });

    test('weeklyByDay groups + always returns 7 buckets', () {
      final s = AvailabilitySchedule.fromJson({
        'weekly': [
          {
            'id': 'a',
            'kind': 'WEEKLY',
            'weekday': 1,
            'startTime': '09:00',
            'endTime': '12:00',
            'isClosed': false,
          },
          {
            'id': 'b',
            'kind': 'WEEKLY',
            'weekday': 1,
            'startTime': '14:00',
            'endTime': '18:00',
            'isClosed': false,
          },
          {
            'id': 'c',
            'kind': 'WEEKLY',
            'weekday': 6,
            'startTime': '10:00',
            'endTime': '14:00',
            'isClosed': false,
          },
        ],
        'overrides': <dynamic>[],
      });
      final grouped = s.weeklyByDay();
      expect(grouped, hasLength(7));
      expect(grouped[0], isEmpty);
      expect(grouped[1], hasLength(2));
      expect(grouped[6], hasLength(1));
    });
  });

  group('WeeklyDayInput / WeeklyWindowInput.toJson', () {
    test('encodes a populated day', () {
      const day = WeeklyDayInput(
        weekday: 1,
        windows: [
          WeeklyWindowInput(startTime: '09:00', endTime: '12:00'),
          WeeklyWindowInput(startTime: '14:00', endTime: '18:00'),
        ],
      );
      expect(day.toJson(), {
        'weekday': 1,
        'windows': [
          {'startTime': '09:00', 'endTime': '12:00'},
          {'startTime': '14:00', 'endTime': '18:00'},
        ],
      });
    });

    test('encodes an empty day (closed all day)', () {
      const day = WeeklyDayInput(weekday: 0, windows: []);
      expect(day.toJson(), {'weekday': 0, 'windows': <dynamic>[]});
    });
  });

  group('AvailabilityOverrideRequest.toJson', () {
    test('encodes a closed-date override', () {
      const r = AvailabilityOverrideRequest(
        specificDate: '2026-12-25',
        startTime: '00:00',
        endTime: '23:59',
        isClosed: true,
      );
      expect(r.toJson(), {
        'specificDate': '2026-12-25',
        'startTime': '00:00',
        'endTime': '23:59',
        'isClosed': true,
      });
    });
  });
}
