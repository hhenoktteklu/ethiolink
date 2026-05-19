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
import '../../core/role/role_experience.dart';
import '../../core/role/role_theme.dart';
import '../admin/admin_home_screen.dart';
import '../admin/admin_review_queue_screen.dart';
import '../admin/data/admin_businesses_repository.dart';
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
    this.adminBusinessesRepositoryOverride,
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

  /// Test-injected admin businesses repository. Forwarded to
  /// `AdminReviewQueueScreen` when the session is ADMIN.
  /// Production leaves this `null`.
  final AdminBusinessesRepository? adminBusinessesRepositoryOverride;

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
    // Phase 9 + role-experiences rewrite. The bottom-nav set, the
    // hero copy on Browse, the AppBar / FilledButton palette, and
    // the per-role banner are all driven by a single
    // `RoleExperience` lookup keyed off `session.role`. New roles
    // (or palette tweaks) land in `core/role/role_experience.dart`
    // — this screen iterates the destinations + applies the
    // theme without further conditionals.
    final exp = RoleExperience.forSession(widget.session);
    final l10n = AppLocalizations.of(context);

    final tabsByDestination = <RoleNavDestination, Widget>{
      RoleNavDestination.browse: _BrowseTab(
        session: widget.session,
        experience: exp,
        repository: _repo!,
        businessesRepositoryOverride: widget.businessesRepositoryOverride,
      ),
      RoleNavDestination.bookings: BookingsScreen(session: widget.session),
      RoleNavDestination.ownerDashboard: OwnerTab(
        repositoryOverride: widget.ownerBusinessRepositoryOverride,
      ),
      RoleNavDestination.adminReviewQueue: AdminReviewQueueScreen(
        repositoryOverride: widget.adminBusinessesRepositoryOverride,
      ),
      RoleNavDestination.adminHome: AdminHomeScreen(session: widget.session),
      RoleNavDestination.profile: ProfileScreen(
        session: widget.session,
        authServiceOverride: widget.authServiceOverride,
      ),
    };

    final tabs = [
      for (final d in exp.destinations) tabsByDestination[d]!,
    ];
    // Defensive: cap _selectedIndex if a previous session had more
    // tabs than the current role (e.g. owner→customer demotion).
    final selectedIndex =
        _selectedIndex.clamp(0, tabs.length - 1).toInt();
    if (selectedIndex != _selectedIndex) {
      // Avoid setState inside build — schedule the snap-to-valid
      // for the next frame.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        setState(() => _selectedIndex = selectedIndex);
      });
    }

    final destinations = [
      for (final d in exp.destinations) _destinationFor(d, l10n),
    ];

    return Theme(
      data: roleThemeFor(exp),
      child: Scaffold(
        body: tabs[selectedIndex],
        bottomNavigationBar: NavigationBar(
          selectedIndex: selectedIndex,
          onDestinationSelected: (i) =>
              setState(() => _selectedIndex = i),
          destinations: destinations,
        ),
      ),
    );
  }

  /// Per-destination icon + label. Keeps the role config oblivious
  /// to Flutter widgets — `RoleNavDestination` is a plain enum,
  /// the widget mapping lives here.
  NavigationDestination _destinationFor(
    RoleNavDestination dest,
    AppLocalizations l10n,
  ) {
    switch (dest) {
      case RoleNavDestination.browse:
        return NavigationDestination(
          icon: const Icon(Icons.search_outlined),
          selectedIcon: const Icon(Icons.search),
          label: l10n.navBrowse,
        );
      case RoleNavDestination.bookings:
        return NavigationDestination(
          icon: const Icon(Icons.event_outlined),
          selectedIcon: const Icon(Icons.event),
          label: l10n.navBookings,
        );
      case RoleNavDestination.ownerDashboard:
        return NavigationDestination(
          icon: const Icon(Icons.storefront_outlined),
          selectedIcon: const Icon(Icons.storefront),
          label: l10n.navOwner,
        );
      case RoleNavDestination.adminReviewQueue:
        return const NavigationDestination(
          icon: Icon(Icons.fact_check_outlined),
          selectedIcon: Icon(Icons.fact_check),
          label: 'Review',
        );
      case RoleNavDestination.adminHome:
        return const NavigationDestination(
          icon: Icon(Icons.shield_outlined),
          selectedIcon: Icon(Icons.shield),
          label: 'Admin',
        );
      case RoleNavDestination.profile:
        return NavigationDestination(
          icon: const Icon(Icons.person_outline),
          selectedIcon: const Icon(Icons.person),
          label: l10n.navProfile,
        );
    }
  }
}

class _BrowseTab extends StatefulWidget {
  const _BrowseTab({
    required this.session,
    required this.experience,
    required this.repository,
    this.businessesRepositoryOverride,
  });

  final AuthSession session;
  final RoleExperience experience;
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
    final exp = widget.experience;
    final isCustomer = exp.role == 'CUSTOMER';
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
          // Role-tagged context banner. Customer doesn't see it
          // (the marketplace IS their context); owner sees an
          // "Owner view" pill so they understand why their owner
          // tools are also available below; admin sees an
          // "Operator view" pill in the accent palette.
          if (!isCustomer)
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              sliver: SliverToBoxAdapter(
                child: _RoleContextBanner(experience: exp),
              ),
            ),
          // Role-specific hero. The heading + sub copy come from
          // `RoleExperience`, so the palette designer can tweak
          // either field without touching this widget tree.
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            sliver: SliverToBoxAdapter(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    exp.heroHeadline,
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w700,
                          color: Theme.of(context).colorScheme.onSurface,
                        ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    exp.heroSubtitle,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color:
                              Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                  ),
                ],
              ),
            ),
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

/// Small accent-coloured pill that announces the operator's
/// context on the Browse tab when they're NOT a regular customer.
/// Customer browsing is the default — no banner needed for them.
class _RoleContextBanner extends StatelessWidget {
  const _RoleContextBanner({required this.experience});

  final RoleExperience experience;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isAdmin = experience.role == 'ADMIN';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: experience.accent.withValues(alpha: 0.12),
        border: Border.all(color: experience.accent.withValues(alpha: 0.5)),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(
            isAdmin ? Icons.shield_outlined : Icons.storefront_outlined,
            color: experience.accent,
            size: 18,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              isAdmin
                  ? 'Operator view — full admin tools live in the web console.'
                  : 'Owner view — manage your business in the My Business tab.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.onSurface,
                    fontWeight: FontWeight.w500,
                  ),
            ),
          ),
        ],
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
