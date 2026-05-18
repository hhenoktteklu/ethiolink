// EthioLink Mobile — owner-side submit-readiness check.
//
// Mirrors the backend's `missingForSubmit` rule (in
// `backend/shared/domains/businesses/businessService.ts`) so the
// mobile dashboard can pre-flight a submit BEFORE issuing the
// network call. Two payoffs:
//
//   1. We never present the vague backend message
//      ("Business is missing required fields for submission")
//      directly to the owner. The owner sees a structured
//      "Complete these before submitting:" checklist that names
//      every blocking section.
//
//   2. The submit-for-review button doesn't blindly hit a
//      backend that is going to 400. Wasted round-trip,
//      confusing UX.
//
// The backend list is the source of truth — if a future commit
// adds a new required field (e.g. mandates phone), this module
// MUST be updated to match. The mismatched-rules case is
// handled defensively by the server-side check: a 400 with
// `details.missing[]` flows through `BusinessActionFailure.missingFields`
// and the same checklist UI renders it. Both code paths share
// the [SubmitReadinessIssue] mapping in `issueForBackendField`,
// so a backend-added field surfaces with the human label
// instead of the raw symbol — as long as a translation is
// added here.

import 'models/owner_business_view.dart';

/// One specific blocker on the path to PENDING_REVIEW. The
/// dashboard groups issues by [section] and renders each
/// [fieldLabel] under it.
class SubmitReadinessIssue {
  const SubmitReadinessIssue({
    required this.backendFieldKey,
    required this.section,
    required this.fieldLabel,
  });

  /// The wire field name (matches `missingForSubmit` in
  /// `businessService.ts`). Stable across releases; the section
  /// + fieldLabel may rephrase but this key stays the same.
  final String backendFieldKey;

  /// User-facing section label — "Profile", "Services",
  /// "Staff", "Availability". Used as the checklist group
  /// heading.
  final String section;

  /// User-facing field label — "Business name", "Description",
  /// "City", etc. Shown as a bullet under the section.
  final String fieldLabel;
}

/// Result of evaluating an OwnerBusinessView against the submit
/// rules. [isReady] is the only thing most callers need; the
/// dashboard renders [issues] grouped by [section].
class SubmitReadiness {
  const SubmitReadiness(this.issues);

  /// In display order — Profile issues first, Services next,
  /// then Staff, then Availability. Empty when ready.
  final List<SubmitReadinessIssue> issues;

  bool get isReady => issues.isEmpty;

  /// Returns the unique section labels that have at least one
  /// blocker. Used by the dashboard cards to render a "Missing
  /// info" chip on the right cards.
  Set<String> get blockedSections =>
      issues.map((i) => i.section).toSet();
}

/// Compute readiness from an [OwnerBusinessView]. Mirrors the
/// backend's `missingForSubmit` exactly today (name +
/// description.en + city + categoryId). Services / staff /
/// availability are NOT server-side submit gates in the current
/// release, but the function-level docs spell out where to add
/// them when that changes.
SubmitReadiness evaluateSubmitReadiness(OwnerBusinessView business) {
  final issues = <SubmitReadinessIssue>[];

  // ----- Profile section -------------------------------------------------
  if (_isBlank(business.name)) {
    issues.add(const SubmitReadinessIssue(
      backendFieldKey: 'name',
      section: 'Profile',
      fieldLabel: 'Business name',
    ));
  }
  if (_isBlank(business.descriptionEn)) {
    issues.add(const SubmitReadinessIssue(
      backendFieldKey: 'description',
      section: 'Profile',
      fieldLabel: 'Description',
    ));
  }
  if (_isBlank(business.city)) {
    issues.add(const SubmitReadinessIssue(
      backendFieldKey: 'city',
      section: 'Profile',
      fieldLabel: 'City',
    ));
  }
  // categoryId is NOT NULL at the DB layer and is set by the
  // create-business flow's mandatory category dropdown, so this
  // is never expected to fire in practice. Kept for parity with
  // the backend check.
  if (business.detail.categoryId.isEmpty) {
    issues.add(const SubmitReadinessIssue(
      backendFieldKey: 'categoryId',
      section: 'Profile',
      fieldLabel: 'Category',
    ));
  }

  return SubmitReadiness(List.unmodifiable(issues));
}

/// Map a backend `missing[]` field name to a
/// [SubmitReadinessIssue] for rendering the checklist when the
/// 400 came from the server (e.g. concurrent edits cleared a
/// field between the dashboard's last refresh and the submit
/// tap). The dashboard reuses the same checklist widget for
/// both branches, so the user always sees the same layout.
///
/// Returns `null` for unknown field names — the UI falls back to
/// surfacing the raw symbol so we don't silently hide a new
/// backend gate.
SubmitReadinessIssue? issueForBackendField(String key) {
  switch (key) {
    case 'name':
      return const SubmitReadinessIssue(
        backendFieldKey: 'name',
        section: 'Profile',
        fieldLabel: 'Business name',
      );
    case 'description':
      return const SubmitReadinessIssue(
        backendFieldKey: 'description',
        section: 'Profile',
        fieldLabel: 'Description',
      );
    case 'city':
      return const SubmitReadinessIssue(
        backendFieldKey: 'city',
        section: 'Profile',
        fieldLabel: 'City',
      );
    case 'categoryId':
      return const SubmitReadinessIssue(
        backendFieldKey: 'categoryId',
        section: 'Profile',
        fieldLabel: 'Category',
      );
    default:
      return null;
  }
}

bool _isBlank(String? value) {
  if (value == null) return true;
  return value.trim().isEmpty;
}
