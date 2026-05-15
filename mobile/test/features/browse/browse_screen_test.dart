// EthioLink Mobile — BrowseScreen widget tests.
//
// Covers the three states the Phase 9 categories-fetch commit
// added: loading, success, and error. Empty-state is exercised
// implicitly by the success path with an empty list. All tests
// inject a `FakeCategoriesRepository` so nothing hits the
// network.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/auth/auth_service.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/browse_screen.dart';
import 'package:ethiolink/features/browse/data/categories_repository.dart';
import 'package:ethiolink/features/browse/models/category.dart';

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

/// Scriptable repository for the three widget tests. Each test
/// configures either a delayed completer (loading), a value
/// (success / empty), or a throw (error).
class FakeCategoriesRepository implements CategoriesRepository {
  FakeCategoriesRepository.completer(this._completer);
  FakeCategoriesRepository.value(List<Category> value)
      : _completer = (Completer<List<Category>>()..complete(value));
  FakeCategoriesRepository.error(Object error)
      : _completer = (Completer<List<Category>>()..completeError(error));

  final Completer<List<Category>> _completer;

  @override
  Future<List<Category>> list() => _completer.future;
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
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: BrowseScreen(
          session: _testSession,
          categoriesRepositoryOverride: repository,
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
}
