// EthioLink Mobile — Slot model tests.

import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/features/booking/models/slot.dart';

void main() {
  group('Slot.fromJson', () {
    test('parses start + end and exposes the original ISO string', () {
      final s = Slot.fromJson(<String, dynamic>{
        'startUtc': '2026-05-15T09:30:00.000Z',
        'endUtc': '2026-05-15T10:00:00.000Z',
      });
      expect(s.startUtc.isUtc, isTrue);
      expect(s.endUtc.difference(s.startUtc), const Duration(minutes: 30));
      expect(s.startUtcIso, '2026-05-15T09:30:00.000Z');
    });

    test('throws when startUtc is missing', () {
      expect(
        () => Slot.fromJson(<String, dynamic>{
          'endUtc': '2026-05-15T10:00:00.000Z',
        }),
        throwsFormatException,
      );
    });
  });

  group('Slot.listFromJson', () {
    test('parses the SlotList envelope', () {
      final slots = Slot.listFromJson(<String, dynamic>{
        'items': [
          {
            'startUtc': '2026-05-15T09:00:00.000Z',
            'endUtc': '2026-05-15T09:30:00.000Z',
          },
          {
            'startUtc': '2026-05-15T09:30:00.000Z',
            'endUtc': '2026-05-15T10:00:00.000Z',
          },
        ],
      });
      expect(slots, hasLength(2));
    });

    test('returns empty list when items is empty', () {
      final slots = Slot.listFromJson(<String, dynamic>{'items': <dynamic>[]});
      expect(slots, isEmpty);
    });

    test('throws when items is missing', () {
      expect(
        () => Slot.listFromJson(<String, dynamic>{}),
        throwsFormatException,
      );
    });
  });
}
