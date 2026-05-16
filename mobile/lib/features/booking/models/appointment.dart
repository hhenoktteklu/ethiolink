// EthioLink Mobile — Appointment model.
//
// Mirrors the OpenAPI `AppointmentView`. Captures every field
// the booking flow's confirmation + (future) history screen
// need. The status field is a closed string union per the
// `AppointmentStatus` enum.

class Appointment {
  const Appointment({
    required this.id,
    required this.customerId,
    required this.businessId,
    required this.serviceId,
    required this.staffId,
    required this.startsAt,
    required this.endsAt,
    required this.status,
    required this.paymentMethod,
    required this.priceEtb,
    required this.notes,
    this.cancelledBy,
    this.cancelReason,
  });

  final String id;
  final String customerId;
  final String businessId;
  final String serviceId;
  final String staffId;
  final DateTime startsAt;
  final DateTime endsAt;

  /// One of: `REQUESTED`, `ACCEPTED`, `REJECTED`, `CANCELLED`,
  /// `COMPLETED`, `NO_SHOW`. Stored as the raw string so a
  /// future server-side addition (e.g. `NO_SHOW_DEFERRED`) lands
  /// without a client patch.
  final String status;

  /// One of: `CASH`, `ONLINE_PENDING`. MVP only ever issues
  /// `CASH`; `ONLINE_PENDING` lands once the Telebirr / Chapa
  /// integration commits.
  final String paymentMethod;

  final double priceEtb;
  final String? notes;

  /// `CUSTOMER` / `BUSINESS` / `ADMIN`. Null when the
  /// appointment hasn't been cancelled.
  final String? cancelledBy;

  /// Free-text reason persisted with the cancellation. Null when
  /// not cancelled or when the cancelling party didn't provide one.
  final String? cancelReason;

  /// Phase 9 UI predicates. The customer-side history list and
  /// detail screen branch on these to decide which lifecycle
  /// actions render.
  bool get isUpcoming =>
      (status == 'REQUESTED' || status == 'ACCEPTED') &&
      startsAt.isAfter(DateTime.now().toUtc());

  /// Customer-cancellable while the booking is still in the
  /// pre-completion lifecycle. Past-the-cutoff is enforced by
  /// the server with a 409 CONFLICT, surfaced as a clear copy
  /// on the detail screen.
  bool get isCancellable =>
      status == 'REQUESTED' || status == 'ACCEPTED';

  /// Reviewable when the business has marked the appointment
  /// COMPLETED. Duplicate-review attempts surface as 409 CONFLICT
  /// (the API enforces UNIQUE on `reviews.appointment_id`).
  bool get isReviewable => status == 'COMPLETED';

  factory Appointment.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException('Appointment JSON must be an object.');
    }
    String req(String key) {
      final v = json[key];
      if (v is! String || v.isEmpty) {
        throw FormatException('Appointment.$key missing or non-string.');
      }
      return v;
    }

    final priceEtb = json['priceEtb'];
    if (priceEtb is! num) {
      throw const FormatException(
        'Appointment.priceEtb must be a number.',
      );
    }

    final notes = json['notes'];

    final cancelledBy = json['cancelledBy'];
    final cancelReason = json['cancelReason'];

    return Appointment(
      id: req('id'),
      customerId: req('customerId'),
      businessId: req('businessId'),
      serviceId: req('serviceId'),
      staffId: req('staffId'),
      startsAt: DateTime.parse(req('startsAt')),
      endsAt: DateTime.parse(req('endsAt')),
      status: req('status'),
      paymentMethod: req('paymentMethod'),
      priceEtb: priceEtb.toDouble(),
      notes: notes is String && notes.isNotEmpty ? notes : null,
      cancelledBy:
          cancelledBy is String && cancelledBy.isNotEmpty ? cancelledBy : null,
      cancelReason:
          cancelReason is String && cancelReason.isNotEmpty ? cancelReason : null,
    );
  }

  /// Decode the `AppointmentList` envelope (`{ items: [...] }`).
  /// No `nextCursor` — the MVP listing is unpaginated.
  static List<Appointment> listFromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'AppointmentList JSON must be an object.',
      );
    }
    final items = json['items'];
    if (items is! List) {
      throw const FormatException(
        'AppointmentList.items must be a list.',
      );
    }
    return [for (final item in items) Appointment.fromJson(item)];
  }
}
