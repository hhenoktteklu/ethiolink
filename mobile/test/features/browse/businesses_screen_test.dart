// EthioLink Mobile — BusinessesScreen widget tests.
//
// Covers the four states the listing screen renders plus the
// "Load more" pagination loop. All driven by a scriptable
// `FakeBusinessesRepository`; no network or platform channel.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/business_detail_screen.dart';
import 'package:ethiolink/features/browse/businesses_screen.dart';
import 'package:ethiolink/features/browse/data/business_detail_repositories.dart';
import 'package:ethiolink/features/browse/data/businesses_repository.dart';
import 'package:ethiolink/features/browse/models/business_detail.dart';
import 'package:ethiolink/features/browse/models/business_summary.dart';
import 'package:ethiolink/features/browse/models/category.dart';
import 'package:ethiolink/features/browse/models/review.dart';
import 'package:ethiolink/features/browse/models/service.dart';
import 'package:ethiolink/features/browse/models/staff.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
);

const _salonCategory = Category(
  id: 'cat-salon',
  slug: 'salon',
  nameEn: 'Salon',
  nameAm: null,
  sortOrder: 1,
);

BusinessSummary _biz(
  String name, {
  String? city = 'Addis Ababa',
  double ratingAvg = 4.5,
  int ratingCount = 12,
  DateTime? featuredUntil,
}) {
  return BusinessSummary(
    id: 'id-$name',
    categoryId: 'cat-salon',
    name: name,
    city: city,
    ratingAvg: ratingAvg,
    ratingCount: ratingCount,
    featuredUntil: featuredUntil,
  );
}

/// Scriptable fake. Each call to `list` pops the next response
/// off the queue. The queue can hold values OR errors via the
/// `enqueueValue` / `enqueueError` helpers; the optional
/// `enqueuePending` variant returns a Completer's future the
/// test can complete later.
class FakeBusinessesRepository implements BusinessesRepository {
  final List<Future<BusinessListPage> Function()> _queue =
      <Future<BusinessListPage> Function()>[];
  final List<({String? category, String? cursor, int? limit})> calls = [];

  void enqueueValue(BusinessListPage page) {
    _queue.add(() async => page);
  }

  void enqueueError(Object err) {
    _queue.add(() async => throw err);
  }

  Completer<BusinessListPage> enqueuePending() {
    final c = Completer<BusinessListPage>();
    _queue.add(() => c.future);
    return c;
  }

  @override
  Future<BusinessListPage> list({
    String? category,
    String? cursor,
    int? limit,
    String? q,
    String? city,
    double? ratingMin,
    bool? featuredOnly,
    BusinessSort? sort,
  }) {
    calls.add((category: category, cursor: cursor, limit: limit));
    if (_queue.isEmpty) {
      throw StateError('No more scripted responses');
    }
    return _queue.removeAt(0)();
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required BusinessesRepository repo,
  Category category = _salonCategory,
  BusinessDetailRepositories? detailRepos,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: BusinessesScreen(
          category: category,
          repositoryOverride: repo,
          detailRepositoriesOverride: detailRepos,
        ),
      ),
    ),
  );
}

// Minimal fakes for the row-tap navigation test. The destination
// BusinessDetailScreen builds its own four fetches on mount; we
// short-circuit each to return empty so the test stays fast.

class _DetailRepo implements BusinessDetailRepository {
  String? lastId;
  @override
  Future<BusinessDetail> getById(String id) async {
    lastId = id;
    return BusinessDetail(
      id: id,
      categoryId: 'cat',
      name: 'Sunset Salon',
      descriptionEn: null,
      descriptionAm: null,
      city: null,
      addressLine: null,
      latitude: null,
      longitude: null,
      phone: null,
      telegramHandle: null,
      whatsappPhone: null,
      featuredUntil: null,
      ratingAvg: 0,
      ratingCount: 0,
    );
  }
}

