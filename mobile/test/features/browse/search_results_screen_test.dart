// EthioLink Mobile — SearchResultsScreen widget tests.
//
// Phase 9 Track 6. Covers loading / success / empty / error
// states, filter-chip toggling re-issuing the query, and the
// sort menu changing the wire `sort` parameter.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/data/businesses_repository.dart';
import 'package:ethiolink/features/browse/data/categories_repository.dart';
import 'package:ethiolink/features/browse/models/business_summary.dart';
import 'package:ethiolink/features/browse/models/category.dart';
import 'package:ethiolink/features/browse/search_results_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

class _FakeBusinessesRepo implements BusinessesRepository {
  _FakeBusinessesRepo();

  /// Captured call sites. Each call appends one entry.
  final List<Map<String, Object?>> calls = <Map<String, Object?>>[];

  /// Next response. Default: empty page. Tests override per-case.
  BusinessListPage Function() nextPage = () =>
      const BusinessListPage(items: <BusinessSummary>[], nextCursor: null);

  /// When set, the next call throws this error instead of using
  /// `nextPage`.
  Object? nextError;

  /// When set, the next call awaits this completer before returning.
  /// Tests use this to assert the loading state.
  Completer<BusinessListPage>? pending;

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
  }) async {
    calls.add(<String, Object?>{
      'category': category,
      'q': q,
      'city': city,
      'ratingMin': ratingMin,
      'featuredOnly': featuredOnly,
      'sort': sort,
    });
    if (pending != null) {
      final result = await pending!.future;
      return result;
    }
    if (nextError != null) {
      final err = nextError!;
      nextError = null;
      throw err;
    }
    return nextPage();
  }
}

class _FakeCategoriesRepo implements CategoriesRepository {
  _FakeCategoriesRepo(this.items);
  final List<Category> items;
  @override
  Future<List<Category>> list() async => items;
}

Future<void> _pump(
  WidgetTester tester, {
  required BusinessesRepository repo,
  CategoriesRepository? categoriesRepo,
  String query = 'habesha',
  BusinessSort? initialSort,
  bool? initialFeaturedOnly,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: SearchResultsScreen(
          query: query,
          businessesRepositoryOverride: repo,
          categoriesRepositoryOverride:
              categoriesRepo ?? _FakeCategoriesRepo(<Category>[]),
          initialSort: initialSort,
          initialFeaturedOnly: initialFeaturedOnly,
        ),
      ),
    ),
  );
}

BusinessSummary _sample({
  String id = 'biz-1',
  String name = 'Habesha Beauty Lounge',
  double rating = 4.5,
  int reviews = 10,
}) {
  return BusinessSummary(
    id: id,
    categoryId: 'cat-1',
    name: name,
    city: 'Addis Ababa',
    ratingAvg: rating,
    ratingCount: reviews,
    featuredUntil: null,
  );
}

void main() {
  testWidgets('shows a loading indicator while the fetch is pending',
      (tester) async {
    final repo = _FakeBusinessesRepo();
    repo.pending = Completer<BusinessListPage>();
    await _pump(tester, repo: repo);
    await tester.pump(); // start the initial future
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    // Complete the future before teardown so no timers leak.
    repo.pending!.complete(
      const BusinessListPage(items: <BusinessSummary>[], nextCursor: null),
    );
    await tester.pumpAndSettle();
  });

  testWidgets('initial fetch sends q + sort=relevance by default',
      (tester) async {
    final repo = _FakeBusinessesRepo();
    await _pump(tester, repo: repo, query: 'habesha');
    await tester.pumpAndSettle();

    expect(repo.calls, isNotEmpty);
    expect(repo.calls.first['q'], 'habesha');
    expect(repo.calls.first['sort'], BusinessSort.relevance);
  });

  testWidgets('renders the business rows on success', (tester) async {
    final repo = _FakeBusinessesRepo();
    repo.nextPage = () => BusinessListPage(
          items: [
            _sample(id: 'a', name: 'Habesha Beauty Lounge'),
            _sample(id: 'b', name: 'Habesha Cuts'),
          ],
          nextCursor: null,
        );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Habesha Beauty Lounge'), findsOneWidget);
    expect(find.text('Habesha Cuts'), findsOneWidget);
  });

  testWidgets('renders the empty state when no results', (tester) async {
    final repo = _FakeBusinessesRepo();
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('No businesses found'), findsOneWidget);
    expect(find.text('Clear filters'), findsOneWidget);
  });

  testWidgets('renders an error body when the fetch fails', (tester) async {
    final repo = _FakeBusinessesRepo();
    repo.nextError = BusinessesLoadFailure('boom', isNetworkError: true);
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.textContaining('boom'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('toggling the rating ≥ 4 chip re-issues with ratingMin=4',
      (tester) async {
    final repo = _FakeBusinessesRepo();
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();
    final initialCalls = repo.calls.length;

    await tester.tap(find.byKey(const ValueKey('searchFilter.rating4')));
    await tester.pumpAndSettle();

    expect(repo.calls.length, initialCalls + 1);
    expect(repo.calls.last['ratingMin'], 4.0);
  });

  testWidgets('toggling the featured-only chip re-issues with featuredOnly=true',
      (tester) async {
    final repo = _FakeBusinessesRepo();
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();
    final initialCalls = repo.calls.length;

    await tester.tap(find.byKey(const ValueKey('searchFilter.featuredOnly')));
    await tester.pumpAndSettle();

    expect(repo.calls.length, initialCalls + 1);
    expect(repo.calls.last['featuredOnly'], isTrue);
  });

  testWidgets('sort menu re-issues with the selected sort mode', (tester) async {
    final repo = _FakeBusinessesRepo();
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();
    final initialCalls = repo.calls.length;

    await tester.tap(find.byKey(const ValueKey('searchSortMenu')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Top rated').last);
    await tester.pumpAndSettle();

    expect(repo.calls.length, initialCalls + 1);
    expect(repo.calls.last['sort'], BusinessSort.rating);
  });

  testWidgets('Clear filters resets every chip', (tester) async {
    final repo = _FakeBusinessesRepo();
    await _pump(tester, repo: repo, initialFeaturedOnly: true);
    await tester.pumpAndSettle();

    // Empty result triggers the empty state which has the
    // "Clear filters" button. Tap it.
    await tester.tap(find.text('Clear filters'));
    await tester.pumpAndSettle();

    final lastCall = repo.calls.last;
    expect(lastCall['featuredOnly'], isNull);
    expect(lastCall['ratingMin'], isNull);
    expect(lastCall['city'], isNull);
    expect(lastCall['category'], isNull);
  });
}
