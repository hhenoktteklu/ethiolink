// EthioLink Mobile — BusinessSummary model.
//
// Mirrors the OpenAPI `BusinessPublicView` schema with the subset
// the marketplace list item renders. The full schema carries 16
// fields including lat/lon, social handles, and timestamps that
// only the BusinessDetailScreen will read in the next mobile
// commit — adding them later is a one-line addition to the
// `fromJson` mapping.

class BusinessSummary {
  const BusinessSummary({
    required this.id,
    required this.categoryId,
    required this.name,
    required this.city,
    required this.ratingAvg,
    required this.ratingCount,
    required this.featuredUntil,
    this.searchRank,
  });

  final String id;
  final String categoryId;

  /// May be null when the owner hasn't filled in the name yet (the
  /// listing endpoint guards against unnamed APPROVED rows, but
  /// the column is nullable in Postgres so the client treats this
  /// as defensive).
  final String? name;

  final String? city;

  /// `numeric(3,2)` on the backend. Read as a `num`, normalized
  /// to `double` on the client.
  final double ratingAvg;

  final int ratingCount;

  /// When non-null AND in the future, the business is currently
  /// featured. Tap-handlers can show a "Featured" chip; the list
  /// item rendering checks this against `DateTime.now()`.
  final DateTime? featuredUntil;

  /// Phase 9 Track 6 — full-text rank for the matching row. Non-null
  /// only when the listing was issued with `sort=relevance` and a
  /// non-empty `q`. Higher = better match. Mirrors the
  /// `BusinessPublicView.searchRank` field in the OpenAPI spec.
  /// Most call paths leave this `null`.
  final double? searchRank;

  /// True when this business is presently featured. The check is
  /// computed every read so a card watching the clock can flip
  /// the chip on/off if a screen lingers past the boundary. MVP
  /// timing precision (1 hour) makes the cost negligible.
  bool isCurrentlyFeatured({DateTime? now}) {
    final f = featuredUntil;
    if (f == null) return false;
    final n = (now ?? DateTime.now().toUtc()).toUtc();
    return f.toUtc().isAfter(n);
  }

  /// Decode a single `BusinessPublicView` JSON object. Throws
  /// `FormatException` when required fields are missing or
  /// mistyped; the repository translates that into a domain
  /// failure for the UI.
  factory BusinessSummary.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'BusinessSummary JSON must be an object.',
      );
    }

    final id = json['id'];
    final categoryId = json['categoryId'];
    final ratingAvg = json['ratingAvg'];
    final ratingCount = json['ratingCount'];

    if (id is! String || id.isEmpty) {
      throw const FormatException('BusinessSummary.id missing or non-string.');
    }
    if (categoryId is! String || categoryId.isEmpty) {
      throw const FormatException(
        'BusinessSummary.categoryId missing or non-string.',
      );
    }
    if (ratingAvg is! num) {
      throw const FormatException(
        'BusinessSummary.ratingAvg must be a number.',
      );
    }
    if (ratingCount is! int) {
      throw const FormatException(
        'BusinessSummary.ratingCount must be an integer.',
      );
    }

    final name = json['name'];
    final city = json['city'];
    final featuredUntilRaw = json['featuredUntil'];
    DateTime? featuredUntil;
    if (featuredUntilRaw is String && featuredUntilRaw.isNotEmpty) {
      // The API emits ISO-8601 with offset. `DateTime.parse` is
      // permissive enough for both `Z` and `+00:00` variants.
      featuredUntil = DateTime.parse(featuredUntilRaw);
    }

    // Phase 9 Track 6 — `searchRank` is optional. The backend
    // emits `null` for non-relevance queries and a `number` for
    // `sort=relevance` matches.
    final searchRankRaw = json['searchRank'];
    final double? searchRank =
        searchRankRaw is num ? searchRankRaw.toDouble() : null;

    return BusinessSummary(
      id: id,
      categoryId: categoryId,
      name: name is String ? name : null,
      city: city is String ? city : null,
      ratingAvg: ratingAvg.toDouble(),
      ratingCount: ratingCount,
      featuredUntil: featuredUntil,
      searchRank: searchRank,
    );
  }
}

/// One page of the `GET /v1/businesses` response. The
/// `nextCursor` mirrors the OpenAPI shape: `null` on the last
/// page; an opaque string on every other page. The "Load more"
/// button shows iff `nextCursor != null`.
class BusinessListPage {
  const BusinessListPage({
    required this.items,
    required this.nextCursor,
  });

  final List<BusinessSummary> items;
  final String? nextCursor;

  factory BusinessListPage.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'BusinessListPage JSON must be an object.',
      );
    }
    final items = json['items'];
    if (items is! List) {
      throw const FormatException(
        'BusinessListPage.items must be a list.',
      );
    }
    final cursor = json['nextCursor'];
    return BusinessListPage(
      items: [
        for (final item in items) BusinessSummary.fromJson(item),
      ],
      nextCursor: cursor is String && cursor.isNotEmpty ? cursor : null,
    );
  }
}