class _ServicesRepo implements ServicesRepository {
  @override
  Future<List<Service>> listForBusiness(String id) async => const <Service>[];
}

class _StaffRepo implements StaffRepository {
  @override
  Future<List<Staff>> listForBusiness(String id) async => const <Staff>[];
}

class _ReviewsRepo implements ReviewsRepository {
  @override
  Future<List<Review>> listForBusiness(String id) async => const <Review>[];
}

void main() {
  testWidgets('renders a loading indicator while the first page loads',
      (tester) async {
    final repo = FakeBusinessesRepository();
    final pending = repo.enqueuePending();

    await _pump(tester, repo: repo);
    await tester.pump(); // build the FutureBuilder once.

    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    // Settle the test cleanly.
    pending.complete(const BusinessListPage(items: [], nextCursor: null));
    await tester.pumpAndSettle();
  });

  testWidgets('renders the list on success with ratings + city', (tester) async {
    final repo = FakeBusinessesRepository()
      ..enqueueValue(BusinessListPage(
        items: [
          _biz('Sunset Salon'),
          _biz('Highland Cuts', ratingCount: 0),
        ],
        nextCursor: null,
      ));

    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Sunset Salon'), findsOneWidget);
    expect(find.text('Highland Cuts'), findsOneWidget);
    expect(find.textContaining('★ 4.5'), findsOneWidget);
    expect(find.text('No reviews yet'), findsOneWidget);
    // App bar title comes from the Category.nameEn.
    expect(find.text('Salon'), findsOneWidget);

    expect(repo.calls, hasLength(1));
    expect(repo.calls[0].category, 'salon');
    expect(repo.calls[0].cursor, isNull);
  });

  testWidgets('renders the empty state when the API returns no items',
      (tester) async {
    final repo = FakeBusinessesRepository()
      ..enqueueValue(const BusinessListPage(items: [], nextCursor: null));

    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.textContaining('No salon listed yet.'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('renders the error state with the network variant',
      (tester) async {
    final repo = FakeBusinessesRepository()
      ..enqueueError(
        BusinessesLoadFailure('boom', isNetworkError: true),
      );

    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text("Can't reach the server"), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    expect(find.textContaining('boom'), findsOneWidget);
  });

  testWidgets('tapping a business row navigates to BusinessDetailScreen',
      (tester) async {
    final repo = FakeBusinessesRepository()
      ..enqueueValue(BusinessListPage(
        items: [_biz('Sunset Salon')],
        nextCursor: null,
      ));
    final detailRepo = _DetailRepo();
    final detailRepos = BusinessDetailRepositories(
      detail: detailRepo,
      services: _ServicesRepo(),
      staff: _StaffRepo(),
      reviews: _ReviewsRepo(),
    );

    await _pump(tester, repo: repo, detailRepos: detailRepos);
    await tester.pumpAndSettle();

    await tester.tap(find.text('Sunset Salon'));
    await tester.pumpAndSettle();

    expect(find.byType(BusinessDetailScreen), findsOneWidget);
    expect(detailRepo.lastId, 'id-Sunset Salon');
  });

  testWidgets('Load more appends a second page', (tester) async {
    final repo = FakeBusinessesRepository()
      ..enqueueValue(BusinessListPage(
        items: [_biz('First')],
        nextCursor: 'cursor-1',
      ))
      ..enqueueValue(BusinessListPage(
        items: [_biz('Second')],
        nextCursor: null,
      ));

    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('First'), findsOneWidget);
    expect(find.text('Load more'), findsOneWidget);

    await tester.tap(find.text('Load more'));
    await tester.pumpAndSettle();

    expect(find.text('First'), findsOneWidget);
    expect(find.text('Second'), findsOneWidget);
    expect(find.text('Load more'), findsNothing); // nextCursor=null now

    expect(repo.calls, hasLength(2));
    expect(repo.calls[1].cursor, 'cursor-1');
  });
}
