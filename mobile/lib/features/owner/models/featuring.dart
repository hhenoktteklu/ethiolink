// EthioLink Mobile — featuring models.
//
// Phase 9 Track 6 owner mobile UI. Mirrors the OpenAPI schemas
// `FeaturingPackage` and `FeaturingSubscription`. Parses defensively
// — every typed field throws `FormatException` on a missing /
// mistyped key, the repository layer translates that into a domain
// failure.

class FeaturingPackage {
  const FeaturingPackage({
    required this.code,
    required this.durationDays,
    required this.priceEtb,
  });

  /// One of `FEATURING_7D` / `FEATURING_30D`. The server is the
  /// source of truth for which package codes exist; we render
  /// whatever the API returns and ignore unknown codes for now.
  final String code;

  /// Length of the featuring window in days. The mobile UI shows
  /// this as a card subtitle ("7 days featured") and uses it to
  /// compute the projected `endsAt` for display before the
  /// subscription completes.
  final int durationDays;

  /// Server-priced amount in ETB. Owners never send this.
  final double priceEtb;

  factory FeaturingPackage.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException('FeaturingPackage must be an object.');
    }
    final code = json['code'];
    final durationDays = json['durationDays'];
    final priceEtb = json['priceEtb'];
    if (code is! String || code.isEmpty) {
      throw const FormatException('FeaturingPackage.code missing.');
    }
    if (durationDays is! int || durationDays <= 0) {
      throw const FormatException(
        'FeaturingPackage.durationDays must be a positive integer.',
      );
    }
    if (priceEtb is! num) {
      throw const FormatException(
        'FeaturingPackage.priceEtb must be a number.',
      );
    }
    return FeaturingPackage(
      code: code,
      durationDays: durationDays,
      priceEtb: priceEtb.toDouble(),
    );
  }
}

class FeaturingSubscription {
  const FeaturingSubscription({
    required this.id,
    required this.businessId,
    required this.packageCode,
    required this.priceEtb,
    required this.startsAt,
    required this.endsAt,
    required this.status,
    required this.source,
    required this.cancelledAt,
    required this.cancelledReason,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String businessId;
  final String packageCode;
  final double priceEtb;
  final DateTime startsAt;
  final DateTime endsAt;

  /// One of PENDING_PAYMENT / ACTIVE / EXPIRED / CANCELLED / REFUNDED.
  /// The UI primarily branches on `isActive`.
  final String status;

  /// OWNER_PURCHASE / ADMIN_COMP. Surfaced as a badge on the
  /// history row so owners can see which subscription was paid vs.
  /// comped.
  final String source;

  final DateTime? cancelledAt;
  final String? cancelledReason;
  final DateTime createdAt;
  final DateTime updatedAt;

  bool get isActive => status == 'ACTIVE';
  bool get isPending => status == 'PENDING_PAYMENT';
  bool get isComp => source == 'ADMIN_COMP';

  factory FeaturingSubscription.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException('FeaturingSubscription must be an object.');
    }
    final id = json['id'];
    final businessId = json['businessId'];
    final packageCode = json['packageCode'];
    final priceEtb = json['priceEtb'];
    final startsAt = json['startsAt'];
    final endsAt = json['endsAt'];
    final status = json['status'];
    final source = json['source'];
    final createdAt = json['createdAt'];
    final updatedAt = json['updatedAt'];
    if (id is! String || id.isEmpty) {
      throw const FormatException('FeaturingSubscription.id missing.');
    }
    if (businessId is! String || businessId.isEmpty) {
      throw const FormatException(
        'FeaturingSubscription.businessId missing.',
      );
    }
    if (packageCode is! String || packageCode.isEmpty) {
      throw const FormatException(
        'FeaturingSubscription.packageCode missing.',
      );
    }
    if (priceEtb is! num) {
      throw const FormatException(
        'FeaturingSubscription.priceEtb must be a number.',
      );
    }
    if (startsAt is! String || endsAt is! String) {
      throw const FormatException(
        'FeaturingSubscription.startsAt / endsAt must be ISO-8601 strings.',
      );
    }
    if (status is! String || status.isEmpty) {
      throw const FormatException('FeaturingSubscription.status missing.');
    }
    if (source is! String || source.isEmpty) {
      throw const FormatException('FeaturingSubscription.source missing.');
    }
    if (createdAt is! String || updatedAt is! String) {
      throw const FormatException(
        'FeaturingSubscription.createdAt / updatedAt must be ISO-8601 strings.',
      );
    }
    final cancelledAtRaw = json['cancelledAt'];
    final cancelledReasonRaw = json['cancelledReason'];
    return FeaturingSubscription(
      id: id,
      businessId: businessId,
      packageCode: packageCode,
      priceEtb: priceEtb.toDouble(),
      startsAt: DateTime.parse(startsAt),
      endsAt: DateTime.parse(endsAt),
      status: status,
      source: source,
      cancelledAt: cancelledAtRaw is String && cancelledAtRaw.isNotEmpty
          ? DateTime.parse(cancelledAtRaw)
          : null,
      cancelledReason:
          cancelledReasonRaw is String ? cancelledReasonRaw : null,
      createdAt: DateTime.parse(createdAt),
      updatedAt: DateTime.parse(updatedAt),
    );
  }
}

