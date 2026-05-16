// EthioLink Mobile — owner featuring history screen.
//
// Phase 9 Track 6 owner mobile UI. Pushed from
// `OwnerPromoteScreen` (and reused from the screen's load-error
// branches so owners can audit past subscriptions even when the
// active load fails).
//
// Renders `GET /v1/businesses/{id}/featuring/history`, newest
// first. Each row shows:
//
//   * Package code + duration window (e.g. "FEATURING_30D · Mar
//     1 → Mar 31, 2026").
//   * Status badge (PENDING / ACTIVE / EXPIRED / CANCELLED /
//     REFUNDED).
//   * Source badge — purchased vs. comped — so owners can tell
//     which subscriptions came from an admin grant.
//   * Cancellation reason on cancelled rows.
//
// Empty + error states mirror the Promote screen's branches.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import 'data/featuring_repository.dart';
import 'models/featuring.dart';

class OwnerFeaturingHistoryScreen extends StatefulWidget {
  const OwnerFeaturingHistoryScreen({
    required this.businessId,
    this.repositoryOverride,
    super.key,
  });

  final String businessId;

  /// Test seam — production constructs `HttpFeaturingRepository`
  /// from the `AppConfigScope` `AppConfig`.
  final FeaturingRepository? repositoryOverride;

  @override
  State<OwnerFeaturingHistoryScreen> createState() =>
      _OwnerFeaturingHistoryScreenState();
}

class _OwnerFeaturingHistoryScreenState
    extends State<OwnerFeaturingHistoryScreen> {
  FeaturingRepository? _repo;
  Future<List<FeaturingSubscription>>? _future;

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
      _future = _repo!.listHistory(widget.businessId);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Featuring history')),
      body: RefreshIndicator(
        onRefresh: () async {
          _refresh();
          try {
            await _future;
          } catch (_) {/* surfaced in FutureBuilder */}
        },
        child: FutureBuilder<List<FeaturingSubscription>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState == ConnectionState.waiting) {
              return const _Loading();
            }
            if (snap.hasError) {
              return _ErrorBranch(error: snap.error!, onRetry: _refresh);
            }
            final rows = snap.data ?? <FeaturingSubscription>[];
            if (rows.isEmpty) return const _EmptyState();
            return ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
              itemCount: rows.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, i) => _HistoryRow(subscription: rows[i]),
            );
          },
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Sub-widgets
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

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(Icons.history, size: 72, color: colors.primary),
        const SizedBox(height: 12),
        Text(
          'No featuring history yet',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'Once you purchase a featuring package, the subscription '
          'will show up here.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
      ],
    );
  }
}

class _ErrorBranch extends StatelessWidget {
  const _ErrorBranch({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isNetwork = error is FeaturingFailure &&
        (error as FeaturingFailure).kind == FeaturingFailureKind.network;
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
          isNetwork
              ? "Can't reach the server"
              : 'Could not load history',
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

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({required this.subscription});
  final FeaturingSubscription subscription;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      elevation: 0,
      color: colors.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    subscription.packageCode,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                _StatusChip(status: subscription.status),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              '${_formatDate(subscription.startsAt)} → '
              '${_formatDate(subscription.endsAt)}',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                _SourceChip(isComp: subscription.isComp),
                const SizedBox(width: 8),
                Text(
                  '${subscription.priceEtb.toStringAsFixed(0)} ETB',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                ),
              ],
            ),
            if (subscription.cancelledReason != null &&
                subscription.cancelledReason!.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                'Cancelled: ${subscription.cancelledReason!}',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.error,
                    ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (bg, fg) = switch (status) {
      'ACTIVE' => (colors.primaryContainer, colors.onPrimaryContainer),
      'PENDING_PAYMENT' => (
          colors.tertiaryContainer,
          colors.onTertiaryContainer,
        ),
      'EXPIRED' => (colors.surfaceContainerHigh, colors.onSurfaceVariant),
      'CANCELLED' || 'REFUNDED' => (
          colors.errorContainer,
          colors.onErrorContainer,
        ),
      _ => (colors.surfaceContainerHigh, colors.onSurfaceVariant),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        status,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: fg,
              letterSpacing: 0.5,
            ),
      ),
    );
  }
}

class _SourceChip extends StatelessWidget {
  const _SourceChip({required this.isComp});
  final bool isComp;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final bg =
        isComp ? colors.tertiaryContainer : colors.secondaryContainer;
    final fg =
        isComp ? colors.onTertiaryContainer : colors.onSecondaryContainer;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        isComp ? 'COMPED' : 'PURCHASED',
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: fg,
              letterSpacing: 0.5,
            ),
      ),
    );
  }
}

String _formatDate(DateTime dt) {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  final local = dt.toLocal();
  return '${months[local.month - 1]} ${local.day}, ${local.year}';
}
