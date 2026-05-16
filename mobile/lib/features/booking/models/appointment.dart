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
    );
  }
}
