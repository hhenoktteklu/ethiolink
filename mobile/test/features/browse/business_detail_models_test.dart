// EthioLink Mobile — model-parsing tests for the detail screen.
//
// One suite per model. Covers happy-path decode + the required-
// field throws. The list-envelope variants are exercised through
// the `listFromJson` factories.

import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/features/browse/models/business_detail.dart';
import 'package:ethiolink/features/browse/models/review.dart';
import 'package:ethiolink/features/browse/models/service.dart';
import 'package:ethiolink/features/browse/models/staff.dart';

void main() {
  group('BusinessDetail.fromJson', () {
    test('parses every documented field', () {
      final d = BusinessDetail.fromJson(<String, dynamic>{
        'id': 'biz-1',
        'categoryId': 'cat-1',
        'name': 'Sunset Salon',
        'description': {'en': 'Best in town.', 'am': 'የቤት ምርጥ'},
        'city': 'Addis Ababa',
        'addressLine': 'Bole, Wello Sefer',
        'latitude': 9.03,
        'longitude': 38.74,
        'phone': '+251911000001',
        'telegramHandle': 'sunsetsalon',
        'whatsappPhone': '+251911000001',
        'featuredUntil': '2030-01-01T00:00:00Z',
        'ratingAvg': 4.7,
        'ratingCount': 23,
        'createdAt': '2026-04-01T00:00:00Z',
        'updatedAt': '2026-05-01T00:00:00Z',
      });
      expect(d.id, 'biz-1');
      expect(d.name, 'Sunset Salon');
      expect(d.descriptionEn, 'Best in town.');
      expect(d.descriptionAm, 'የቤት ምርጥ');
      expect(d.city, 'Addis Ababa');
      expect(d.addressLine, 'Bole, Wello Sefer');
      expect(d.latitude, 9.03);
      expect(d.longitude, 38.74);
      expect(d.phone, '+251911000001');
      expect(d.telegramHandle, 'sunsetsalon');
      expect(d.whatsappPhone, '+251911000001');
      expect(d.ratingAvg, 4.7);
      expect(d.ratingCount, 23);
      expect(d.isCurrentlyFeatured, isTrue);
      expect(d.hasAnyContact, isTrue);
    });

    test('tolerates null optional fields', () {
      final d = BusinessDetail.fromJson(<String, dynamic>{
        'id': 'b',
        'categoryId': 'c',
        'name': null,
        'description': null,
        'city': null,
        'addressLine': null,
        'latitude': null,
        'longitude': null,
        'phone': null,
        'telegramHandle': null,
        'whatsappPhone': null,
        'featuredUntil': null,
        'ratingAvg': 0,
        'ratingCount': 0,
      });
      expect(d.name, isNull);
      expect(d.descriptionEn, isNull);
      expect(d.hasAnyContact, isFalse);
      expect(d.isCurrentlyFeatured, isFalse);
    });

    test('throws on missing id', () {
      expect(
        () => BusinessDetail.fromJson(<String, dynamic>{
          'categoryId': 'c',
          'ratingAvg': 1,
          'ratingCount': 0,
        }),
        throwsFormatException,
      );
    });
  });

  group('Service.fromJson', () {
    test('parses fields including optional priceEtb + descriptionEn', () {
      final s = Service.fromJson(<String, dynamic>{
        'id': 'srv-1',
        'businessId': 'biz-1',
        'name': {'en': 'Haircut', 'am': 'ኮንት'},
        'description': {'en': 'Standard haircut.'},
        'durationMinutes': 30,
        'priceEtb': 300,
        'isActive': true,
        'createdAt': '2026-04-01T00:00:00Z',
        'updatedAt': '2026-04-01T00:00:00Z',
      });
      expect(s.id, 'srv-1');
      expect(s.businessId, 'biz-1');
      expect(s.nameEn, 'Haircut');
      expect(s.descriptionEn, 'Standard haircut.');
      expect(s.durationMinutes, 30);
      expect(s.priceEtb, 300.0);
      expect(s.isActive, isTrue);
    });

    test('treats null priceEtb as null', () {
      final s = Service.fromJson(<String, dynamic>{
        'id': 's',
        'businessId': 'b',
        'name': {'en': 'X'},
        'durationMinutes': 15,
        'priceEtb': null,
        'isActive': true,
      });
      expect(s.priceEtb, isNull);
    });

    test('throws on non-positive duration', () {
      expect(
        () => Service.fromJson(<String, dynamic>{
          'id': 's',
          'businessId': 'b',
          'name': {'en': 'X'},
          'durationMinutes': 0,
          'isActive': true,
        }),
        throwsFormatException,
      );
    });

    test('listFromJson decodes the ServiceList envelope', () {
      final items = Service.listFromJson(<String, dynamic>{
        'items': [
          {
            'id': 'a',
            'businessId': 'b',
            'name': {'en': 'A'},
            'durationMinutes': 15,
            'isActive': true,
          },
        ],
        'nextCursor': null,
      });
      expect(items, hasLength(1));
      expect(items[0].nameEn, 'A');
    });
  });

  group('Staff.fromJson', () {
    test('parses displayName + optional role', () {
      final s = Staff.fromJson(<String, dynamic>{
        'id': 'st-1',
        'businessId': 'biz-1',
        'displayName': 'Hana',
        'role': 'Senior Stylist',
        'isActive': true,
        'createdAt': '2026-04-01T00:00:00Z',
        'updatedAt': '2026-04-01T00:00:00Z',
      });
      expect(s.displayName, 'Hana');
      expect(s.role, 'Senior Stylist');
    });

    test('treats null role as null', () {
      final s = Staff.fromJson(<String, dynamic>{
        'id': 'st',
        'businessId': 'b',
        'displayName': 'Hana',
        'role': null,
        'isActive': true,
      });
      expect(s.role, isNull);
    });

    test('throws on empty displayName', () {
      expect(
        () => Staff.fromJson(<String, dynamic>{
          'id': 's',
          'businessId': 'b',
          'displayName': '',
          'isActive': true,
        }),
        throwsFormatException,
      );
    });
  });

  group('Review.fromJson', () {
    test('parses rating + comment + createdAt', () {
      final r = Review.fromJson(<String, dynamic>{
        'id': 'rev-1',
        'appointmentId': 'apt-1',
        'customerId': 'cust-1',
        'businessId': 'biz-1',
        'rating': 5,
        'comment': 'Excellent.',
        'createdAt': '2026-05-01T00:00:00Z',
        'updatedAt': '2026-05-01T00:00:00Z',
      });
      expect(r.rating, 5);
      expect(r.comment, 'Excellent.');
      expect(r.createdAt.toUtc().year, 2026);
    });

    test('treats null comment as null', () {
      final r = Review.fromJson(<String, dynamic>{
        'id': 'r',
        'appointmentId': 'a',
        'customerId': 'c',
        'businessId': 'b',
        'rating': 3,
        'comment': null,
        'createdAt': '2026-05-01T00:00:00Z',
      });
      expect(r.comment, isNull);
    });

    test('throws on out-of-range rating', () {
      expect(
        () => Review.fromJson(<String, dynamic>{
          'id': 'r',
          'appointmentId': 'a',
          'customerId': 'c',
          'businessId': 'b',
          'rating': 6,
          'createdAt': '2026-05-01T00:00:00Z',
        }),
        throwsFormatException,
      );
    });
  });
}
