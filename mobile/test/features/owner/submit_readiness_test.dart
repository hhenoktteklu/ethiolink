// EthioLink Mobile — submit_readiness contract tests.
//
// Pins the mobile/backend parity: `evaluateSubmitReadiness`
// MUST flag the same fields that the backend's
// `missingForSubmit` (in
// `backend/shared/domains/businesses/businessService.ts`)
// flags, in the same order. If a backend change adds or
// removes a required field, this test class is the bright
// red light that catches the drift before a user does.
//
// Field list as of this test class's last update:
//   name, description, city, categoryId
//
// All Profile-section. Services / staff / availability are
// NOT server-side submit gates today and intentionally don't
// appear in the readiness output — the owner can submit a
// business with no services and the backend accepts it (the
// CUSTOMER browse just sees a less-useful row). When the
// backend tightens this, extend submit_readiness.dart AND
// add the corresponding cases here.

import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/features/browse/models/business_detail.dart';
import 'package:ethiolink/features/owner/models/owner_business_view.dart';
import 'package:ethiolink/features/owner/submit_readiness.dart';

OwnerBusinessView _business({
  String? name = 'Sunset Salon',
  String? descriptionEn = 'Best in town.',
  String? city = 'Addis Ababa',
  String categoryId = 'cat-1',
  String status = 'DRAFT',
}) {
  return OwnerBusinessView(
    detail: BusinessDetail(
      id: 'biz-1',
      categoryId: categoryId,
      name: name,
      descriptionEn: descriptionEn,
      descriptionAm: null,
      city: city,
      addressLine: null,
      latitude: null,
      longitude: null,
      phone: null,
      telegramHandle: null,
      whatsappPhone: null,
      featuredUntil: null,
      ratingAvg: 0,
      ratingCount: 0,
    ),
    status: status,
    ownerUserId: 'owner-1',
  );
}

void main() {
  group('evaluateSubmitReadiness', () {
    test('fully-populated business is ready', () {
      final readiness = evaluateSubmitReadiness(_business());
      expect(readiness.isReady, isTrue);
      expect(readiness.issues, isEmpty);
      expect(readiness.blockedSections, isEmpty);
    });

    test('blank name flags Business name under Profile', () {
      final readiness = evaluateSubmitReadiness(_business(name: ''));
      expect(readiness.isReady, isFalse);
      expect(readiness.issues.first.backendFieldKey, 'name');
      expect(readiness.issues.first.section, 'Profile');
      expect(readiness.issues.first.fieldLabel, 'Business name');
    });

    test('whitespace-only name is treated as blank', () {
      // Mirrors backend's isBlank() which trims.
      final readiness = evaluateSubmitReadiness(_business(name: '   '));
      expect(readiness.issues.any((i) => i.backendFieldKey == 'name'), isTrue);
    });

    test('null name flags Business name', () {
      final readiness = evaluateSubmitReadiness(_business(name: null));
      expect(readiness.issues.any((i) => i.backendFieldKey == 'name'), isTrue);
    });

    test('blank description flags Description under Profile', () {
      final readiness = evaluateSubmitReadiness(_business(descriptionEn: ''));
      expect(readiness.issues.first.backendFieldKey, 'description');
      expect(readiness.issues.first.fieldLabel, 'Description');
      expect(readiness.issues.first.section, 'Profile');
    });

    test('blank city flags City under Profile', () {
      final readiness = evaluateSubmitReadiness(_business(city: ''));
      expect(readiness.issues.first.backendFieldKey, 'city');
      expect(readiness.issues.first.fieldLabel, 'City');
    });

    test('empty categoryId flags Category under Profile (defensive)', () {
      // categoryId is NOT NULL at the DB layer so this branch
      // should never fire in practice — kept defensive-and-tested.
      final readiness = evaluateSubmitReadiness(_business(categoryId: ''));
      expect(
        readiness.issues.any((i) => i.backendFieldKey == 'categoryId'),
        isTrue,
      );
    });

    test('multiple missing fields flag every one', () {
      final readiness = evaluateSubmitReadiness(
        _business(name: '', descriptionEn: '', city: ''),
      );
      expect(readiness.issues.length, 3);
      expect(
        readiness.issues.map((i) => i.backendFieldKey).toList(),
        <String>['name', 'description', 'city'],
      );
      // All on the Profile section — owner only has one place
      // to go to fix them, no cross-section juggling.
      expect(readiness.blockedSections, <String>{'Profile'});
    });

    test('issues list is unmodifiable (defensive vs caller mutation)', () {
      final readiness = evaluateSubmitReadiness(_business(name: ''));
      expect(() => readiness.issues.add(readiness.issues.first), throwsA(anything));
    });
  });

  group('issueForBackendField — backend response mapping', () {
    test('translates "name" to Business name under Profile', () {
      final issue = issueForBackendField('name');
      expect(issue, isNotNull);
      expect(issue!.section, 'Profile');
      expect(issue.fieldLabel, 'Business name');
    });

    test('translates "description"', () {
      final issue = issueForBackendField('description');
      expect(issue?.fieldLabel, 'Description');
    });

    test('translates "city"', () {
      final issue = issueForBackendField('city');
      expect(issue?.fieldLabel, 'City');
    });

    test('translates "categoryId"', () {
      final issue = issueForBackendField('categoryId');
      expect(issue?.fieldLabel, 'Category');
    });

    test('returns null for unknown field keys', () {
      // The caller falls back to surfacing the raw key under
      // an "Other" section so a backend addition surfaces
      // even before the mobile catches up. See
      // _SubmittableBannerState._issuesToRender.
      expect(issueForBackendField('something_unknown'), isNull);
    });
  });
}
