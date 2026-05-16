// EthioLink Mobile — business actions repository.
//
// Phase 9 Track 3.5 second commit. Wraps the two owner-side
// mutation endpoints the create-business flow needs:
//
//   * `POST /v1/businesses` — create a DRAFT business owned by
//     the caller. Mirrors OpenAPI `createBusiness`. 409 CONFLICT
//     fires when the owner already has a business (MVP enforces
//     one-per-owner).
//
//   * `POST /v1/businesses/{id}/submit` — flip DRAFT (or REJECTED)
//     to PENDING_REVIEW. Mirrors OpenAPI `submitBusiness`. 409
//     fires when the source status isn't a submittable one; 400
//     fires when the business is missing required fields
//     (`details.missing[]` lists them).
//
// PATCH/edit lands in a follow-up commit — the prompt explicitly
// scopes this commit to create + submit only.
//
// Failure classification mirrors `OwnerBusinessLoadFailureKind` /
// the booking-flow failure surfaces: a hand-shaped enum so the UI
// can switch on it cleanly without parsing error strings.

import '../../../core/api/api_client.dart';
import '../models/owner_business_view.dart';

/// Domain port. Production wires `HttpBusinessActionsRepository`;
/// tests pass an in-memory fake.
abstract class BusinessActionsRepository {
  Future<OwnerBusinessView> createBusiness(CreateBusinessRequest request);
  Future<OwnerBusinessView> submitBusiness(String businessId);

  /// Phase 9 Track 3.5 polish — owner profile editor. Wraps
  /// `PATCH /v1/businesses/{id}`. Fields-keys present in the body
  /// either set the value or clear the column when `null` (per the
  /// OpenAPI `PatchBusinessRequest` contract — absent = "no
  /// change", null = clear).
  Future<OwnerBusinessView> updateBusiness(
    String businessId,
    PatchBusinessRequest request,
  );
}

/// Hand-rolled request object — keeps the call site clean and
/// gives `toJson` one place to live. The OpenAPI generator would
/// replace this with a generated DTO; the shape is identical.
class CreateBusinessRequest {
  const CreateBusinessRequest({
    required this.categoryId,
    this.name,
    this.descriptionEn,
    this.city,
    this.addressLine,
    this.phone,
    this.telegramHandle,
    this.whatsappPhone,
  });

  /// Required — every business is anchored to one category.
  final String categoryId;

  /// Free-text business name. Optional from the API's perspective
  /// (DRAFT may exist without a name), but `submitBusiness`
  /// enforces it. The mobile form treats it as required.
  final String? name;

  /// English description. The API expects a `LocalizedText` object
  /// (`{en, am?}`); we only emit the `en` key in this commit.
  final String? descriptionEn;

  final String? city;
  final String? addressLine;

  /// Free-text contact channels. All optional. The API caps each
  /// at 50 chars; the form mirrors that.
  final String? phone;
  final String? telegramHandle;
  final String? whatsappPhone;

  /// Encodes the request body. Empty strings drop out (so the
  /// owner's "I'll fill this in later" experience doesn't send
  /// stray `""` values that fail validation on submit).
  Map<String, dynamic> toJson() {
    final body = <String, dynamic>{'categoryId': categoryId};
    void addIfPresent(String key, String? value) {
      if (value != null && value.isNotEmpty) body[key] = value;
    }

    addIfPresent('name', name);
    if (descriptionEn != null && descriptionEn!.isNotEmpty) {
      body['description'] = <String, dynamic>{'en': descriptionEn};
    }
    addIfPresent('city', city);
    addIfPresent('addressLine', addressLine);
    addIfPresent('phone', phone);
    addIfPresent('telegramHandle', telegramHandle);
    addIfPresent('whatsappPhone', whatsappPhone);
    return body;
  }
}

/// PATCH body for `/v1/businesses/{id}`. Each field is optional
/// from the API's perspective; the owner-profile editor emits
/// every form field every save (with `null` for cleared
/// optionals + the trimmed value for set ones). Required fields
/// (`categoryId`, `name`, `city`) are always set when validation
/// passes.
///
/// The `null`-vs-absent distinction matters: the API treats
/// `undefined` (absent) as "no change" and explicit `null` as
/// "clear". `toJson` always emits each key when a corresponding
/// argument was supplied — empty optional strings encode as
/// `null` so the column clears.
class PatchBusinessRequest {
  const PatchBusinessRequest({
    this.categoryId,
    this.name,
    this.descriptionEn,
    this.clearDescription = false,
    this.city,
    this.addressLine,
    this.clearAddress = false,
    this.phone,
    this.clearPhone = false,
    this.telegramHandle,
    this.clearTelegram = false,
    this.whatsappPhone,
    this.clearWhatsapp = false,
  });

  final String? categoryId;
  final String? name;
  final String? descriptionEn;
  final bool clearDescription;
  final String? city;
  final String? addressLine;
  final bool clearAddress;
  final String? phone;
  final bool clearPhone;
  final String? telegramHandle;
  final bool clearTelegram;
  final String? whatsappPhone;
  final bool clearWhatsapp;

