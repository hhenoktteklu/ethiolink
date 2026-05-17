// EthioLink Mobile — search results screen.
//
// Phase 9 Track 6. Reached from the search input on `BrowseScreen`
// when the user submits a non-empty query. Renders the same
// `BusinessSummary` row layout as `BusinessesScreen` but with a
// richer filter + sort surface:
//
//   * Filter chips: category (resolved against the
//     `CategoriesRepository`), city (free-text dialog), rating
//     ≥ 4, featured-only.
//   * Sort menu (AppBar action): best match (relevance), top
//     rated, newest, featured first.
//
// State machine mirrors `BusinessesScreen`:
//
//   * `_Loading` — initial fetch pending.
//   * `_Success` — non-empty result list. No "Load more" in this
//                  commit: the backend only supports cursor
//                  pagination for `sort=featured`, and a search
//                  result is typically narrower than the
//                  category browse so first-page-only matches
//                  the UX expectation. A future commit can wire
//                  cursor pagination back when the sort is
//                  `featured`.
//   * `_Empty`   — zero rows. Shows localized empty-state copy +
//                  a "Clear filters" action.
//   * `_Error`   — `BusinessesLoadFailure`. Retry button.
//
// All visible labels read from `AppLocalizations`. Default sort
// is `BusinessSort.relevance` when the screen opens (a user
// arriving via the search input has an intent that maps best to
// relevance ranking).

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import 'business_detail_screen.dart';
import 'data/business_detail_repositories.dart';
import 'data/businesses_repository.dart';
import 'data/categories_repository.dart';
import 'models/business_summary.dart';
import 'models/category.dart';

class SearchResultsScreen extends StatefulWidget {
  const SearchResultsScreen({
    required this.query,
    this.businessesRepositoryOverride,
    this.categoriesRepositoryOverride,
    this.detailRepositoriesOverride,
    this.initialSort,
    this.initialFeaturedOnly,
    super.key,
  });

  /// The free-text query the user submitted. Passed verbatim to
  /// `BusinessesRepository.list(q: ...)`. Empty queries should
  /// never reach this screen — `BrowseScreen`'s submit handler
  /// ignores them — but we treat the empty case as "show all"
  /// defensively (the API also tolerates it).
  final String query;

  /// Test seam — production constructs an
  /// `HttpBusinessesRepository` over the `AppConfigScope`-injected
  /// `AppConfig`.
  final BusinessesRepository? businessesRepositoryOverride;

  /// Test seam for the category filter chip's dropdown.
  final CategoriesRepository? categoriesRepositoryOverride;

  /// Forwarded to `BusinessDetailScreen` when the user taps a
  /// result row.
  final BusinessDetailRepositories? detailRepositoriesOverride;

  /// Optional initial sort. Defaults to `BusinessSort.relevance`
  /// when omitted; useful for tests that want to assert a specific
  /// initial wire value.
  final BusinessSort? initialSort;

  /// Optional initial featured-only state. Defaults to `false`.
  final bool? initialFeaturedOnly;

  @override
  State<SearchResultsScreen> createState() => _SearchResultsScreenState();
}

class _SearchResultsScreenState extends State<SearchResultsScreen> {
  BusinessesRepository? _repo;
  CategoriesRepository? _categoriesRepo;

  // Resolved categories for the category-filter dropdown. Cached
  // lazily on first access to avoid an unnecessary fetch when the
  // user never opens the dropdown.
  List<Category>? _categories;

  // Active filters.
  String? _categorySlug;
  String? _city;
  bool _rating4Plus = false;
  bool _featuredOnly = false;
  BusinessSort _sort = BusinessSort.relevance;

