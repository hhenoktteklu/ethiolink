// EthioLink Mobile — per-role experience configuration.
//
// Centralizes everything the app needs to know about how to
// present a given user's role:
//
//   * brand palette (primary seed colour + accent), used by
//     `role_theme.dart` to derive a `ThemeData`;
//   * landing hero copy (headline + sub) for the Browse tab;
//   * bottom-navigation destinations the user actually has
//     access to;
//   * a stable role label for use in chips, AppBar subtitles,
//     and the per-role banner on the Browse tab.
//
// Roles map 1:1 to the backend's Cognito-group precedence:
//   ADMIN > BUSINESS_OWNER > CUSTOMER
// (see `backend/shared/adapters/auth/AuthProvider.ts`). The
// `RoleExperience.forSession(session)` factory honours that
// precedence; if a server upstream ever leaks a fourth role
// value we fall back to the customer experience rather than
// rendering a half-rendered shell.
//
// Why a config file (not a Theme/Widget per role):
//   * Predictable diffing — palette + nav set + hero copy all
//     live next to each other in this file. The colour designer
//     edits one constant and every consumer picks up the change
//     on the next build.
//   * Test friendliness — `RoleExperience` is a plain Dart class
//     with `==` semantics so widget + unit tests can pin the
//     contract per role without inspecting widget trees.
//
// What this file deliberately does NOT do:
//   * Build widgets. Per-role widget construction (which tabs
//     wrap which screens, what banner to show on Browse) lives
//     on the call site (`browse_screen.dart`, `admin_home_screen.dart`).
//   * Localise copy. Hero text is in English here. Track 5's
//     ARB-driven localization track will replace these literals
//     with `AppLocalizations` getters once the strings stabilise;
//     for now they are inline so a redesign doesn't fight the
//     ARB churn.

import 'package:flutter/material.dart';

import '../auth/auth_service.dart';

/// One bottom-nav destination identifier. The Browse screen owns
/// the actual `NavigationDestination` + tab-body construction;
/// this enum is just the contract.
enum RoleNavDestination {
  /// Marketplace browse (categories + search). Customer-facing.
  /// Admin does NOT carry this anymore — admin uses
  /// [adminReviewQueue] as the landing tab instead.
  browse,

  /// Customer's own appointment history.
  bookings,

  /// BUSINESS_OWNER-only dashboard with manage-business actions.
  ownerDashboard,

  /// ADMIN-only mobile review queue. Lists every PENDING_REVIEW
  /// business with inline Approve / Reject actions.
  adminReviewQueue,

  /// ADMIN-only informational landing — points the operator at
  /// the admin web SPA for full admin tools (featuring history,
  /// audit, etc. — operations the mobile review queue
  /// intentionally doesn't cover).
  adminHome,

  /// Settings / sign-out / language / Telegram linking. Always
  /// present.
  profile,
}

/// Immutable per-role configuration. Three instances ship in the
/// app today (`customer`, `businessOwner`, `admin`); add a fourth
/// only by adding a corresponding role string + Cognito group +
/// backend precedence entry.
@immutable
class RoleExperience {
  const RoleExperience({
    required this.role,
    required this.label,
    required this.heroHeadline,
    required this.heroSubtitle,
    required this.primarySeed,
    required this.accent,
    required this.destinations,
  });

  /// Backend wire value — `'CUSTOMER'`, `'BUSINESS_OWNER'`, or
  /// `'ADMIN'`. Matches the `users.role` column + the Cognito
  /// group names. Single source of truth for role comparisons.
  final String role;

  /// Human-readable label shown in chips / AppBar subtitles
  /// (e.g. "Business owner"). NOT a brand name — the app brand
  /// stays "EthioLink" across all roles.
  final String label;

  /// First line on the Browse hero. Sets the tone for each role.
  final String heroHeadline;

  /// Secondary line under the headline. Same hero.
  final String heroSubtitle;

  /// Seed colour fed into `ColorScheme.fromSeed`. Drives the
  /// AppBar, FilledButtons, NavigationBar indicator, etc.
  final Color primarySeed;

  /// Secondary accent. Used for callouts (the role banner on
  /// Browse, the highlight bar on a quick-action card).
  final Color accent;

  /// Bottom-nav destinations in display order. The first entry is
  /// the one the user lands on after sign-in.
  final List<RoleNavDestination> destinations;

  // -----------------------------------------------------------------------
  // Static configurations
  // -----------------------------------------------------------------------