  Map<String, dynamic> toJson() {
    final body = <String, dynamic>{};
    if (categoryId != null && categoryId!.isNotEmpty) {
      body['categoryId'] = categoryId;
    }
    if (name != null && name!.isNotEmpty) body['name'] = name;
    if (clearDescription) {
      body['description'] = null;
    } else if (descriptionEn != null && descriptionEn!.isNotEmpty) {
      body['description'] = <String, dynamic>{'en': descriptionEn};
    }
    if (city != null && city!.isNotEmpty) body['city'] = city;
    if (clearAddress) {
      body['addressLine'] = null;
    } else if (addressLine != null && addressLine!.isNotEmpty) {
      body['addressLine'] = addressLine;
    }
    if (clearPhone) {
      body['phone'] = null;
    } else if (phone != null && phone!.isNotEmpty) {
      body['phone'] = phone;
    }
    if (clearTelegram) {
      body['telegramHandle'] = null;
    } else if (telegramHandle != null && telegramHandle!.isNotEmpty) {
      body['telegramHandle'] = telegramHandle;
    }
    if (clearWhatsapp) {
      body['whatsappPhone'] = null;
    } else if (whatsappPhone != null && whatsappPhone!.isNotEmpty) {
      body['whatsappPhone'] = whatsappPhone;
    }
    return body;
  }
}

/// Failure classification for create + submit. The UI maps each
/// kind to a branch:
///
///   * `validation` → inline field errors / "fix the highlighted
///     fields" copy.
///   * `forbidden` → role drift → sign-out/sign-back-in copy.
///   * `unauthenticated` → re-login prompt.
///   * `conflict` → "you already have a business" (create) or
///     "this business isn't in a submittable state" (submit).
///   * `notFound` → server says the business id doesn't exist
///     (typically only happens to submit when the owner's row was
///     deleted out-of-band).
///   * `network` → "can't reach the server" + retry.
///   * `serverError` / `malformedResponse` / `other` → generic
///     retry copy.
enum BusinessActionFailureKind {
  validation,
  forbidden,
  unauthenticated,
  conflict,
  notFound,
  network,
  serverError,
  malformedResponse,
  other,
}

class BusinessActionFailure implements Exception {
  BusinessActionFailure({
    required this.kind,
    required this.message,
    this.statusCode,
    this.apiErrorCode,
  });

  final BusinessActionFailureKind kind;
  final String message;
  final int? statusCode;
  final String? apiErrorCode;

  factory BusinessActionFailure.fromApi(ApiException e) {
    final status = e.statusCode;
    final code = e.apiErrorCode;
    BusinessActionFailureKind k;
    if (e.isNetworkError) {
      k = BusinessActionFailureKind.network;
    } else if (status == 400 || code == 'VALIDATION_ERROR') {
      k = BusinessActionFailureKind.validation;
    } else if (status == 401 || code == 'UNAUTHENTICATED') {
      k = BusinessActionFailureKind.unauthenticated;
    } else if (status == 403 || code == 'FORBIDDEN') {
      k = BusinessActionFailureKind.forbidden;
    } else if (status == 404 || code == 'NOT_FOUND') {
      k = BusinessActionFailureKind.notFound;
    } else if (status == 409 || code == 'CONFLICT') {
      k = BusinessActionFailureKind.conflict;
    } else if (status != null && status >= 500) {
      k = BusinessActionFailureKind.serverError;
    } else {
      k = BusinessActionFailureKind.other;
    }
    return BusinessActionFailure(
      kind: k,
      message: e.message,
      statusCode: status,
      apiErrorCode: code,
    );
  }

  @override
  String toString() =>
      'BusinessActionFailure[$kind${apiErrorCode != null ? "/$apiErrorCode" : ""}]: $message';
}

class HttpBusinessActionsRepository implements BusinessActionsRepository {
  HttpBusinessActionsRepository(this._client);
  final ApiClient _client;

  static const _createPath = '/v1/businesses';
  static String _submitPath(String id) => '/v1/businesses/$id/submit';

  @override
  Future<OwnerBusinessView> createBusiness(
    CreateBusinessRequest request,
  ) async {
    try {
      return await _client.postJson<OwnerBusinessView>(
        _createPath,
        body: request.toJson(),
        parse: OwnerBusinessView.fromJson,
      );
    } on FormatException catch (e) {
      throw BusinessActionFailure(
        kind: BusinessActionFailureKind.malformedResponse,
        message: 'createBusiness response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw BusinessActionFailure.fromApi(e);
    }
  }

  @override
  Future<OwnerBusinessView> submitBusiness(String businessId) async {
    try {
      return await _client.postJson<OwnerBusinessView>(
        _submitPath(businessId),
        parse: OwnerBusinessView.fromJson,
      );
    } on FormatException catch (e) {
      throw BusinessActionFailure(
        kind: BusinessActionFailureKind.malformedResponse,
        message: 'submitBusiness response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw BusinessActionFailure.fromApi(e);
    }
  }

  static String _patchPath(String id) => '/v1/businesses/$id';

  @override
  Future<OwnerBusinessView> updateBusiness(
    String businessId,
    PatchBusinessRequest request,
  ) async {
    try {
      return await _client.patchJson<OwnerBusinessView>(
        _patchPath(businessId),
        body: request.toJson(),
        parse: OwnerBusinessView.fromJson,
      );
    } on FormatException catch (e) {
      throw BusinessActionFailure(
        kind: BusinessActionFailureKind.malformedResponse,
        message: 'updateBusiness response was malformed: ${e.message}',
      );
    } on ApiException catch (e) {
      throw BusinessActionFailure.fromApi(e);
    }
  }
}
