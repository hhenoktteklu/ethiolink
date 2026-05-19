// EthioLink Mobile — RoleExperience contract tests.
//
// Pins three invariants the rest of the role-aware UI relies on:
//
//   1. RoleExperience.forSession(...) resolves every wire role
//      ('CUSTOMER', 'BUSINESS_OWNER', 'ADMIN') to the matching
//      static configuration, and unknown roles fall back to the
//      customer experience. This mirrors the backend's
//      `deriveRole` default in
//      `backend/shared/adapters/auth/AuthProvider.ts` — keep the
//      two in lock-step so a mistyped role can't blow up the
//      shell.
//
//   2. The three configurations carry distinct palettes + hero
//      copy + nav sets. If two roles ever happen to share a
//      palette accidentally, the visual differentiation the spec
//      asks for is lost.
//
//   3. The "always-present" destinations rule:
//        every role has Browse + Profile;
//        Bookings is on for customer + owner (not admin — mobile
//          admin context is read-only);
//        ownerDashboard is owner-only;
//        adminHome is admin-only.
//      That's the contract `browse_screen.dart` iterates.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/auth/auth_service.dart';
import 'package:ethiolink/core/role/role_experience.dart';

AuthSession _session(String role) {
  return AuthSession(
    userId: 'sub-1',
    email: 'demo@ethiolink.test',
    role: role,
    expiresAt: DateTime.utc(2030),
  );
}

void main() {
  group('RoleExperience.forSession', () {
    test('CUSTOMER → customer config', () {
      expect(
        RoleExperience.forSession(_session('CUSTOMER')),
        RoleExperience.customer,
      );
    });

    test('BUSINESS_OWNER → businessOwner config', () {
      expect(
        RoleExperience.forSession(_session('BUSINESS_OWNER')),
        RoleExperience.businessOwner,
      );
    });

    test('ADMIN → admin config', () {
      expect(
        RoleExperience.forSession(_session('ADMIN')),
        RoleExperience.admin,
      );
    });

    test('unknown role falls back to customer (matches backend default)',
        () {
      expect(
        RoleExperience.forSession(_session('SOMETHING_ELSE')),
        RoleExperience.customer,
      );
      expect(
        RoleExperience.forSession(_session('')),
        RoleExperience.customer,
      );
    });
  });

  group('configurations are distinct', () {
    test('every pair has a different primary palette', () {
      // `RoleExperience.customer.primarySeed` is a property access
      // on a static const instance; reading it isn't itself a
      // compile-time constant expression, so the list has to be
      // `final` rather than `const`.
      final palettes = <Color>[
        RoleExperience.customer.primarySeed,
        RoleExperience.businessOwner.primarySeed,
        RoleExperience.admin.primarySeed,
      ];
      // Three colours, no duplicates.
      expect(palettes.toSet().length, palettes.length);
    });

    test('hero headlines are role-specific', () {
      expect(RoleExperience.customer.heroHeadline,
          'Find services near you');
      expect(RoleExperience.businessOwner.heroHeadline,
          'Manage your business');
      expect(RoleExperience.admin.heroHeadline, 'Operator console');
    });

    test('role labels are role-specific', () {
      expect(RoleExperience.customer.label, 'Customer');
      expect(RoleExperience.businessOwner.label, 'Business owner');
      expect(RoleExperience.admin.label, 'Operator');
    });
  });

  group('nav destinations per role', () {
    test('customer: Browse, Bookings, Profile', () {
      expect(
        RoleExperience.customer.destinations,
        const <RoleNavDestination>[
          RoleNavDestination.browse,
          RoleNavDestination.bookings,
          RoleNavDestination.profile,
        ],
      );
    });

    test('business owner: Browse, Bookings, OwnerDashboard, Profile', () {
      expect(
        RoleExperience.businessOwner.destinations,
        const <RoleNavDestination>[
          RoleNavDestination.browse,
          RoleNavDestination.bookings,
          RoleNavDestination.ownerDashboard,
          RoleNavDestination.profile,
        ],
      );
    });

    test(
      'admin: ReviewQueue, AdminHome, Profile '
      '(NO customer Browse; NO Bookings; NO OwnerDashboard)',
      () {
        expect(
          RoleExperience.admin.destinations,
          const <RoleNavDestination>[
            RoleNavDestination.adminReviewQueue,
            RoleNavDestination.adminHome,
            RoleNavDestination.profile,
          ],
        );
        // Sentinels — the spec is "Admin must NOT show customer
        // booking functionality" so none of the customer-facing
        // tabs should leak into the admin nav.
        expect(
          RoleExperience.admin.destinations,
          isNot(contains(RoleNavDestination.browse)),
        );
        expect(
          RoleExperience.admin.destinations,
          isNot(contains(RoleNavDestination.bookings)),
        );
        expect(
          RoleExperience.admin.destinations,
          isNot(contains(RoleNavDestination.ownerDashboard)),
        );
      },
    );

    test('Profile is in every role; Browse is in customer + owner only', () {
      for (final exp in <RoleExperience>[
        RoleExperience.customer,
        RoleExperience.businessOwner,
        RoleExperience.admin,
      ]) {
        expect(exp.destinations, contains(RoleNavDestination.profile));
      }
      expect(
        RoleExperience.customer.destinations,
        contains(RoleNavDestination.browse),
      );
      expect(
        RoleExperience.businessOwner.destinations,
        contains(RoleNavDestination.browse),
      );
      // Admin gets the review queue instead.
      expect(
        RoleExperience.admin.destinations,
        contains(RoleNavDestination.adminReviewQueue),
      );
    });
  });
}
