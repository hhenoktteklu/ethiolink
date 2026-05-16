// EthioLink Mobile — owner Promote (paid featuring) screen.
//
// Phase 9 Track 6 owner mobile UI. The dashboard's Promote card
// pushes this widget. It loads two requests in parallel:
//
//   * `GET /v1/businesses/{id}/featuring/active` — current
//     subscription if any. Branches the header to "Featured until
//     {date}" / "Not featured".
//   * `GET /v1/businesses/{id}/featuring/packages` — server-priced
//     7-day and 30-day options. Rendered as cards with a Purchase
//     button.
//
// Purchase tap calls `POST /v1/businesses/{id}/featuring/subscribe`
// with the chosen `packageCode`. The MVP gateway is `CashGateway`
// on the backend — the subscription returns ACTIVE immediately,
// so we surface a success SnackBar + refresh the header (which
// then renders "Featured until ..." and hides the package cards).
//
// Error surfaces are grouped:
//
//   * FEATURING_DISABLED (503) / ONLINE_PAYMENTS_UNAVAILABLE (503)
//     → top-level "Not yet available" banner. Owners can't purchase
//     until the operator opts in.
//   * ALREADY_ACTIVE (409) → inline banner above the cards. Rare
//     race: another tab or admin comp landed between load + tap.
//     Retrying the load surfaces the new active subscription.
//   * PAYMENT_REQUIRED (402) → inline banner ("Payment failed.
//     Try again or contact support.").
//   * UNAUTHENTICATED / FORBIDDEN / NOT_FOUND → standard reload
//     banners with sign-in / role guidance.
//   * Network / 5xx → "Can't reach the server" + Retry.
//
// "View history" footer link pushes `OwnerFeaturingHistoryScreen`
// regardless of the active state so owners can audit past
// subscriptions (including admin comps).

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import 'data/featuring_repository.dart';
import 'models/featuring.dart';
import 'owner_featuring_history_screen.dart';

/// Snapshot of the parallel load. Both queries succeed before the
/// screen renders the success branch — if either fails, we surface
/// the failure (the active query's failure takes precedence since
/// it gates the header).
class _PromoteSnapshot {
  const _PromoteSnapshot({
    required this.active,
    required this.packages,
  });
  final FeaturingSubscription? active;
  final List<FeaturingPackage> packages;
}

class OwnerPromoteScreen extends StatefulWidget {
  const OwnerPromoteScreen({
    required this.businessId,
    this.repositoryOverride,
    super.key,
  });

  /// The business whose featuring state we manage. Read from the
  /// loaded `OwnerBusinessView` at the call site.
  final String businessId;

  /// Test seam — production constructs `HttpFeaturingRepository`
  /// from the `AppConfigScope` `AppConfig`.
  final FeaturingRepository? repositoryOverride;

  @override
  State<OwnerPromoteScreen> createState() => _OwnerPromoteScreenState();
}

class _OwnerPromoteScreenState extends State<OwnerPromoteScreen> {
  FeaturingRepository? _repo;
  Future<_PromoteSnapshot>? _future;

  /// `true` while a subscribe request is in flight. Disables the
  /// package buttons + shows a spinner inline on the tapped card.
  String? _busyPackageCode;

  /// Most recent subscribe error, surfaced as an inline banner
  /// above the package cards. Cleared on the next successful load.
  FeaturingFailure? _subscribeError;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.repositoryOverride ??
        HttpFeaturingRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _refresh();
  }

  void _refresh() {
    setState(() {
      _subscribeError = null;
      _future = _load();
    });
  }

  Future<_PromoteSnapshot> _load() async {
    // Parallelise so the screen lands as fast as the slower call.
    final activeF = _repo!.getActive(widget.businessId);
    final packagesF = _repo!.listPackages(widget.businessId);
    final active = await activeF;
    final packages = await packagesF;
    return _PromoteSnapshot(active: active, packages: packages);
  }

  Future<void> _subscribe(FeaturingPackage pkg) async {
    setState(() {
      _busyPackageCode = pkg.code;
      _subscribeError = null;
    });
    try {
      final sub = await _repo!.subscribe(widget.businessId, pkg.code);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Featured until ${_formatDate(sub.endsAt)}.'),
          duration: const Duration(seconds: 3),
        ),
      );
      _refresh();
    } on FeaturingFailure catch (e) {
      if (!mounted) return;
      setState(() => _subscribeError = e);
    } finally {
      if (mounted) setState(() => _busyPackageCode = null);
    }
  }

  void _openHistory() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => OwnerFeaturingHistoryScreen(
          businessId: widget.businessId,
          repositoryOverride: widget.repositoryOverride,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Promote'),
        actions: [
          IconButton(
            tooltip: 'View history',
            icon: const Icon(Icons.history),
            onPressed: _openHistory,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          _refresh();
          try {
            await _future;
          } catch (_) {/* surfaced in FutureBuilder */}
        },
        child: FutureBuilder<_PromoteSnapshot>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState == ConnectionState.waiting) {
              return const _Loading();
            }
            if (snap.hasError) {
              return _LoadErrorBranch(
                error: snap.error!,
                onRetry: _refresh,
                onOpenHistory: _openHistory,
              );
            }
            final data = snap.data!;
            return _PromoteBody(
              active: data.active,
              packages: data.packages,
              subscribeError: _subscribeError,
              busyPackageCode: _busyPackageCode,
              onPurchase: _subscribe,
              onOpenHistory: _openHistory,
            );
          },
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Body — Featured / Not-featured header + package cards
// ---------------------------------------------------------------------------

