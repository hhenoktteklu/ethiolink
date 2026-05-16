// EthioLink Mobile — OwnerBusinessView model.
//
// Mirrors the OpenAPI `BusinessOwnerView` schema: every field on
// `BusinessPublicView` (already captured by `BusinessDetail`) plus
// the owner-only `status` + `ownerUserId` fields the public view
// omits.
//
// Composition over inheritance — wraps a `BusinessDetail` and
// surfaces the extra fields directly. Keeps the existing
// `BusinessDetail` model untouched (the customer surface uses it
// without `status`) while exposing one type the owner-side code
// path consumes.

import '../../browse/models/business_detail.dart';

class OwnerBusinessView {
  const OwnerBusinessView({
    required this.detail,
    required this.status,
    required this.ownerUserId,
  });

  final BusinessDetail detail;

  /// One of `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `REJECTED`,
  /// `SUSPENDED`. The owner UI branches on this — DRAFT shows
  /// the "submit for review" CTA, PENDING_REVIEW shows the
  /// waiting state, APPROVED shows the dashboard, REJECTED shows
  /// the edit-and-resubmit path, SUSPENDED shows contact-support
  /// copy.
  final String status;

  final String ownerUserId;

  /// Convenience getters — keep call sites concise without
  /// surfacing every `BusinessDetail` field as a one-liner here.
  String get id => detail.id;
  String? get name => detail.name;
  String? get city => detail.city;
  String? get descriptionEn => detail.descriptionEn;
  double get ratingAvg => detail.ratingAvg;
  int get ratingCount => detail.ratingCount;

  /// True when the business is ready to take bookings.
  bool get isApproved => status == 'APPROVED';

  /// True when the owner can submit a DRAFT for review or
  /// resubmit a REJECTED one.
  bool get isSubmittable => status == 'DRAFT' || status == 'REJECTED';

  /// True when the business is locked from owner-side mutations
  /// (PENDING_REVIEW awaits admin action; SUSPENDED needs
  /// contact-support).
  bool get isReadOnly =>
      status == 'PENDING_REVIEW' || status == 'SUSPENDED';

  factory OwnerBusinessView.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'OwnerBusinessView JSON must be an object.',
      );
    }
    final status = json['status'];
    if (status is! String || status.isEmpty) {
      throw const FormatException(
        'OwnerBusinessView.status missing or non-string.',
      );
    }
    final ownerUserId = json['ownerUserId'];
    if (ownerUserId is! String || ownerUserId.isEmpty) {
      throw const FormatException(
        'OwnerBusinessView.ownerUserId missing or non-string.',
      );
    }

    // Reuse the existing `BusinessDetail.fromJson` to decode the
    // public-view fields. The owner endpoint returns a superset
    // so the same parse target applies.
    return OwnerBusinessView(
      detail: BusinessDetail.fromJson(json),
      status: status,
      ownerUserId: ownerUserId,
    );
  }
}
