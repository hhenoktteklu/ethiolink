// EthioLink Mobile — BusinessDetail model.
//
// Same wire-shape as `BusinessPublicView` in the OpenAPI doc, but
// preserves every field — `BusinessSummary` (the listing item)
// only captures the subset the list-row needs. The detail screen
// renders address, description, phone, social handles, and the
// map coordinates (lat/lon), so they all live here.

class BusinessDetail {
  const BusinessDetail({
    required this.id,
    required this.categoryId,
    required this.name,
    required this.descriptionEn,
    required this.descriptionAm,
    required this.city,
    required this.addressLine,
    required this.latitude,
    required this.longitude,
    required this.phone,
    required this.telegramHandle,
    required this.whatsappPhone,
    required this.featuredUntil,
    required this.ratingAvg,
    required this.ratingCount,
  });

  final String id;
  final String categoryId;
  final String? name;
  final String? descriptionEn;
  final String? descriptionAm;
  final String? city;
  final String? addressLine;
  final double? latitude;
  final double? longitude;
  final String? phone;
  final String? telegramHandle;
  final String? whatsappPhone;
  final DateTime? featuredUntil;
  final double ratingAvg;
  final int ratingCount;

  bool get isCurrentlyFeatured {
    final f = featuredUntil;
    return f != null && f.toUtc().isAfter(DateTime.now().toUtc());
  }

  /// True when the business has at least one contact channel
  /// other than the in-app booking flow. Drives whether the
  /// "Contact" section renders on the detail screen.
  bool get hasAnyContact =>
      (phone?.isNotEmpty ?? false) ||
      (telegramHandle?.isNotEmpty ?? false) ||
      (whatsappPhone?.isNotEmpty ?? false);

  factory BusinessDetail.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'BusinessDetail JSON must be an object.',
      );
    }
    final id = json['id'];
    final categoryId = json['categoryId'];
    final ratingAvg = json['ratingAvg'];
    final ratingCount = json['ratingCount'];

    if (id is! String || id.isEmpty) {
      throw const FormatException('BusinessDetail.id missing or non-string.');
    }
    if (categoryId is! String || categoryId.isEmpty) {
      throw const FormatException(
        'BusinessDetail.categoryId missing or non-string.',
      );
    }
    if (ratingAvg is! num) {
      throw const FormatException(
        'BusinessDetail.ratingAvg must be a number.',
      );
    }
    if (ratingCount is! int) {
      throw const FormatException(
        'BusinessDetail.ratingCount must be an integer.',
      );
    }

    String? str(dynamic v) => v is String && v.isNotEmpty ? v : null;
    double? num64(dynamic v) =>
        v is num ? v.toDouble() : null;

    final desc = json['description'];
    String? descriptionEn;
    String? descriptionAm;
    if (desc is Map<String, dynamic>) {
      descriptionEn = str(desc['en']);
      descriptionAm = str(desc['am']);
    }

    final featuredUntilRaw = json['featuredUntil'];
    DateTime? featuredUntil;
    if (featuredUntilRaw is String && featuredUntilRaw.isNotEmpty) {
      featuredUntil = DateTime.parse(featuredUntilRaw);
    }

    return BusinessDetail(
      id: id,
      categoryId: categoryId,
      name: str(json['name']),
      descriptionEn: descriptionEn,
      descriptionAm: descriptionAm,
      city: str(json['city']),
      addressLine: str(json['addressLine']),
      latitude: num64(json['latitude']),
      longitude: num64(json['longitude']),
      phone: str(json['phone']),
      telegramHandle: str(json['telegramHandle']),
      whatsappPhone: str(json['whatsappPhone']),
      featuredUntil: featuredUntil,
      ratingAvg: ratingAvg.toDouble(),
      ratingCount: ratingCount,
    );
  }
}