class _PromoteBody extends StatelessWidget {
  const _PromoteBody({
    required this.active,
    required this.packages,
    required this.subscribeError,
    required this.busyPackageCode,
    required this.onPurchase,
    required this.onOpenHistory,
  });

  final FeaturingSubscription? active;
  final List<FeaturingPackage> packages;
  final FeaturingFailure? subscribeError;
  final String? busyPackageCode;
  final ValueChanged<FeaturingPackage> onPurchase;
  final VoidCallback onOpenHistory;

  @override
  Widget build(BuildContext context) {
    final isFeatured = active != null && active!.isActive;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        _StatusHeader(active: active),
        const SizedBox(height: 20),
        if (subscribeError != null) ...[
          _SubscribeErrorBanner(error: subscribeError!),
          const SizedBox(height: 12),
        ],
        if (!isFeatured) ...[
          Text(
            'Choose a package',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 4),
          Text(
            'Featured businesses show up first in search and on the '
            'home discovery surfaces. Pricing is in ETB.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 12),
          for (final pkg in packages) ...[
            _PackageCard(
              package: pkg,
              busy: busyPackageCode == pkg.code,
              disabled:
                  busyPackageCode != null && busyPackageCode != pkg.code,
              onPurchase: () => onPurchase(pkg),
            ),
            const SizedBox(height: 12),
          ],
          if (packages.isEmpty)
            Text(
              'No packages are available right now. Pull to refresh.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
        ],
        const SizedBox(height: 8),
        Center(
          child: TextButton.icon(
            onPressed: onOpenHistory,
            icon: const Icon(Icons.history),
            label: const Text('View history'),
          ),
        ),
      ],
    );
  }
}

class _StatusHeader extends StatelessWidget {
  const _StatusHeader({required this.active});
  final FeaturingSubscription? active;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isFeatured = active != null && active!.isActive;
    final iconBg = isFeatured ? colors.primaryContainer : colors.surfaceContainerHighest;
    final iconFg = isFeatured ? colors.onPrimaryContainer : colors.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: iconBg,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(
            isFeatured ? Icons.star : Icons.star_outline,
            size: 36,
            color: iconFg,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isFeatured ? 'Featured' : 'Not featured',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        color: iconFg,
                      ),
                ),
                const SizedBox(height: 2),
                Text(
                  isFeatured
                      ? 'Featured until ${_formatDate(active!.endsAt)}.'
                      : 'Pick a package below to promote your business.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: iconFg,
                      ),
                ),
                if (isFeatured && active!.isComp) ...[
                  const SizedBox(height: 4),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: colors.tertiaryContainer,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      'Comped by admin',
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: colors.onTertiaryContainer,
                          ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PackageCard extends StatelessWidget {
  const _PackageCard({
    required this.package,
    required this.busy,
    required this.disabled,
    required this.onPurchase,
  });
  final FeaturingPackage package;
  final bool busy;
  final bool disabled;
  final VoidCallback onPurchase;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      elevation: 0,
      color: colors.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Icon(Icons.calendar_month, size: 36, color: colors.primary),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${package.durationDays} days featured',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${package.priceEtb.toStringAsFixed(0)} ETB',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: colors.onSurfaceVariant,
                        ),
                  ),
                ],
              ),
            ),
            FilledButton.icon(
              onPressed: (busy || disabled) ? null : onPurchase,
              icon: busy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.shopping_cart_checkout),
              label: const Text('Purchase'),
            ),
          ],
        ),
      ),
    );
  }
}