/// Phase 10 — wire shape returned by
/// `POST /v1/businesses/{businessId}/featuring/subscribe`. Pairs
/// the subscription with the gateway-issued payment authorization.
/// Mobile reads `payment.redirectUrl` and opens the hosted-checkout
/// URL via `url_launcher` when the gateway returned `PENDING`. Cash
/// settlement returns `payment.redirectUrl: null` and the
/// subscription already ACTIVE.
class SubscribeFeaturingResult {
  const SubscribeFeaturingResult({
    required this.subscription,
    required this.payment,
  });

  final FeaturingSubscription subscription;
  final FeaturingPaymentSummary payment;

  factory SubscribeFeaturingResult.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'SubscribeFeaturingResult JSON must be an object.',
      );
    }
    final sub = json['subscription'];
    final pay = json['payment'];
    if (sub is! Map<String, dynamic>) {
      throw const FormatException(
        'SubscribeFeaturingResult.subscription missing.',
      );
    }
    if (pay is! Map<String, dynamic>) {
      throw const FormatException(
        'SubscribeFeaturingResult.payment missing.',
      );
    }
    return SubscribeFeaturingResult(
      subscription: FeaturingSubscription.fromJson(sub),
      payment: FeaturingPaymentSummary.fromJson(pay),
    );
  }
}

/// Phase 10 — featuring-side `PaymentSummary`. Defined here
/// alongside the featuring models rather than imported from the
/// booking package so the owner code stays free of customer-side
/// imports. Same shape as the OpenAPI `PaymentSummary`.
class FeaturingPaymentSummary {
  const FeaturingPaymentSummary({
    required this.status,
    required this.provider,
    required this.providerRef,
    required this.redirectUrl,
    required this.errorCode,
    required this.errorMessage,
  });

  final String status;
  final String provider;
  final String? providerRef;
  final String? redirectUrl;
  final String? errorCode;
  final String? errorMessage;

  bool get isPending => status == 'PENDING';
  bool get isSucceeded => status == 'SUCCEEDED';
  bool get isFailed => status == 'FAILED';

  factory FeaturingPaymentSummary.fromJson(dynamic json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException(
        'FeaturingPaymentSummary JSON must be an object.',
      );
    }
    final status = json['status'];
    final provider = json['provider'];
    if (status is! String || status.isEmpty) {
      throw const FormatException('PaymentSummary.status missing.');
    }
    if (provider is! String || provider.isEmpty) {
      throw const FormatException('PaymentSummary.provider missing.');
    }
    String? optString(String key) {
      final v = json[key];
      return v is String && v.isNotEmpty ? v : null;
    }
    return FeaturingPaymentSummary(
      status: status,
      provider: provider,
      providerRef: optString('providerRef'),
      redirectUrl: optString('redirectUrl'),
      errorCode: optString('errorCode'),
      errorMessage: optString('errorMessage'),
    );
  }
}
