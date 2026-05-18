// EthioLink Mobile — BusinessDetailScreen widget tests.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/business_detail_screen.dart';
import 'package:ethiolink/features/browse/data/business_detail_repositories.dart';
import 'package:ethiolink/features/browse/models/business_detail.dart';
import 'package:ethiolink/features/browse/models/review.dart';
import 'package:ethiolink/features/browse/models/service.dart';
import 'package:ethiolink/features/browse/models/staff.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
);

// ---------------------------------------------------------------------------
// Scriptable fakes
// ---------------------------------------------------------------------------

class FakeBusinessDetailRepo implements BusinessDetailRepository {
  FakeBusinessDetailRepo._(this._completer, this._error);
  factory FakeBusinessDetailRepo.value(BusinessDetail b) =>
      FakeBusinessDetailRepo._(
        Completer<BusinessDetail>()..complete(b),
        null,
      );

  /// Defer the throw to the microtask queue (same pattern as
  /// `FakeCategoriesRepository.error` in the browse-screen tests):
  /// a pre-errored future constructed at fixture-setup time
  /// reaches the test zone's uncaught-error handler before
  /// `FutureBuilder` subscribes, surfacing as a test failure even
  /// though the inline error UI would otherwise render correctly.
  factory FakeBusinessDetailRepo.error(Object e) =>
      FakeBusinessDetailRepo._(null, e);

  final Completer<BusinessDetail>? _completer;
  final Object? _error;

  @override
  Future<BusinessDetail> getById(String id) {
    final err = _error;
    if (err != null) {
      return Future<BusinessDetail>.microtask(() {
        throw err;
      });
    }
    return _completer!.future;
  }
}

class FakeServicesRepo implements ServicesRepository {
  FakeServicesRepo(this.values);
  FakeServicesRepo.error(this.error) : values = const <Service>[];
  final List<Service> values;
  Object? error;
  @override
  Future<List<Service>> listForBusiness(String id) async {
    if (error != null) throw error!;
    return values;
  }
}

class FakeStaffRepo implements StaffRepository {
  FakeStaffRepo(this.values);
  final List<Staff> values;
  @override
  Future<List<Staff>> listForBusiness(String id) async => values;
}

