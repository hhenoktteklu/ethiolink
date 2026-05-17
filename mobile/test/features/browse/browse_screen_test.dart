// EthioLink Mobile — BrowseScreen widget tests.
//
// Covers the three states the Phase 9 categories-fetch commit
// added: loading, success, and error. Empty-state is exercised
// implicitly by the success path with an empty list. All tests
// inject a `FakeCategoriesRepository` so nothing hits the
// network.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/auth/auth_service.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/browse_screen.dart';
import 'package:ethiolink/features/browse/businesses_screen.dart';
import 'package:ethiolink/features/browse/data/businesses_repository.dart';
import 'package:ethiolink/features/browse/data/categories_repository.dart';
import 'package:ethiolink/features/browse/models/business_summary.dart';
import 'package:ethiolink/features/browse/models/category.dart';
import 'package:ethiolink/features/owner/data/owner_business_repository.dart';
import 'package:ethiolink/features/owner/models/owner_business_view.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'ethiolink-test.auth.eu-west-1.amazoncognito.com',
  cognitoClientId: 'test-client',
  redirectUri: 'ethiolink://auth/callback',
  environmentName: 'test',
);

final _testSession = AuthSession(
  userId: 'user-1',
  email: 'test@example.com',
  role: 'CUSTOMER',
  expiresAt: DateTime.utc(2030),
);

AuthSession _sessionWithRole(String role) {
  return AuthSession(
    userId: 'user-1',
    email: 'test@example.com',
    role: role,
    expiresAt: DateTime.utc(2030),
  );
}

/// Repository whose `getMine` future never completes. Used by the
/// role-gating tests so the visible-tab assertion runs without
/// requiring the OwnerTab to fully render (we just need to confirm
/// the nav destination is/isn't on screen).
class _PendingOwnerRepo implements OwnerBusinessRepository {
  @override
  Future<OwnerBusinessView> getMine() => Completer<OwnerBusinessView>().future;
}

/// Scriptable repository for the three widget tests. Each test
/// configures either a delayed completer (loading), a value
/// (success / empty), or a throw (error).
class FakeCategoriesRepository implements CategoriesRepository {
  FakeCategoriesRepository.completer(this._completer) : _error = null;
  FakeCategoriesRepository.value(List<Category> value)
      : _completer = (Completer<List<Category>>()..complete(value)),
        _error = null;

  /// Defer the throw to the microtask queue. A pre-errored future
  /// constructed at fixture-setup time reaches the test zone's
  /// uncaught-error handler before `FutureBuilder` has a chance to
  /// subscribe, which fails the test even though the screen would
  /// otherwise render the inline error UI correctly.
  FakeCategoriesRepository.error(Object error)
      : _completer = null,
        _error = error;

  final Completer<List<Category>>? _completer;
  final Object? _error;

  @override
  Future<List<Category>> list() {
    final err = _error;
    if (err != null) {
      return Future<List<Category>>.microtask(() {
        throw err;
      });
    }
    return _completer!.future;
  }
}

/// Minimal fake for the navigation test. Only needs to swallow
/// the first `list` call BusinessesScreen issues on mount.
class _NavTestBusinessesRepo implements BusinessesRepository {
  String? lastCategory;
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
    lastCategory = category;
    return const BusinessListPage(items: [], nextCursor: null);
  }
}

/// Phase 9 Track 6 — captures the `q` arg on the first `list`
/// call so the search-submit test can assert
/// `SearchResultsScreen` was pushed with the right query.
class _StubBusinessesRepo implements BusinessesRepository {
  String? lastQuery;
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
    lastQuery ??= q;
    return const BusinessListPage(items: [], nextCursor: null);
  }
}

Category _cat(String slug, String name, {int sortOrder = 1}) {
  return Category(
    id: 'id-$slug',
    slug: slug,
    nameEn: name,
    nameAm: null,
    sortOrder: sortOrder,
  );
}