  // Result state.
  Future<BusinessListPage>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.businessesRepositoryOverride ??
        HttpBusinessesRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _categoriesRepo = widget.categoriesRepositoryOverride ??
        HttpCategoriesRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _sort = widget.initialSort ?? BusinessSort.relevance;
    _featuredOnly = widget.initialFeaturedOnly ?? false;
    _refresh();
  }

  void _refresh() {
    setState(() {
      _future = _repo!.list(
        q: widget.query,
        category: _categorySlug,
        city: _city,
        ratingMin: _rating4Plus ? 4.0 : null,
        featuredOnly: _featuredOnly ? true : null,
        sort: _sort,
      );
    });
  }

  void _clearFilters() {
    setState(() {
      _categorySlug = null;
      _city = null;
      _rating4Plus = false;
      _featuredOnly = false;
    });
    _refresh();
  }

  Future<void> _onPickCategory() async {
    // Lazy fetch the category list the first time the user taps
    // the chip. Subsequent taps reuse the cached set.
    if (_categories == null) {
      try {
        _categories = await _categoriesRepo!.list();
      } catch (_) {
        // Surface a SnackBar but don't break the picker — the
        // chip remains tappable so the user can retry.
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Categories could not be loaded.')),
        );
        return;
      }
    }
    if (!mounted) return;
    final picked = await showModalBottomSheet<_CategorySelection>(
      context: context,
      builder: (sheetCtx) {
        return _CategoryPickerSheet(
          categories: _categories!,
          selectedSlug: _categorySlug,
        );
      },
    );
    if (picked == null) return;
    setState(() => _categorySlug = picked.slug);
    _refresh();
  }

  Future<void> _onPickCity() async {
    final controller = TextEditingController(text: _city ?? '');
    final picked = await showDialog<String?>(
      context: context,
      builder: (dialogCtx) {
        return AlertDialog(
          title: const Text('City'),
          content: TextField(
            controller: controller,
            autofocus: true,
            decoration: const InputDecoration(hintText: 'Addis Ababa'),
            onSubmitted: (value) => Navigator.of(dialogCtx).pop(value),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogCtx).pop(''),
              child: const Text('Clear'),
            ),
            FilledButton(
              onPressed: () =>
                  Navigator.of(dialogCtx).pop(controller.text),
              child: const Text('Apply'),
            ),
          ],
        );
      },
    );
    if (picked == null) return;
    setState(() => _city = picked.trim().isEmpty ? null : picked.trim());
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.searchResultsTitle),
        actions: [
          PopupMenuButton<BusinessSort>(
            key: const ValueKey('searchSortMenu'),
            tooltip: l10n.searchSortBestMatch,
            icon: const Icon(Icons.sort),
            initialValue: _sort,
            onSelected: (value) {
              setState(() => _sort = value);
              _refresh();
            },
            itemBuilder: (menuCtx) => <PopupMenuEntry<BusinessSort>>[
              PopupMenuItem(
                value: BusinessSort.relevance,
                child: Text(l10n.searchSortBestMatch),
              ),
              PopupMenuItem(
                value: BusinessSort.rating,
                child: Text(l10n.searchSortTopRated),
              ),
              PopupMenuItem(
                value: BusinessSort.newest,
                child: Text(l10n.searchSortNewest),
              ),
              PopupMenuItem(
                value: BusinessSort.featured,
                child: Text(l10n.searchSortFeaturedFirst),
              ),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          _FilterChips(
            categorySlug: _categorySlug,
            city: _city,
            rating4Plus: _rating4Plus,
            featuredOnly: _featuredOnly,
            onTapCategory: _onPickCategory,
            onTapCity: _onPickCity,
            onToggleRating: () {
              setState(() => _rating4Plus = !_rating4Plus);
              _refresh();
            },
            onToggleFeatured: () {
              setState(() => _featuredOnly = !_featuredOnly);
              _refresh();
            },
          ),
          const Divider(height: 1),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                _refresh();
                try {
                  await _future;
                } catch (_) {
                  // Surfaced in the FutureBuilder; swallow here so
                  // the indicator dismisses.
                }
              },
              child: FutureBuilder<BusinessListPage>(
                future: _future,
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    return const _LoadingBody();
                  }
                  if (snapshot.hasError) {
                    return _ErrorBody(
                      error: snapshot.error!,
                      onRetry: _refresh,
                    );
                  }
                  final page = snapshot.data;
                  if (page == null || page.items.isEmpty) {
                    return _EmptyBody(onClearFilters: _clearFilters);
                  }
                  return ListView.separated(
                    physics: const AlwaysScrollableScrollPhysics(),
                    itemCount: page.items.length,
                    separatorBuilder: (_, __) => const Divider(height: 0),
                    itemBuilder: (rowCtx, i) {
                      return _BusinessListItem(
                        business: page.items[i],
                        detailRepositoriesOverride:
                            widget.detailRepositoriesOverride,
                      );
                    },
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FilterChips extends StatelessWidget {
  const _FilterChips({
    required this.categorySlug,
    required this.city,
    required this.rating4Plus,
    required this.featuredOnly,
    required this.onTapCategory,
    required this.onTapCity,
    required this.onToggleRating,
    required this.onToggleFeatured,
  });

  final String? categorySlug;
  final String? city;
  final bool rating4Plus;
  final bool featuredOnly;
  final VoidCallback onTapCategory;
  final VoidCallback onTapCity;
  final VoidCallback onToggleRating;
  final VoidCallback onToggleFeatured;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        children: [
          FilterChip(
            key: const ValueKey('searchFilter.category'),
            label: Text(categorySlug ?? 'Category'),
            selected: categorySlug != null,
            onSelected: (_) => onTapCategory(),
          ),
          const SizedBox(width: 8),
          FilterChip(
            key: const ValueKey('searchFilter.city'),
            label: Text(city ?? 'City'),
            selected: city != null,
            onSelected: (_) => onTapCity(),
          ),
          const SizedBox(width: 8),
          FilterChip(
            key: const ValueKey('searchFilter.rating4'),
            label: Text(l10n.searchRating4Plus),
            selected: rating4Plus,
            onSelected: (_) => onToggleRating(),
          ),
          const SizedBox(width: 8),
          FilterChip(
            key: const ValueKey('searchFilter.featuredOnly'),
            label: Text(l10n.searchFeaturedOnly),
            selected: featuredOnly,
            onSelected: (_) => onToggleFeatured(),
          ),
        ],
      ),
    );
  }
}

