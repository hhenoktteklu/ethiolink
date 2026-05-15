// EthioLink Mobile — BusinessSummary model + page tests.

import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/features/browse/models/business_summary.dart';

void main() {
  group('BusinessSummary.fromJson', () {
    test('parses every documented field', () {
      final b = BusinessSummary.fromJson(<String, dynamic>{
        'id': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'categoryId': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'name': 'Sunset Salon',
        'city': 'Addis Ababa',
        'ratingAvg': 4.7,
        'ratingCount': 23,
        'featuredUntil': '2030-01-01T00:00:00Z',
        'createdAt': '2026-04-01T00:00:00Z',
        'updatedAt': '2026-05-01T00:00:00Z',
      });
      expect(b.id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      expect(b.categoryId, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
      expect(b.name, 'Sunset Salon');
      expect(b.city, 'Addis Ababa');
      expect(b.ratingAvg, 4.7);
      expect(b.ratingCount, 23);
      expect(b.featuredUntil, isNotNull);
      expect(b.isCurrentlyFeatured(now: DateTime.utc(2027)), isTrue);
    });

    test('treats null name + city as null and ratingAvg=int as double', () {
      final b = BusinessSummary.fromJson(<String, dynamic>{
        'id': 'x',
        'categoryId': 'y',
        'name': null,
        'city': null,
        'ratingAvg': 0, // int — must coerce to double.
        'ratingCount': 0,
      });
      expect(b.name, isNull);
      expect(b.city, isNull);
      expect(b.ratingAvg, 0.0);
      expect(b.isCurrentlyFeatured(), isFalse);
    });

    test('isCurrentlyFeatured is false when the date is in the past', () {
      final b = BusinessSummary.fromJson(<String, dynamic>{
        'id': 'x',
        'categoryId': 'y',
        'ratingAvg': 1.0,
        'ratingCount': 1,
        'featuredUntil': '2020-01-01T00:00:00Z',
      });
      expect(b.isCurrentlyFeatured(now: DateTime.utc(2026)), isFalse);
    });

    test('throws when id is missing', () {
      expect(
        () => BusinessSummary.fromJson(<String, dynamic>{
          'categoryId': 'y',
          'ratingAvg': 1,
          'ratingCount': 1,
        }),
        throwsFormatException,
      );
    });

    test('throws on non-numeric ratingAvg', () {
      expect(
        () => BusinessSummary.fromJson(<String, dynamic>{
          'id': 'x',
          'categoryId': 'y',
          'ratingAvg': '4.7',
          'ratingCount': 1,
        }),
        throwsFormatException,
      );
    });
  });

  group('BusinessListPage.fromJson', () {
    test('parses items + nextCursor', () {
      final page = BusinessListPage.fromJson(<String, dynamic>{
        'items': [
          {
            'id': 'a',
            'categoryId': 'cat',
            'ratingAvg': 4.0,
            'ratingCount': 1,
            'name': 'A',
          },
          {
            'id': 'b',
            'categoryId': 'cat',
            'ratingAvg': 3.0,
            'ratingCount': 0,
            'name': 'B',
          },
        ],
        'nextCursor': 'cursor-xyz',
      });
      expect(page.items, hasLength(2));
      expect(page.items[0].name, 'A');
      expect(page.nextCursor, 'cursor-xyz');
    });

    test('treats null nextCursor as no-more-pages', () {
      final page = BusinessListPage.fromJson(<String, dynamic>{
        'items': <dynamic>[],
        'nextCursor': null,
      });
      expect(page.items, isEmpty);
      expect(page.nextCursor, isNull);
    });

    test('throws when items is missing', () {
      expect(
        () => BusinessListPage.fromJson(<String, dynamic>{
          'nextCursor': null,
        }),
        throwsFormatException,
      );
    });
  });
}