Future<void> _pumpBrowse(
  WidgetTester tester, {
  required CategoriesRepository repository,
  BusinessesRepository? businessesRepository,
  OwnerBusinessRepository? ownerBusinessRepository,
  AuthSession? session,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: BrowseScreen(
          session: session ?? _testSession,
          categoriesRepositoryOverride: repository,
          businessesRepositoryOverride: businessesRepository,
          ownerBusinessRepositoryOverride: ownerBusinessRepository,
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('shows a loading indicator while the fetch is pending',
      (tester) async {
    final pending = Completer<List<Category>>();
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.completer(pending),
    );
    // Loading state — the future is still pending.
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    // Complete + settle to avoid the test leaving a pending timer.
    pending.complete(<Category>[]);
    await tester.pumpAndSettle();
  });

  testWidgets('renders the category grid on success', (tester) async {
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.value([
        _cat('salon', 'Salon'),
        _cat('spa', 'Spa', sortOrder: 3),
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.text('Salon'), findsOneWidget);
    expect(find.text('Spa'), findsOneWidget);
    // The static "wire the real fetch next" placeholder from the
    // scaffold commit should NOT be on screen anymore.
    expect(
      find.textContaining('Marketplace listings load here'),
      findsNothing,
    );
  });

  testWidgets('renders an empty-state when the API returns no items',
      (tester) async {
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.value(<Category>[]),
    );
    await tester.pumpAndSettle();

    expect(find.text('No categories yet.'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('renders the error state on a repository failure',
      (tester) async {
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.error(
        CategoriesLoadFailure('boom', isNetworkError: true),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("Can't reach the server"), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    expect(find.textContaining('boom'), findsOneWidget);
  });

  testWidgets('tapping a category card navigates to BusinessesScreen',
      (tester) async {
    final businessesRepo = _NavTestBusinessesRepo();
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.value([
        _cat('salon', 'Salon'),
      ]),
      businessesRepository: businessesRepo,
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Salon'));
    await tester.pumpAndSettle();

    // BusinessesScreen is on top of the stack now.
    expect(find.byType(BusinessesScreen), findsOneWidget);
    // It issued its initial fetch with the right category slug.
    expect(businessesRepo.lastCategory, 'salon');
  });

  // ----------------------------------------------------------------
  // Role-gating: Phase 9 Track 3.5. The "My Business" tab in the
  // bottom navigation only appears for BUSINESS_OWNER sessions.
  // CUSTOMER and ADMIN sessions see the 3-tab nav (Browse /
  // Bookings / Profile) — admin operations live in the admin SPA.
  // ----------------------------------------------------------------

  testWidgets('shows the My Business tab for BUSINESS_OWNER sessions',
      (tester) async {
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.value(<Category>[]),
      ownerBusinessRepository: _PendingOwnerRepo(),
      session: _sessionWithRole('BUSINESS_OWNER'),
    );
    await tester.pumpAndSettle();

    expect(find.text('My Business'), findsOneWidget);
    expect(find.text('Browse'), findsOneWidget);
    expect(find.text('Bookings'), findsOneWidget);
    expect(find.text('Profile'), findsOneWidget);
  });

  testWidgets('hides the My Business tab for CUSTOMER sessions',
      (tester) async {
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.value(<Category>[]),
      session: _sessionWithRole('CUSTOMER'),
    );
    await tester.pumpAndSettle();

    expect(find.text('My Business'), findsNothing);
    expect(find.text('Browse'), findsOneWidget);
    expect(find.text('Bookings'), findsOneWidget);
    expect(find.text('Profile'), findsOneWidget);
  });

  testWidgets('hides the My Business tab for ADMIN sessions',
      (tester) async {
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.value(<Category>[]),
      session: _sessionWithRole('ADMIN'),
    );
    await tester.pumpAndSettle();

    expect(find.text('My Business'), findsNothing);
  });

  // ----------------------------------------------------------------
  // Phase 9 Track 6 — search input on the browse tab.
  // ----------------------------------------------------------------

  testWidgets('renders the search input', (tester) async {
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.value(<Category>[]),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('browseSearchInput')), findsOneWidget);
    expect(find.text('Search businesses'), findsOneWidget);
  });

  testWidgets('search submit pushes SearchResultsScreen', (tester) async {
    final businessesRepo = _StubBusinessesRepo();
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.value(<Category>[]),
      businessesRepository: businessesRepo,
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('browseSearchInput')),
      'habesha',
    );
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pumpAndSettle();

    // SearchResultsScreen issued its initial fetch with q=habesha.
    expect(businessesRepo.lastQuery, 'habesha');
  });

  testWidgets('empty search submit is ignored', (tester) async {
    final businessesRepo = _StubBusinessesRepo();
    await _pumpBrowse(
      tester,
      repository: FakeCategoriesRepository.value(<Category>[]),
      businessesRepository: businessesRepo,
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('browseSearchInput')),
      '   ',
    );
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pumpAndSettle();

    // No navigation happened — the businesses repo was not called
    // by a SearchResultsScreen.
    expect(businessesRepo.lastQuery, isNull);
  });
}
