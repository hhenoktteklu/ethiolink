// EthioLink Mobile — Service model.
//
// Mirrors `ServiceView`. The detail screen renders price + duration
// on the bookable services list. `description.en` is shown when
// present.

class Service {
  const Service({
    required this.id,
    required this.businessId,
    required this.nameEn,
    required this.descriptionEn,
    required this.durationMinutes,
    required this.priceEtb,
    required this.isActive,
  });

  final String id;
  final String businessId;
  final String nameEn;
  final String? descriptionEn;
  final int durationMinutes;
  final double? priceEtb;
  final bool isActive;

  factory Service.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'Service JSON must be an object.',
      );
    }
    final id = json['id'];
    final businessId = json['businessId'];
    final name = json['name'];
    final durationMinutes = json['durationMinutes'];
    final isActive = json['isActive'];

    if (id is! String || id.isEmpty) {
      throw const FormatException('Service.id missing or non-string.');
    }
    if (businessId is! String || businessId.isEmpty) {
      throw const FormatException(
        'Service.businessId missing or non-string.',
      );
    }
    if (name is! Map<String, dynamic>) {
      throw const FormatException(
        'Service.name must be a {en, am?} object.',
      );
    }
    final nameEn = name['en'];
    if (nameEn is! String || nameEn.isEmpty) {
      throw const FormatException(
        'Service.name.en is required and must be non-empty.',
      );
    }
    if (durationMinutes is! int || durationMinutes < 1) {
      throw const FormatException(
        'Service.durationMinutes must be a positive integer.',
      );
    }
    if (isActive is! bool) {
      throw const FormatException(
        'Service.isActive must be a boolean.',
      );
    }

    String? descriptionEn;
    final desc = json['description'];
    if (desc is Map<String, dynamic>) {
      final en = desc['en'];
      if (en is String && en.isNotEmpty) descriptionEn = en;
    }

    final price = json['priceEtb'];
    return Service(
      id: id,
      businessId: businessId,
      nameEn: nameEn,
      descriptionEn: descriptionEn,
      durationMinutes: durationMinutes,
      priceEtb: price is num ? price.toDouble() : null,
      isActive: isActive,
    );
  }

  /// Decode the `ServiceList` envelope. `nextCursor` is ignored —
  /// the API guarantees the listing is unpaginated.
  static List<Service> listFromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'ServiceList JSON must be an object.',
      );
    }
    final items = json['items'];
    if (items is! List) {
      throw const FormatException(
        'ServiceList.items must be a list.',
      );
    }
    return [for (final item in items) Service.fromJson(item)];
  }
}
