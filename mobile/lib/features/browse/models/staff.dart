// EthioLink Mobile — Staff model.
//
// Mirrors `StaffView`. The detail screen renders the active
// roster with display name + optional role label.

class Staff {
  const Staff({
    required this.id,
    required this.businessId,
    required this.displayName,
    required this.role,
    required this.isActive,
  });

  final String id;
  final String businessId;
  final String displayName;
  final String? role;
  final bool isActive;

  factory Staff.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException('Staff JSON must be an object.');
    }
    final id = json['id'];
    final businessId = json['businessId'];
    final displayName = json['displayName'];
    final isActive = json['isActive'];

    if (id is! String || id.isEmpty) {
      throw const FormatException('Staff.id missing or non-string.');
    }
    if (businessId is! String || businessId.isEmpty) {
      throw const FormatException(
        'Staff.businessId missing or non-string.',
      );
    }
    if (displayName is! String || displayName.isEmpty) {
      throw const FormatException(
        'Staff.displayName missing or non-string.',
      );
    }
    if (isActive is! bool) {
      throw const FormatException(
        'Staff.isActive must be a boolean.',
      );
    }

    final role = json['role'];
    return Staff(
      id: id,
      businessId: businessId,
      displayName: displayName,
      role: role is String && role.isNotEmpty ? role : null,
      isActive: isActive,
    );
  }

  static List<Staff> listFromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'StaffList JSON must be an object.',
      );
    }
    final items = json['items'];
    if (items is! List) {
      throw const FormatException(
        'StaffList.items must be a list.',
      );
    }
    return [for (final item in items) Staff.fromJson(item)];
  }
}
