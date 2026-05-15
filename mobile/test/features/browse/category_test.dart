// EthioLink Mobile — Category model parsing tests.

import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/features/browse/models/category.dart';

void main() {
  group('Category.fromJson', () {
    test('parses the documented CategoryView shape', () {
      final c = Category.fromJson(<String, dynamic>{
        'id': '11111111-1111-1111-1111-111111111111',
        'slug': 'salon',
        'name': {'en': 'Salon', 'am': 'ሳሎን'},
        'sortOrder': 1,
        'createdAt': '2026-05-01T00:00:00Z',
        'updatedAt': '2026-05-01T00:00:00Z',
      });
      expect(c.id, '11111111-1111-1111-1111-111111111111');
      expect(c.slug, 'salon');
      expect(c.nameEn, 'Salon');
      expect(c.nameAm, 'ሳሎን');
      expect(c.sortOrder, 1);
    });

    test('accepts an absent am name', () {
      final c = Category.fromJson(<String, dynamic>{
        'id': 'a',
        'slug': 'spa',
        'name': {'en': 'Spa'},
        'sortOrder': 3,
      });
      expect(c.nameAm, isNull);
    });

    test('throws when name.en is missing', () {
      expect(
        () => Category.fromJson(<String, dynamic>{
          'id': 'a',
          'slug': 's',
          'name': <String, dynamic>{},
          'sortOrder': 1,
        }),
        throwsFormatException,
      );
    });

    test('throws on non-integer sortOrder', () {
      expect(
        () => Category.fromJson(<String, dynamic>{
          'id': 'a',
          'slug': 's',
          'name': {'en': 'X'},
          'sortOrder': 'one',
        }),
        throwsFormatException,
      );
    });

    test('throws on non-object input', () {
      expect(() => Category.fromJson('nope'), throwsFormatException);
    });
  });

  group('Category.listFromJson', () {
    test('parses the CategoryList response wrapper', () {
      final items = Category.listFromJson(<String, dynamic>{
        'items': [
          {
            'id': 'a',
            'slug': 'salon',
            'name': {'en': 'Salon'},
            'sortOrder': 1,
          },
          {
            'id': 'b',
            'slug': 'spa',
            'name': {'en': 'Spa'},
            'sortOrder': 3,
          },
        ],
        'nextCursor': null,
      });
      expect(items, hasLength(2));
      expect(items[0].slug, 'salon');
      expect(items[1].slug, 'spa');
    });

    test('returns empty list when items is empty', () {
      final items = Category.listFromJson(<String, dynamic>{
        'items': <dynamic>[],
        'nextCursor': null,
      });
      expect(items, isEmpty);
    });

    test('throws when items is missing', () {
      expect(
        () => Category.listFromJson(<String, dynamic>{}),
        throwsFormatException,
      );
    });
  });
}