class _SubscribeErrorBanner extends StatelessWidget {
  const _SubscribeErrorBanner({required this.error});
  final FeaturingFailure error;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (title, body) = _copyFor(error);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: colors.onErrorContainer),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        color: colors.onErrorContainer,
                      ),
                ),
                Text(
                  body,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.onErrorContainer,
                      ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  (String, String) _copyFor(FeaturingFailure e) {
    switch (e.kind) {
      case FeaturingFailureKind.alreadyActive:
        return (
          'Already featured',
          'Your business is already featured. Pull to refresh.',
        );
      case FeaturingFailureKind.paymentRequired:
        return (
          'Payment failed',
          'We could not complete the payment. Try again or contact '
              'support.',
        );
      case FeaturingFailureKind.network:
        return (
          "Can't reach the server",
          'Check your connection and try again.',
        );
      case FeaturingFailureKind.forbidden:
        return (
          'Access denied',
          'Sign out and back in to refresh your role, then try again.',
        );
      case FeaturingFailureKind.unauthenticated:
        return (
          'Sign in required',
          'Your session expired. Sign in again to continue.',
        );
      case FeaturingFailureKind.notFound:
        return (
          'Not found',
          'This business is no longer available. Pull to refresh.',
        );
      case FeaturingFailureKind.validation:
        return ('Check your details', e.message);
      case FeaturingFailureKind.disabled:
      case FeaturingFailureKind.unavailable:
      case FeaturingFailureKind.other:
        return ('Something went wrong', e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Loading / load-error branches
// ---------------------------------------------------------------------------

class _Loading extends StatelessWidget {
  const _Loading();
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

/// Branches the full-page load failure. `FEATURING_DISABLED` /
/// `ONLINE_PAYMENTS_UNAVAILABLE` is the special case — featuring
/// is gated by an env flag; surfacing it as a dedicated "Not yet
/// available" branch is friendlier than a generic error.
class _LoadErrorBranch extends StatelessWidget {
  const _LoadErrorBranch({
    required this.error,
    required this.onRetry,
    required this.onOpenHistory,
  });
  final Object error;
  final VoidCallback onRetry;
  final VoidCallback onOpenHistory;

  @override
  Widget build(BuildContext context) {
    if (error is FeaturingFailure) {
      switch ((error as FeaturingFailure).kind) {
        case FeaturingFailureKind.disabled:
        case FeaturingFailureKind.unavailable:
          return _NotYetAvailableBranch(onOpenHistory: onOpenHistory);
        case FeaturingFailureKind.unauthenticated:
          return _GenericErrorBranch(
            title: 'Sign in required',
            message: 'Your session expired. Sign in again to continue.',
            onRetry: onRetry,
          );
        case FeaturingFailureKind.forbidden:
          return _GenericErrorBranch(
            title: 'Access denied',
            message:
                "You don't have access to this business. Sign out and "
                'back in to refresh your role.',
            onRetry: onRetry,
          );
        case FeaturingFailureKind.notFound:
          return _GenericErrorBranch(
            title: 'Not found',
            message: 'This business is no longer available.',
            onRetry: onRetry,
          );
        case FeaturingFailureKind.network:
          return _GenericErrorBranch(
            title: "Can't reach the server",
            message: 'Check your connection and try again.',
            onRetry: onRetry,
            isNetwork: true,
          );
        case FeaturingFailureKind.alreadyActive:
        case FeaturingFailureKind.paymentRequired:
        case FeaturingFailureKind.validation:
        case FeaturingFailureKind.other:
          return _GenericErrorBranch(
            title: 'Could not load',
            message: error.toString(),
            onRetry: onRetry,
          );
      }
    }
    return _GenericErrorBranch(
      title: 'Something went wrong',
      message: error.toString(),
      onRetry: onRetry,
    );
  }
}

class _NotYetAvailableBranch extends StatelessWidget {
  const _NotYetAvailableBranch({required this.onOpenHistory});
  final VoidCallback onOpenHistory;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(Icons.hourglass_empty, size: 64, color: colors.primary),
        const SizedBox(height: 12),
        Text(
          'Not yet available',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'Paid featuring is coming soon. We will let you know as '
          'soon as it goes live.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 16),
        Center(
          child: TextButton.icon(
            onPressed: onOpenHistory,
            icon: const Icon(Icons.history),
            label: const Text('View history'),
          ),
        ),
      ],
    );
  }
}

class _GenericErrorBranch extends StatelessWidget {
  const _GenericErrorBranch({
    required this.title,
    required this.message,
    required this.onRetry,
    this.isNetwork = false,
  });
  final String title;
  final String message;
  final VoidCallback onRetry;
  final bool isNetwork;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
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
          title,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          message,
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

/// Format a `DateTime` for the "Featured until ..." copy. Renders
/// `Mon DD, YYYY` in the local-ish form — full intl formatting
/// lives in a follow-up commit alongside the broader Phase 9
/// localization sweep.
String _formatDate(DateTime dt) {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  final local = dt.toLocal();
  return '${months[local.month - 1]} ${local.day}, ${local.year}';
}