class _LoadingBody extends StatelessWidget {
  const _LoadingBody();
  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: const [
        SizedBox(height: 96),
        Center(child: CircularProgressIndicator()),
      ],
    );
  }
}

class _EmptyBody extends StatelessWidget {
  const _EmptyBody({required this.onClearFilters});
  final VoidCallback onClearFilters;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final colors = Theme.of(context).colorScheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(Icons.search_off, size: 56, color: colors.onSurfaceVariant),
        const SizedBox(height: 12),
        Text(
          l10n.searchEmptyTitle,
          style: Theme.of(context).textTheme.titleMedium,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        Center(
          child: OutlinedButton.icon(
            onPressed: onClearFilters,
            icon: const Icon(Icons.filter_alt_off),
            label: Text(l10n.searchClearFiltersAction),
          ),
        ),
      ],
    );
  }
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final colors = Theme.of(context).colorScheme;
    final isNetwork =
        error is BusinessesLoadFailure &&
        (error as BusinessesLoadFailure).isNetworkError;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(
          isNetwork ? Icons.wifi_off : Icons.error_outline,
          size: 56,
          color: colors.error,
        ),
        const SizedBox(height: 12),
        Text(
          error.toString(),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 16),
        Center(
          child: FilledButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: Text(l10n.commonTryAgain),
          ),
        ),
      ],
    );
  }
}

class _BusinessListItem extends StatelessWidget {
  const _BusinessListItem({
    required this.business,
    required this.detailRepositoriesOverride,
  });

  final BusinessSummary business;
  final BusinessDetailRepositories? detailRepositoriesOverride;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final name = business.name ?? 'Unnamed business';
    final ratingLine = business.ratingCount == 0
        ? 'No reviews yet'
        : '★ ${business.ratingAvg.toStringAsFixed(1)} '
            '(${business.ratingCount} review${business.ratingCount == 1 ? '' : 's'})';

    return ListTile(
      leading: CircleAvatar(
        backgroundColor: colors.primaryContainer,
        child: Icon(Icons.storefront, color: colors.onPrimaryContainer),
      ),
      title: Row(
        children: [
          Expanded(child: Text(name)),
          if (business.isCurrentlyFeatured()) ...[
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: colors.tertiaryContainer,
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                'Featured',
                style: textTheme.labelSmall?.copyWith(
                  color: colors.onTertiaryContainer,
                ),
              ),
            ),
          ],
        ],
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (business.city != null) Text(business.city!),
          Text(
            ratingLine,
            style: textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
        ],
      ),
      onTap: () {
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => BusinessDetailScreen(
              businessId: business.id,
              initialName: business.name,
              repositoriesOverride: detailRepositoriesOverride,
            ),
          ),
        );
      },
    );
  }
}

class _CategoryPickerSheet extends StatelessWidget {
  const _CategoryPickerSheet({
    required this.categories,
    required this.selectedSlug,
  });

  final List<Category> categories;
  final String? selectedSlug;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          ListTile(
            leading: const Icon(Icons.clear),
            title: const Text('Any category'),
            selected: selectedSlug == null,
            onTap: () =>
                Navigator.of(context).pop(const _CategorySelection(slug: null)),
          ),
          for (final c in categories)
            ListTile(
              leading: const Icon(Icons.category),
              title: Text(c.nameEn),
              selected: selectedSlug == c.slug,
              onTap: () => Navigator.of(context).pop(
                _CategorySelection(slug: c.slug),
              ),
            ),
        ],
      ),
    );
  }
}

class _CategorySelection {
  const _CategorySelection({required this.slug});
  final String? slug;
}
