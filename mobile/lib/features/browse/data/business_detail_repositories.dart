// EthioLink Mobile — business detail repositories.
//
// The detail screen issues four fetches concurrently:
//
//   * `GET /v1/businesses/{id}`               → BusinessDetail
//   * `GET /v1/businesses/{id}/services`      → List<Service>
//   * `GET /v1/businesses/{id}/staff`         → List<Staff>
//   * `GET /v1/businesses/{id}/reviews`       → List<Review>
//
// Each gets its own repository port for clean test injection.
// `BusinessDetailRepositories` is the value type the screen
// accepts via a single constructor override — production
// wires four `Http*Repository` instances, tests pass four fakes.
//
// Error translation: every repository converts `FormatException`
// + `ApiException` into a domain-shaped failure (`*LoadFailure`).
// The detail screen surfaces the four failures independently so
// (e.g.) a 5xx on reviews doesn't blank the rest of the page.

import '../../../core/api/api_client.dart';
import '../models/business_detail.dart';
import '../models/review.dart';
import '../models/service.dart';
import '../models/staff.dart';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

abstract class BusinessDetailRepository {
  Future<BusinessDetail> getById(String businessId);
}

abstract class ServicesRepository {
  Future<List<Service>> listForBusiness(String businessId);
}

abstract class StaffRepository {
  Future<List<Staff>> listForBusiness(String businessId);
}

abstract class ReviewsRepository {
  Future<List<Review>> listForBusiness(String businessId);
}

/// Bundle the screen consumes. Construct once at navigation time;
/// inject a fake bundle from tests.
class BusinessDetailRepositories {
  const BusinessDetailRepositories({
    required this.detail,
    required this.services,
    required this.staff,
    required this.reviews,
  });

  final BusinessDetailRepository detail;
  final ServicesRepository services;
  final StaffRepository staff;
  final ReviewsRepository reviews;

  /// Convenience for production wiring: build all four
  /// `Http*Repository` instances from one `ApiClient`.
  factory BusinessDetailRepositories.over(ApiClient client) {
    return BusinessDetailRepositories(
      detail: HttpBusinessDetailRepository(client),
      services: HttpServicesRepository(client),
      staff: HttpStaffRepository(client),
      reviews: HttpReviewsRepository(client),
    );
  }
}

// ---------------------------------------------------------------------------
// Http implementations
// ---------------------------------------------------------------------------

class HttpBusinessDetailRepository implements BusinessDetailRepository {
  HttpBusinessDetailRepository(this._client);
  final ApiClient _client;

  @override
  Future<BusinessDetail> getById(String businessId) async {
    try {
      return await _client.getJson<BusinessDetail>(
        '/v1/businesses/$businessId',
        parse: BusinessDetail.fromJson,
      );
    } on FormatException catch (e) {
      throw BusinessDetailLoadFailure(
        'Business response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw BusinessDetailLoadFailure(
        e.message,
        isNetworkError: e.isNetworkError,
        statusCode: e.statusCode,
      );
    }
  }
}

class HttpServicesRepository implements ServicesRepository {
  HttpServicesRepository(this._client);
  final ApiClient _client;

  @override
  Future<List<Service>> listForBusiness(String businessId) async {
    try {
      return await _client.getJson<List<Service>>(
        '/v1/businesses/$businessId/services',
        parse: Service.listFromJson,
      );
    } on FormatException catch (e) {
      throw ServicesLoadFailure(
        'Services response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw ServicesLoadFailure(
        e.message,
        isNetworkError: e.isNetworkError,
        statusCode: e.statusCode,
      );
    }
  }
}

class HttpStaffRepository implements StaffRepository {
  HttpStaffRepository(this._client);
  final ApiClient _client;

  @override
  Future<List<Staff>> listForBusiness(String businessId) async {
    try {
      return await _client.getJson<List<Staff>>(
        '/v1/businesses/$businessId/staff',
        parse: Staff.listFromJson,
      );
    } on FormatException catch (e) {
      throw StaffLoadFailure(
        'Staff response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw StaffLoadFailure(
        e.message,
        isNetworkError: e.isNetworkError,
        statusCode: e.statusCode,
      );
    }
  }
}

class HttpReviewsRepository implements ReviewsRepository {
  HttpReviewsRepository(this._client);
  final ApiClient _client;

  @override
  Future<List<Review>> listForBusiness(String businessId) async {
    try {
      return await _client.getJson<List<Review>>(
        '/v1/businesses/$businessId/reviews',
        parse: Review.listFromJson,
      );
    } on FormatException catch (e) {
      throw ReviewsLoadFailure(
        'Reviews response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw ReviewsLoadFailure(
        e.message,
        isNetworkError: e.isNetworkError,
        statusCode: e.statusCode,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Failure types
// ---------------------------------------------------------------------------

class BusinessDetailLoadFailure implements Exception {
  BusinessDetailLoadFailure(
    this.message, {
    this.isNetworkError = false,
    this.statusCode,
  });
  final String message;
  final bool isNetworkError;
  final int? statusCode;
  @override
  String toString() => 'BusinessDetailLoadFailure: $message';
}

class ServicesLoadFailure implements Exception {
  ServicesLoadFailure(
    this.message, {
    this.isNetworkError = false,
    this.statusCode,
  });
  final String message;
  final bool isNetworkError;
  final int? statusCode;
  @override
  String toString() => 'ServicesLoadFailure: $message';
}

class StaffLoadFailure implements Exception {
  StaffLoadFailure(
    this.message, {
    this.isNetworkError = false,
    this.statusCode,
  });
  final String message;
  final bool isNetworkError;
  final int? statusCode;
  @override
  String toString() => 'StaffLoadFailure: $message';
}

class ReviewsLoadFailure implements Exception {
  ReviewsLoadFailure(
    this.message, {
    this.isNetworkError = false,
    this.statusCode,
  });
  final String message;
  final bool isNetworkError;
  final int? statusCode;
  @override
  String toString() => 'ReviewsLoadFailure: $message';
}
