// EthioLink Mobile — OwnerBusinessView parsing tests.

import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/features/owner/models/owner_business_view.dart';

Map<String, dynamic> _payload({
  String id = 'biz-1',
  String? name = 'Sunset Salon',
  String status = 'APPROVED',
  String ownerUserId = 'owner-1',
}) {
  return <String, dynamic>{
    'id': id,
    'categoryId': 'cat-1',
    'name': name,
    'description': {'en': 'Best in town.'},
    'city': 'Addis Ababa',
    'addressLine': null,
    'latitude': null,
    'longitude': null,
    'phone': '+251911000001',
    'telegramHandle': null,
    'whatsappPhone': null,
    'featuredUntil': null,
    'ratingAvg': 4.5,
    'ratingCount': 10,
    'status': status,
    'ownerUserId': ownerUserId,
    'createdAt': '2026-05-01T00:00:00.000Z',
    'updatedAt': '2026-05-01T00:00:00.000Z',
  };
}

void main() {
  group('OwnerBusinessView.fromJson', () {
    test('parses every field including status + ownerUserId', () {
      final v = OwnerBusinessView.fromJson(_payload());
      expect(v.id, 'biz-1');
      expect(v.name, 'Sunset Salon');
      expect(v.status, 'APPROVED');
      expect(v.ownerUserId, 'owner-1');
      expect(v.ratingAvg, 4.5);
      expect(v.ratingCount, 10);
    });

    test('status predicates classify the documented states', () {
      OwnerBusinessView atStatus(String s) =>
          OwnerBusinessView.fromJson(_payload(status: s));
      expect(atStatus('APPROVED').isApproved, isTrue);
      expect(atStatus('APPROVED').isSubmittable, isFalse);
      expect(atStatus('APPROVED').isReadOnly, isFalse);
      expect(atStatus('DRAFT').isSubmittable, isTrue);
      expect(atStatus('REJECTED').isSubmittable, isTrue);
      expect(atStatus('PENDING_REVIEW').isReadOnly, isTrue);
      expect(atStatus('SUSPENDED').isReadOnly, isTrue);
    });

    test('throws when status is missing', () {
      final json = _payload()..remove('status');
      expect(
        () => OwnerBusinessView.fromJson(json),
        throwsFormatException,
      );
    });

    test('throws when ownerUserId is missing', () {
      final json = _payload()..remove('ownerUserId');
      expect(
        () => OwnerBusinessView.fromJson(json),
        throwsFormatException,
      );
    });
  });
}
