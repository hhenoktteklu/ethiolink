// EthioLink Mobile — businesses listing screen.
//
// Pushed when the operator taps a category card on `BrowseScreen`.
// Loads `GET /v1/businesses?category=<slug>` and renders the
// resulting `BusinessSummary` list. State machine matches the
// browse-tab pattern:
//
//   * `_Loading`  — initial fetch pending.
//   * `_Success`  — non-empty list, paginated via "Load more"
//                   when `nextCursor != null`.
//   * `_Empty`    — zero APPROVED businesses in this category.
//                   Empty-state copy + Retry button. Common when
//                   the dev DB hasn't been seeded with businesses
//                   in this slug yet.
//   * `_Error`    — `BusinessesLoadFailure`. Network-vs-server
//                   error variant + Retry button.
//
// Pagination: a single tap on "Load more" issues the next page
// request and appends. No infinite scroll yet — the post-MVP
// design pass evaluates whether scrolling-loaded discovery is
// the right UX for the marketplace before we wire an
// `IntersectionObserver`-equivalent.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import 'business_detail_screen.dart';
import 'data/business_detail_repositories.dart';
import 'data/businesses_repository.dart';
import 'models/business_summary.dart';
import 'models/category.dart';

class BusinessesScreen extends StatefulWidget {
  const BusinessesScreen({
    required this.category,
    this.repositoryOverride,
    this.detailRepositoriesOverride,
    super.key,
  });

  /// The category the user tapped on BrowseScreen. Passed in
  /// whole (not just the slug) so the screen can show the
  /// English name in the app bar without an extra fetch.
  final Category category;

  /// Test seam. Production constructs an `HttpBusinessesRepository`
  /// over the `AppConfigScope`-injected `AppConfig`.
  final BusinessesRepository? repositoryOverride;

  /// Forwarded to `BusinessDetailScreen` when the user taps a
  /// row. Tests use this to short-circuit the four detail-side
  /// fetches; production leaves it null.
  final BusinessDetailRepositories? detailRepositoriesOverride;

  @override
  State<BusinessesScreen> createState() => _BusinessesScreenState();
}

class _BusinessesScreenState extends State<BusinessesScreen> {
  BusinessesRepository? _repo;

  // Aggregated items across pages. Each successful fetch appends.
  final List<BusinessSummary> _items = <BusinessSummary>[];
  String? _nextCursor;

  // The single "in-flight" future drives the FutureBuilder. We
  // hold it as a State field rather than letting FutureBuilder
  // own it so the Retry button can replace it.
  Future<void>? _initialLoad;
  bool _loadingMore = false;
  Object? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.repositoryOverride ??
        HttpBusinessesRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _initialLoad = _fetchFirstPage();
  }

  Future<void> _fetchFirstPage() async {
    setState(() {
      _items.clear();
      _nextCursor = null;
      _error = null;
    });
    try {
      final page = await _repo!.list(category: widget.category.slug);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _nextCursor = page.nextCursor;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    }
  }

  Future<void> _fetchNextPage() async {
    final cursor = _nextCursor;
    if (cursor == null || _loadingMore) return;
    setState(() => _loadingMore = true);
    try {
      final page =
          await _repo!.list(category: widget.category.slug, cursor: cursor);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _nextCursor = page.nextCursor;
        _loadingMore = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _loadingMore = false;
      });
    }
  }

  void _retry() {
    setState(() {
      _error = null;
      _initialLoad = _fetchFirstPage();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.category.nameEn),
      ),
      body: RefreshIndicator(
        onRefresh: _fetchFirstPage,
        child: FutureBuilder<void>(
          future: _initialLoad,
          builder: (context, snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting &&
                _items.isEmpty) {
              return const _LoadingState();
            }
            if (_error != null && _items.isEmpty) {
              return _ErrorState(error: _error!, onRetry: _retry);
            }
            if (_items.isEmpty) {
              return _EmptyState(
                category: widget.category,
                onRetry: _retry,
              );
            }
            return _ResultsList(
              items: _items,
              nextCursor: _nextCursor,
              loadingMore: _loadingMore,
              onLoadMore: _fetchNextPage,
              pageError: _items.isNotEmpty ? _error : null,
              onRetryNext: _fetchNextPage,
              detailRepositoriesOverride: widget.detailRepositoriesOverride,
            );
          },
        ),
      ),
    );
  }
}

class _LoadingState extends StatelessWidget {
  const _LoadingState();

  @override
  Widget build(BuildContext context) {
    return ListView(
      // Allow pull-to-refresh on loading too.
      physics: const AlwaysScrollableScrollPhysics(),
      children: const [
        SizedBox(height: 96),
        Center(child: CircularProgressIndicator()),
      ],
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.category, required this.onRetry});

  final Category category;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(
          Icons.store_mall_directory_outlined,
          size: 56,
          color: colors.onSurfaceVariant,
        ),
        const SizedBox(height: 12),
        Text(
          'No ${category.nameEn.toLowerCase()} listed yet.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'Approved businesses will appear here once they list '
          'in this category. Pull down to refresh.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 16),
        Center(
          child: OutlinedButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        ),
      ],
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
    final isNetwork = error is BusinessesLoadFailure &&
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
          isNetwork ? "Can't reach the server" : 'Something went wrong',
          textAlign: TextAlign.center,
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
        Center(
          child: FilledButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Try again'),
          ),
        ),
      ],
    );
  }
}

class _ResultsList extends StatelessWidget {
  const _ResultsList({
    required this.items,
    required this.nextCursor,
    required this.loadingMore,
    required this.onLoadMore,
    required this.pageError,
    required this.onRetryNext,
    required this.detailRepositoriesOverride,
  });

  final List<BusinessSummary> items;
  final String? nextCursor;
  final bool loadingMore;
  final VoidCallback onLoadMore;

  /// Error from the most recent pagination request (only set
  /// when the FIRST page is already on screen). Lets the user
  /// see the partial result + retry the next page without
  /// losing the first.
  final Object? pageError;
  final VoidCallback onRetryNext;

  final BusinessDetailRepositories? detailRepositoriesOverride;

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: items.length + 1, // +1 for the footer.
      separatorBuilder: (_, __) => const Divider(height: 0),
      itemBuilder: (context, i) {
        if (i < items.length) {
          return _BusinessListItem(
            business: items[i],
            detailRepositoriesOverride: detailRepositoriesOverride,
          );
        }
        return _ListFooter(
          nextCursor: nextCursor,
          loadingMore: loadingMore,
          onLoadMore: onLoadMore,
          pageError: pageError,
          onRetry: onRetryNext,
        );
      },
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
              padding:
                  const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
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

class _ListFooter extends StatelessWidget {
  const _ListFooter({
    required this.nextCursor,
    required this.loadingMore,
    required this.onLoadMore,
    required this.pageError,
    required this.onRetry,
  });

  final String? nextCursor;
  final bool loadingMore;
  final VoidCallback onLoadMore;
  final Object? pageError;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    if (pageError != null) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Text(
              'Failed to load more.',
              style: TextStyle(color: colors.error),
            ),
            const SizedBox(height: 4),
            Text(
              pageError.toString(),
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('Try again'),
            ),
          ],
        ),
      );
    }
    if (loadingMore) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 16),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (nextCursor != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 16),
        child: Center(
          child: OutlinedButton.icon(
            onPressed: onLoadMore,
            icon: const Icon(Icons.expand_more),
            label: const Text('Load more'),
          ),
        ),
      );
    }
    return const SizedBox(height: 16);
  }
}
