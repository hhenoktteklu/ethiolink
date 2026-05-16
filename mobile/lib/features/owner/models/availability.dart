// EthioLink Mobile — owner availability models.
//
// Phase 9 Track 3.5 fifth commit. Mirrors the backend's
// `AvailabilityScheduleView` + `WeeklyDayInput` + `AddOverrideRequest`
// schemas. Decode-side comes from `AvailabilityWindowView` (a flat
// row that carries both WEEKLY and OVERRIDE kinds); encode-side
// uses separate `WeeklyDayInput` + `WeeklyWindowInput` + the
// override request value object.
//
// Time format: server stores + returns `HH:MM:SS` but accepts
// `HH:MM`. The editor displays `HH:MM` for the operator's
// convenience and re-sends the same string on save — the server
// normalizes either way.

/// One window row off the schedule endpoint. Both WEEKLY and
/// OVERRIDE rows share this shape; the discriminator is `kind`.
class AvailabilityWindow {
  const AvailabilityWindow({
    required this.id,
    required this.kind,
    required this.startTime,
    required this.endTime,
    required this.isClosed,
    this.weekday,
    this.specificDate,
  });

  final String id;

  /// `WEEKLY` or `OVERRIDE`.
  final String kind;

  /// Populated for WEEKLY rows. `0` = Sunday … `6` = Saturday.
  final int? weekday;

  /// Populated for OVERRIDE rows. ISO-8601 `YYYY-MM-DD`.
  final String? specificDate;

  /// `HH:MM:SS` (server normalized).
  final String startTime;

  /// `HH:MM:SS` (server normalized).
  final String endTime;

  /// `true` when the row is a blackout override.
  final bool isClosed;

  factory AvailabilityWindow.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'AvailabilityWindow JSON must be an object.',
      );
    }
    final id = json['id'];
    final kind = json['kind'];
    final startTime = json['startTime'];
    final endTime = json['endTime'];
    final isClosed = json['isClosed'];
    if (id is! String || id.isEmpty) {
      throw const FormatException('AvailabilityWindow.id missing.');
    }
    if (kind is! String || (kind != 'WEEKLY' && kind != 'OVERRIDE')) {
      throw const FormatException(
        'AvailabilityWindow.kind must be WEEKLY or OVERRIDE.',
      );
    }
    if (startTime is! String) {
      throw const FormatException(
        'AvailabilityWindow.startTime must be a string.',
      );
    }
    if (endTime is! String) {
      throw const FormatException(
        'AvailabilityWindow.endTime must be a string.',
      );
    }
    if (isClosed is! bool) {
      throw const FormatException(
        'AvailabilityWindow.isClosed must be a boolean.',
      );
    }
    final weekday = json['weekday'];
    final specificDate = json['specificDate'];
    return AvailabilityWindow(
      id: id,
      kind: kind,
      weekday: weekday is int ? weekday : null,
      specificDate: specificDate is String ? specificDate : null,
      startTime: startTime,
      endTime: endTime,
      isClosed: isClosed,
    );
  }

  /// Convenience: returns `HH:MM` for the editor TextField. The
  /// server returns `HH:MM:SS`; we trim the seconds.
  String get startTimeShort => _truncate(startTime);
  String get endTimeShort => _truncate(endTime);

  static String _truncate(String t) =>
      t.length >= 5 ? t.substring(0, 5) : t;
}

/// Full grouped schedule envelope returned by GET / PUT.
class AvailabilitySchedule {
  const AvailabilitySchedule({
    required this.weekly,
    required this.overrides,
  });

  /// All WEEKLY rows for the staff member. Use `weeklyByDay` to
  /// project into a `List<List<...>>` indexed by weekday.
  final List<AvailabilityWindow> weekly;

  /// All OVERRIDE rows for the staff member (closed + open).
  final List<AvailabilityWindow> overrides;

  factory AvailabilitySchedule.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'AvailabilitySchedule JSON must be an object.',
      );
    }
    final w = json['weekly'];
    final o = json['overrides'];
    if (w is! List) {
      throw const FormatException(
        'AvailabilitySchedule.weekly must be a list.',
      );
    }
    if (o is! List) {
      throw const FormatException(
        'AvailabilitySchedule.overrides must be a list.',
      );
    }
    return AvailabilitySchedule(
      weekly: [for (final item in w) AvailabilityWindow.fromJson(item)],
      overrides: [for (final item in o) AvailabilityWindow.fromJson(item)],
    );
  }

  /// Groups weekly windows by weekday (0..6). Always returns 7
  /// buckets — empty days get an empty list. Order within a day
  /// preserves server order.
  List<List<AvailabilityWindow>> weeklyByDay() {
    final out = List.generate(7, (_) => <AvailabilityWindow>[]);
    for (final w in weekly) {
      final d = w.weekday;
      if (d != null && d >= 0 && d <= 6) out[d].add(w);
    }
    return out;
  }
}

/// PUT request body item (`WeeklyDayInput`). Always send all 7
/// weekdays — the server requires the full week.
class WeeklyDayInput {
  const WeeklyDayInput({required this.weekday, required this.windows});

  final int weekday;
  final List<WeeklyWindowInput> windows;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'weekday': weekday,
        'windows': [for (final w in windows) w.toJson()],
      };
}

/// PUT request body window (`WeeklyWindowInput`).
class WeeklyWindowInput {
  const WeeklyWindowInput({required this.startTime, required this.endTime});
  final String startTime;
  final String endTime;
  Map<String, dynamic> toJson() => <String, dynamic>{
        'startTime': startTime,
        'endTime': endTime,
      };
}

/// POST `/availability/override` request body.
class AvailabilityOverrideRequest {
  const AvailabilityOverrideRequest({
    required this.specificDate,
    required this.startTime,
    required this.endTime,
    this.isClosed = false,
  });

  /// ISO-8601 `YYYY-MM-DD`.
  final String specificDate;
  final String startTime;
  final String endTime;
  final bool isClosed;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'specificDate': specificDate,
        'startTime': startTime,
        'endTime': endTime,
        'isClosed': isClosed,
      };
}
