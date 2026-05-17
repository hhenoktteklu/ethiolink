// EthioLink Mobile — browse / home screen.
//
// Phase 9 mobile commit "add mobile categories fetch". Replaces
// the scaffold's 4 static category cards with a real
// `GET /v1/categories` fetch via `CategoriesRepository`.
//
// State machine:
//
//   * `_Loading`  — initial state. CircularProgressIndicator
//                   centred on the tab.
//   * `_Success`  — `List<Category>` is non-empty. Renders the
//                   responsive grid of category cards.
//   * `_Empty`    — `List<Category>` is empty (the API returned
//                   `{items: []}`). Renders an empty-state with
//                   the cause + retry button. Categories should
//                   never legitimately be empty in MVP — the
//                   seed migration inserts the four MVP entries
//                   — so this state is effectively the
//                   "operator forgot to run db:seed" indicator.
//   * `_Error`    — `CategoriesLoadFailure` thrown. Renders a
//                   clear error with a retry button + the
//                   underlying message.
//
// The widget pulls a `CategoriesRepository` via constructor
// override (tests) or constructs an `HttpCategoriesRepository`
// over the `AppConfigScope`-injected `AppConfig` (production).
// The `authServiceOverride` plumbing from the scaffold is
// preserved unchanged for the sign-out flow.

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_service.dart';
import '../../core/config/app_config_scope.dart';
import '../bookings/bookings_screen.dart';
import '../owner/data/owner_business_repository.dart';
import '../owner/owner_tab.dart';
import '../profile/profile_screen.dart';
import 'businesses_screen.dart';
import 'data/businesses_repository.dart';
import 'data/categories_repository.dart';
import 'models/category.dart';
import 'search_results_screen.dart';

class BrowseScreen extends StatefulWidget {
  const BrowseScreen({
    required this.session,
    this.authServiceOverride,
    this.categoriesRepositoryOverride,
    this.businessesRepositoryOverride,
    this.ownerBusinessRepositoryOverride,
    super.key,
  });

  final AuthSession session;

  /// Forwarded to `ProfileScreen` so the sign-out button can use
  /// the same (potentially test-injected) `AuthService` as the
  /// surrounding `LoginScreen`.
  final AuthService? authServiceOverride;

  /// Test-injected repository. Production leaves this `null` and
  /// the State constructs `HttpCategoriesRepository` from
  /// `AppConfigScope`.
  final CategoriesRepository? categoriesRepositoryOverride;

  /// Test-injected businesses repository, forwarded to the pushed
  /// `BusinessesScreen` when the user taps a category card.
  /// Production leaves this `null`.
  final BusinessesRepository? businessesRepositoryOverride;

  /// Test-injected owner-business repository. Forwarded to the
  /// `OwnerTab` (visible only when `session.role == 'BUSINESS_OWNER'`).
  /// Production leaves this `null`.
  final OwnerBusinessRepository? ownerBusinessRepositoryOverride;

  @override
  State<BrowseScreen> createState() => _BrowseScreenState();
}

class _BrowseScreenState extends State<BrowseScreen> {
  int _selectedIndex = 0;

  CategoriesRepository? _repo;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.categoriesRepositoryOverride ??
        HttpCategoriesRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
  }

  @override
  Widget build(BuildContext context) {
    // Phase 9 Track 3.5 — role-gated owner tab. The "My Business"
    // surface lives behind the same bottom-nav as the customer
    // tabs but only renders when the session's role grants
    // owner access. ADMIN users default to the customer tabs
    // (admin operations live in the admin SPA today).
    final showOwnerTab = widget.session.role == 'BUSINESS_OWNER';
    final l10n = AppLocalizations.of(context);

    final tabs = <Widget>[
      _BrowseTab(
        session: widget.session,
        repository: _repo!,
        businessesRepositoryOverride: widget.businessesRepositoryOverride,
      ),
      BookingsScreen(session: widget.session),
      if (showOwnerTab)
        OwnerTab(
          repositoryOverride: widget.ownerBusinessRepositoryOverride,
        ),
      ProfileScreen(
        session: widget.session,
        authServiceOverride: widget.authServiceOverride,
      ),
    ];

    return Scaffold(
      body: tabs[_selectedIndex],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (i) => setState(() => _selectedIndex = i),
        destinations: [
          NavigationDestination(
            icon: const Icon(Icons.search_outlined),
            selectedIcon: const Icon(Icons.search),
            label: l10n.navBrowse,
          ),
          NavigationDestination(
            icon: const Icon(Icons.event_outlined),
            selectedIcon: const Icon(Icons.event),
            label: l10n.navBookings,
          ),
          if (showOwnerTab)
            NavigationDestination(
              icon: const Icon(Icons.storefront_outlined),
              selectedIcon: const Icon(Icons.storefront),
              label: l10n.navOwner,
            ),
          NavigationDestination(
            icon: const Icon(Icons.person_outline),
            selectedIcon: const Icon(Icons.person),
            label: l10n.navProfile,
          ),
        ],
      ),
    );
  }
}

