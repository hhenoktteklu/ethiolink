// EthioLink Mobile — bookable slot model.
//
// Mirrors the OpenAPI `Slot` schema (UTC start/end pair).
// `SlotList` is `{ items: Slot[] }` with no pagination — the
// endpoint caps its date range at 31 days, which keeps response
// size bounded.

class Slot {
  const Slot({
    required this.startUtc,
    required this.endUtc,
  });

  /// Slot start as a `DateTime` parsed from the UTC ISO-8601
  /// string the API returns. The local-time presentation is the
  /// caller's responsibility — the UI formats this against
  /// `Africa/Addis_Ababa` (the business timezone, fixed for the
  /// MVP).
  final DateTime startUtc;
  final DateTime endUtc;

  /// Original ISO string for the start instant. Forwarded
  /// verbatim as the `startsAt` field on the
  /// `POST /v1/appointments` body so the server-side validation
  /// re-checks the slot in the same form it issued it.
  String get startUtcIso => startUtc.toUtc().toIso8601String();

  factory Slot.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException('Slot JSON must be an object.');
    }
    final start = json['startUtc'];
    final end = json['endUtc'];
    if (start is! String || start.isEmpty) {
      throw const FormatException('Slot.startUtc missing or non-string.');
    }
    if (end is! String || end.isEmpty) {
      throw const FormatException('Slot.endUtc missing or non-string.');
    }
    return Slot(
      startUtc: DateTime.parse(start),
      endUtc: DateTime.parse(end),
    );
  }

  static List<Slot> listFromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException('SlotList JSON must be an object.');
    }
    final items = json['items'];
    if (items is! List) {
      throw const FormatException('SlotList.items must be a list.');
    }
    return [for (final item in items) Slot.fromJson(item)];
  }
}
