// EthioLink Mobile — Category model.
//
// Mirrors the backend's `CategoryView` schema (see
// `backend/api/openapi.yaml` § `components.schemas.CategoryView`).
// The mobile model is the minimum subset the placeholder browse
// screen needs to render: `id`, `slug`, English display name,
// `sortOrder`. The other CategoryView fields (`createdAt`,
// `updatedAt`, the Amharic localization) are preserved on the
// raw map for the future localization track but not exposed via
// typed getters today.
//
// The OpenAPI-generated client (future commit) will replace
// hand-written `fromJson` with a generated one. The shape is
// identical; the migration is mechanical.

class Category {
  const Category({
    required this.id,
    required this.slug,
    required this.nameEn,
    required this.nameAm,
    required this.sortOrder,
  });

  final String id;
  final String slug;

  /// English display name. Always populated by the backend (the
  /// `name` field is required + the registry guarantees `en`).
  final String nameEn;

  /// Amharic display name. May be empty / null while localization
  /// content is being authored.
  final String? nameAm;

  final int sortOrder;

  /// Decodes a single `CategoryView` JSON object. Throws
  /// `FormatException` when required fields are missing or
  /// typed incorrectly — repository callers translate that into
  /// an `ApiException` so the UI sees a uniform error surface.
  factory Category.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'Category JSON must be an object.',
      );
    }
    final id = json['id'];
    final slug = json['slug'];
    final name = json['name'];
    final sortOrder = json['sortOrder'];

    if (id is! String || id.isEmpty) {
      throw const FormatException('Category.id missing or non-string.');
    }
    if (slug is! String || slug.isEmpty) {
      throw const FormatException('Category.slug missing or non-string.');
    }
    if (name is! Map<String, dynamic>) {
      throw const FormatException(
        'Category.name must be a {en, am?} object.',
      );
    }
    final nameEn = name['en'];
    if (nameEn is! String || nameEn.isEmpty) {
      throw const FormatException(
        'Category.name.en is required and must be non-empty.',
      );
    }
    final nameAm = name['am'];
    if (sortOrder is! int) {
      throw const FormatException(
        'Category.sortOrder must be an integer.',
      );
    }

    return Category(
      id: id,
      slug: slug,
      nameEn: nameEn,
      nameAm: nameAm is String && nameAm.isNotEmpty ? nameAm : null,
      sortOrder: sortOrder,
    );
  }

  /// Decodes a `CategoryList` (`{ items: [...], nextCursor: null }`).
  /// `nextCursor` is currently always null for `/categories`; the
  /// mobile-side model ignores it.
  static List<Category> listFromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'CategoryList JSON must be an object.',
      );
    }
    final items = json['items'];
    if (items is! List) {
      throw const FormatException(
        'CategoryList.items must be a list.',
      );
    }
    return [for (final item in items) Category.fromJson(item)];
  }
}
