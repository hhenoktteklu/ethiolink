// EthioLink Mobile — Review model.
//
// Mirrors `ReviewView`. The detail screen renders the recent
// reviews carousel.

class Review {
  const Review({
    required this.id,
    required this.businessId,
    required this.rating,
    required this.comment,
    required this.createdAt,
  });

  final String id;
  final String businessId;

  /// Integer 1..5 per schema. The renderer maps to ★-glyphs.
  final int rating;

  final String? comment;
  final DateTime createdAt;

  factory Review.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException('Review JSON must be an object.');
    }
    final id = json['id'];
    final businessId = json['businessId'];
    final rating = json['rating'];
    final createdAt = json['createdAt'];

    if (id is! String || id.isEmpty) {
      throw const FormatException('Review.id missing or non-string.');
    }
    if (businessId is! String || businessId.isEmpty) {
      throw const FormatException(
        'Review.businessId missing or non-string.',
      );
    }
    if (rating is! int || rating < 1 || rating > 5) {
      throw const FormatException(
        'Review.rating must be an integer 1..5.',
      );
    }
    if (createdAt is! String || createdAt.isEmpty) {
      throw const FormatException(
        'Review.createdAt missing or non-string.',
      );
    }

    final comment = json['comment'];
    return Review(
      id: id,
      businessId: businessId,
      rating: rating,
      comment: comment is String && comment.isNotEmpty ? comment : null,
      createdAt: DateTime.parse(createdAt),
    );
  }

  static List<Review> listFromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'ReviewList JSON must be an object.',
      );
    }
    final items = json['items'];
    if (items is! List) {
      throw const FormatException(
        'ReviewList.items must be a list.',
      );
    }
    return [for (final item in items) Review.fromJson(item)];
  }
}