  /// Marketplace consumer — warm, friendly. Teal + warm orange
  /// accent. Three tabs: Browse, Bookings, Profile.
  static const RoleExperience customer = RoleExperience(
    role: 'CUSTOMER',
    label: 'Customer',
    heroHeadline: 'Find services near you',
    heroSubtitle:
        'Discover salons, barbers, spas, and beauty pros across Ethiopia.',
    // Teal-700 (#0F766E) reads as friendly + service-oriented;
    // pairs with orange-400 (#FB923C) accent for the "Book now"
    // callouts the design pass will introduce.
    primarySeed: Color(0xFF0F766E),
    accent: Color(0xFFFB923C),
    destinations: [
      RoleNavDestination.browse,
      RoleNavDestination.bookings,
      RoleNavDestination.profile,
    ],
  );

  /// Business owner — professional dashboard. Indigo + gold
  /// accent. Four tabs: Browse, Bookings, My Business, Profile.
  static const RoleExperience businessOwner = RoleExperience(
    role: 'BUSINESS_OWNER',
    label: 'Business owner',
    heroHeadline: 'Manage your business',
    heroSubtitle:
        'Appointments, services, staff, and promotion — all in one place.',
    // Indigo-600 (#4F46E5) is the "operator tools" colour from
    // the admin SPA's palette; gold (#D4AF37) is the highlight
    // we already use on featured-business badges.
    primarySeed: Color(0xFF4F46E5),
    accent: Color(0xFFD4AF37),
    destinations: [
      RoleNavDestination.browse,
      RoleNavDestination.bookings,
      RoleNavDestination.ownerDashboard,
      RoleNavDestination.profile,
    ],
  );

  /// Admin operator — review-first console. Slate + amber-
  /// warning accent. Three tabs: Review Queue, Admin Home,
  /// Profile.
  ///
  /// Mobile admin is intentionally NOT a customer browse —
  /// admins approve / reject pending submissions from the
  /// Review Queue tab. Full admin tools (featuring history,
  /// audit, status filters beyond pending) live in the admin
  /// web SPA, which the AdminHome tab links to. The slate
  /// palette is deliberately darker than the customer / owner
  /// palettes so the admin context is visually unmistakable.
  static const RoleExperience admin = RoleExperience(
    role: 'ADMIN',
    label: 'Operator',
    heroHeadline: 'Review queue',
    heroSubtitle:
        'Approve or reject submitted businesses. Full admin tools live in the web console.',
    primarySeed: Color(0xFF334155),
    accent: Color(0xFFF59E0B),
    destinations: [
      RoleNavDestination.adminReviewQueue,
      RoleNavDestination.adminHome,
      RoleNavDestination.profile,
    ],
  );

  // -----------------------------------------------------------------------
  // Selection
  // -----------------------------------------------------------------------

  /// Resolve a `RoleExperience` from an `AuthSession`. Defends
  /// against unknown role strings by falling back to the customer
  /// experience — every authenticated user is at minimum a
  /// customer; the precedence rule lives in the backend, this
  /// factory just maps the resolved wire value to a config.
  factory RoleExperience.forSession(AuthSession session) {
    return RoleExperience.forRole(session.role);
  }

  /// Direct lookup by role string. Useful in tests that don't
  /// want to spin up a full `AuthSession`.
  factory RoleExperience.forRole(String role) {
    switch (role) {
      case 'ADMIN':
        return admin;
      case 'BUSINESS_OWNER':
        return businessOwner;
      case 'CUSTOMER':
        return customer;
      default:
        // Unknown / mistyped role strings fall back to the customer
        // experience. This matches the backend's deriveRole default
        // (`return 'CUSTOMER'`) and prevents a stale-cache
        // production user from booting into a half-themed shell.
        return customer;
    }
  }

  // Two RoleExperience instances are equal iff every field is.
  // Plain-old-Dart equality keeps widget tests crisp.
  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    if (other is! RoleExperience) return false;
    return role == other.role &&
        label == other.label &&
        heroHeadline == other.heroHeadline &&
        heroSubtitle == other.heroSubtitle &&
        primarySeed == other.primarySeed &&
        accent == other.accent &&
        _listEquals(destinations, other.destinations);
  }

  @override
  int get hashCode => Object.hash(
        role,
        label,
        heroHeadline,
        heroSubtitle,
        primarySeed,
        accent,
        Object.hashAll(destinations),
      );
}

bool _listEquals<T>(List<T> a, List<T> b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i += 1) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