class _BrowseTab extends StatefulWidget {
  const _BrowseTab({
    required this.session,
    required this.repository,
    this.businessesRepositoryOverride,
  });

  final AuthSession session;
  final CategoriesRepository repository;
  final BusinessesRepository? businessesRepositoryOverride;

  @override
  State<_BrowseTab> createState() => _BrowseTabState();
}

class _BrowseTabState extends State<_BrowseTab> {
  Future<List<Category>>? _future;
  final TextEditingController _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _refresh() {
    setState(() {
      _future = widget.repository.list();
    });
  }

  void _onSearchSubmitted(String raw) {
    final query = raw.trim();
    // Empty submits are intentionally a no-op — the user sees no
    // navigation jolt, the keyboard simply dismisses. Mirrors the
    // browse tab's "tap a category" path.
    if (query.isEmpty) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SearchResultsScreen(
          query: query,
          businessesRepositoryOverride: widget.businessesRepositoryOverride,
          categoriesRepositoryOverride: widget.repository,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return RefreshIndicator(
      onRefresh: () async {
        _refresh();
        await _future;
      },
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverAppBar(
            title: Text(l10n.browseDiscoverTitle),
            floating: true,
          ),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            sliver: SliverToBoxAdapter(
              child: TextField(
                key: const ValueKey('browseSearchInput'),
                controller: _searchController,
                textInputAction: TextInputAction.search,
                onSubmitted: _onSearchSubmitted,
                decoration: InputDecoration(
                  hintText: l10n.searchHint,
                  prefixIcon: const Icon(Icons.search),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(28),
                    borderSide: BorderSide.none,
                  ),
                  filled: true,
                  fillColor: Theme.of(context)
                      .colorScheme
                      .surfaceContainerHighest,
                  contentPadding:
                      const EdgeInsets.symmetric(horizontal: 16),
                ),
              ),
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 0),
            sliver: SliverToBoxAdapter(
              child: Text(
                l10n.browseWelcomeBack(widget.session.email),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
          ),
          SliverToBoxAdapter(
            child: FutureBuilder<List<Category>>(
              future: _future,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const _LoadingState();
                }
                if (snapshot.hasError) {
                  return _ErrorState(
                    error: snapshot.error!,
                    onRetry: _refresh,
                  );
                }
                final data = snapshot.data ?? <Category>[];
                if (data.isEmpty) {
                  return _EmptyState(onRetry: _refresh);
                }
                return _CategoryGrid(
                  categories: data,
                  businessesRepositoryOverride:
                      widget.businessesRepositoryOverride,
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _LoadingState extends StatelessWidget {
  const _LoadingState();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 48),
      child: Center(child: CircularProgressIndicator()),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
      child: Column(
        children: [
          Icon(Icons.inbox_outlined, size: 56, color: colors.onSurfaceVariant),
          const SizedBox(height: 12),
          Text(
            'No categories yet.',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 4),
          Text(
            'The marketplace catalog is still being prepared. '
            'Pull down to refresh.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isNetwork = error is CategoriesLoadFailure &&
        (error as CategoriesLoadFailure).isNetworkError;
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
      child: Column(
        children: [
          Icon(
            isNetwork ? Icons.wifi_off : Icons.error_outline,
            size: 56,
            color: colors.error,
          ),
          const SizedBox(height: 12),
          Text(
            isNetwork
                ? "Can't reach the server"
                : 'Something went wrong',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 4),
          Text(
            error.toString(),
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Try again'),
          ),
        ],
      ),
    );
  }
}

class _CategoryGrid extends StatelessWidget {
  const _CategoryGrid({
    required this.categories,
    required this.businessesRepositoryOverride,
  });

  final List<Category> categories;
  final BusinessesRepository? businessesRepositoryOverride;

  // Slug → icon mapping for the placeholder UI. New seeded
  // categories without a slug entry fall back to a generic icon.
  // The design pass replaces this with vendor-supplied imagery.
  static const _iconBySlug = <String, IconData>{
    'salon': Icons.content_cut,
    'barber': Icons.cut,
    'spa': Icons.spa,
    'beauty-professional': Icons.brush,
  };

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      child: GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
          crossAxisSpacing: 12,
          mainAxisSpacing: 12,
          childAspectRatio: 1.2,
        ),
        itemCount: categories.length,
        itemBuilder: (context, i) {
          final c = categories[i];
          return _CategoryCard(
            category: c,
            icon: _iconBySlug[c.slug] ?? Icons.local_offer_outlined,
            businessesRepositoryOverride: businessesRepositoryOverride,
          );
        },
      ),
    );
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard({
    required this.category,
    required this.icon,
    required this.businessesRepositoryOverride,
  });

  final Category category;
  final IconData icon;
  final BusinessesRepository? businessesRepositoryOverride;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      elevation: 0,
      color: colors.surfaceContainerHighest,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () {
          Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => BusinessesScreen(
                category: category,
                repositoryOverride: businessesRepositoryOverride,
              ),
            ),
          );
        },
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 36, color: colors.primary),
              const SizedBox(height: 8),
              Text(
                category.nameEn,
                style: Theme.of(context).textTheme.titleMedium,
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