class FakeReviewsRepo implements ReviewsRepository {
  FakeReviewsRepo(this.values);
  final List<Review> values;
  @override
  Future<List<Review>> listForBusiness(String id) async => values;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const _sampleBusiness = BusinessDetail(
  id: 'biz-1',
  categoryId: 'cat-1',
  name: 'Sunset Salon',
  descriptionEn: 'Best in town.',
  descriptionAm: null,
  city: 'Addis Ababa',
  addressLine: 'Bole, Wello Sefer',
  latitude: null,
  longitude: null,
  phone: '+251911000001',
  telegramHandle: 'sunsetsalon',
  whatsappPhone: null,
  featuredUntil: null,
  ratingAvg: 4.8,
  ratingCount: 12,
);

Service _service(String name, {int durationMinutes = 30, double? price = 300}) {
  return Service(
    id: 'srv-$name',
    businessId: 'biz-1',
    nameEn: name,
    descriptionEn: null,
    durationMinutes: durationMinutes,
    priceEtb: price,
    isActive: true,
  );
}

Staff _staff(String name, {String? role}) {
  return Staff(
    id: 'st-$name',
    businessId: 'biz-1',
    displayName: name,
    role: role,
    isActive: true,
  );
}

Review _review(int rating, {String? comment}) {
  return Review(
    id: 'rev-$rating',
    businessId: 'biz-1',
    rating: rating,
    comment: comment,
    createdAt: DateTime.utc(2026, 5, 1),
  );
}

Future<void> _pump(
  WidgetTester tester, {
  required BusinessDetailRepositories repos,
}) async {
  // The detail page renders header + contact + services + staff +
  // reviews sections vertically; on the 800×600 default test
  // viewport, the reviews row was scrolling out of the laid-out
  // region so `find.textContaining('★★★★★')` couldn't see it. Tall
  // viewport keeps every section in the rendered Element tree.
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: BusinessDetailScreen(
          businessId: 'biz-1',
          initialName: 'Sunset Salon',
          repositoriesOverride: repos,
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  testWidgets('renders loading then the populated detail page',
      (tester) async {
    final repos = BusinessDetailRepositories(
      detail: FakeBusinessDetailRepo.value(_sampleBusiness),
      services: FakeServicesRepo([
        _service('Haircut'),
        _service('Color', price: null),
      ]),
      staff: FakeStaffRepo([_staff('Hana', role: 'Senior Stylist')]),
      reviews: FakeReviewsRepo([_review(5, comment: 'Excellent.')]),
    );

    await _pump(tester, repos: repos);
    // Initial spinner.
    expect(find.byType(CircularProgressIndicator), findsWidgets);

    await tester.pumpAndSettle();

    // Header + contact + sections.
    expect(find.text('Sunset Salon'), findsWidgets);
    expect(find.textContaining('Bole, Wello Sefer'), findsOneWidget);
    expect(find.textContaining('★ 4.8'), findsOneWidget);
    expect(find.text('Best in town.'), findsOneWidget);
    expect(find.text('Contact'), findsOneWidget);
    expect(find.text('+251911000001'), findsOneWidget);
    // Services rendered with price/duration.
    expect(find.text('Haircut'), findsOneWidget);
    expect(find.text('Color'), findsOneWidget);
    expect(find.textContaining('30 min · 300 ETB'), findsOneWidget);
    expect(find.textContaining('30 min · Price on request'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Book'), findsNWidgets(2));
    // Staff.
    expect(find.text('Hana'), findsOneWidget);
    expect(find.text('Senior Stylist'), findsOneWidget);
    // Reviews — 5-star ratings rendered as filled glyphs.
    expect(find.textContaining('★★★★★'), findsOneWidget);
    expect(find.text('Excellent.'), findsOneWidget);
  });

  testWidgets('renders the empty/missing-data states in each section',
      (tester) async {
    final repos = BusinessDetailRepositories(
      detail: FakeBusinessDetailRepo.value(_sampleBusiness),
      services: FakeServicesRepo(const <Service>[]),
      staff: FakeStaffRepo(const <Staff>[]),
      reviews: FakeReviewsRepo(const <Review>[]),
    );
    await _pump(tester, repos: repos);
    await tester.pumpAndSettle();

    expect(find.textContaining('no published services yet'), findsOneWidget);
    expect(find.textContaining('No staff members listed yet'), findsOneWidget);
    expect(find.textContaining('No reviews yet'), findsOneWidget);
  });

  testWidgets('renders the page error when the business fetch fails',
      (tester) async {
    final repos = BusinessDetailRepositories(
      detail: FakeBusinessDetailRepo.error(
        BusinessDetailLoadFailure('boom', isNetworkError: true),
      ),
      services: FakeServicesRepo(const <Service>[]),
      staff: FakeStaffRepo(const <Staff>[]),
      reviews: FakeReviewsRepo(const <Review>[]),
    );
    await _pump(tester, repos: repos);
    await tester.pumpAndSettle();

    expect(find.text("Can't reach the server"), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('shows an inline section error when ONLY services fails',
      (tester) async {
    final repos = BusinessDetailRepositories(
      detail: FakeBusinessDetailRepo.value(_sampleBusiness),
      services: FakeServicesRepo.error(
        ServicesLoadFailure('services 5xx'),
      ),
      staff: FakeStaffRepo([_staff('Hana')]),
      reviews: FakeReviewsRepo([_review(4)]),
    );
    await _pump(tester, repos: repos);
    await tester.pumpAndSettle();

    // Page didn't blank — staff + reviews still render.
    expect(find.text('Hana'), findsOneWidget);
    // Services section shows the inline error.
    expect(find.textContaining('services 5xx'), findsOneWidget);
  });
}
