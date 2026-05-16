// EthioLink Mobile — owner tab entry point.
//
// Phase 9 Track 3.5 first commit. Loads `GET /v1/me/business` and
// dispatches to one of four branches:
//
//   * `OwnerDashboard` — the business exists and we render the
//     five entry-card hub (Profile / Services / Staff /
//     Availability / Bookings). Each card is a placeholder for
//     follow-up commits; tap → SnackBar.
//   * `_CreateBusinessCta` — the API returned 404 (no business
//     yet). Single-button CTA. Tap → placeholder
//     CreateBusinessFlow stub.
//   * `_ForbiddenBanner` — 403 forbidden. The user's role drifted
//     since their last token issue; sign-out + back-in resolves
//     it.
//   * `_GenericErrorBanner` — anything else (5xx, network,
//     malformed). Retry button.
//
// State management mirrors the customer screens: a `FutureBuilder`
// keyed off a `Future<OwnerBusinessView>` field; Retry rebuilds
// the future.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import 'data/owner_business_repository.dart';
import 'models/owner_business_view.dart';

class OwnerTab extends StatefulWidget {
  const OwnerTab({this.repositoryOverride, super.key});

  /// Test seam. Production builds an `HttpOwnerBusinessRepository`
  /// over the `AppConfigScope` `AppConfig`.
  final OwnerBusinessRepository? repositoryOverride;

  @override
  State<OwnerTab> createState() => _OwnerTabState();
}

class _OwnerTabState extends State<OwnerTab> {
  OwnerBusinessRepository? _repo;
  Future<OwnerBusinessView>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.repositoryOverride ??
        HttpOwnerBusinessRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _refresh();
  }

  void _refresh() {
    setState(() {
      _future = _repo!.getMine();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('My Business')),
      body: RefreshIndicator(
        onRefresh: () async {
          _refresh();
          try {
            await _future;
          } catch (_) {/* swallow — surfaced in FutureBuilder */}
        },
        child: FutureBuilder<OwnerBusinessView>(
          future: _future,
          builder: (context, snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const _LoadingBody();
            }
            if (snapshot.hasError) {
              return _ErrorBranch(error: snapshot.error!, onRetry: _refresh);
            }
            return OwnerDashboard(business: snapshot.data!);
          },
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Loading / error branches
// ---------------------------------------------------------------------------

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

class _ErrorBranch extends StatelessWidget {
  const _ErrorBranch({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    // The expected `OwnerBusinessLoadFailure` carries the typed
    // `kind`. Anything else (a thrown `Exception` from a fake repo,
    // for example) falls through to the generic error.
    if (error is OwnerBusinessLoadFailure) {
      switch ((error as OwnerBusinessLoadFailure).kind) {
        case OwnerBusinessLoadFailureKind.notFound:
          return _CreateBusinessCta(onRetry: onRetry);
        case OwnerBusinessLoadFailureKind.forbidden:
          return _ForbiddenBanner();
        case OwnerBusinessLoadFailureKind.unauthenticated:
          return _GenericErrorBanner(
            title: 'Sign in required',
            message:
                'Your session expired. Sign out and back in to continue.',
            onRetry: onRetry,
          );
        case OwnerBusinessLoadFailureKind.network:
          return _GenericErrorBanner(
            title: "Can't reach the server",
            message: 'Check your connection and try again.',
            onRetry: onRetry,
            isNetwork: true,
          );
        case OwnerBusinessLoadFailureKind.serverError:
        case OwnerBusinessLoadFailureKind.malformedResponse:
        case OwnerBusinessLoadFailureKind.other:
          return _GenericErrorBanner(
            title: 'Could not load your business',
            message: error.toString(),
            onRetry: onRetry,
          );
      }
    }
    return _GenericErrorBanner(
      title: 'Something went wrong',
      message: error.toString(),
      onRetry: onRetry,
    );
  }
}

class _CreateBusinessCta extends StatelessWidget {
  const _CreateBusinessCta({required this.onRetry});
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(
          Icons.storefront_outlined,
          size: 80,
          color: colors.primary,
        ),
        const SizedBox(height: 16),
        Text(
          'No business yet',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        Text(
          'Create a business profile to start accepting bookings.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 24),
        Center(
          child: FilledButton.icon(
            onPressed: () {
              // Phase 9 Track 3.5 placeholder. The multi-step
              // creation form is the next commit on this track.
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text(
                    'Create-business form lands in the next mobile commit.',
                  ),
                  duration: Duration(seconds: 2),
                ),
              );
            },
            icon: const Icon(Icons.add_business),
            label: const Text('Create your business'),
          ),
        ),
        const SizedBox(height: 8),
        Center(
          child: TextButton(
            onPressed: onRetry,
            child: const Text('Refresh'),
          ),
        ),
      ],
    );
  }
}

class _ForbiddenBanner extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(Icons.lock_outline, size: 56, color: colors.error),
        const SizedBox(height: 12),
        Text(
          'Access denied',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          "You don't have access to this section yet. If you "
          'recently became a business owner, sign out and back '
          'in to refresh your role.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
      ],
    );
  }
}

class _GenericErrorBanner extends StatelessWidget {
  const _GenericErrorBanner({
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

// ---------------------------------------------------------------------------
// OwnerDashboard — placeholder for the APPROVED state
// ---------------------------------------------------------------------------

/// Renders the five entry-card hub. Each card is a placeholder
/// for a follow-up commit; tap → SnackBar pointing at the
/// upcoming work. Status-aware: PENDING_REVIEW / REJECTED /
/// SUSPENDED render a status banner above the cards explaining
/// the current state.
class OwnerDashboard extends StatelessWidget {
  const OwnerDashboard({required this.business, super.key});
  final OwnerBusinessView business;

  static const _cards = <_DashboardCardSpec>[
    _DashboardCardSpec(
      icon: Icons.business,
      label: 'Profile',
      blurb: 'Name, description, contact, location.',
    ),
    _DashboardCardSpec(
      icon: Icons.design_services,
      label: 'Services',
      blurb: 'Bookable services + price + duration.',
    ),
    _DashboardCardSpec(
      icon: Icons.badge,
      label: 'Staff',
      blurb: 'Active staff roster.',
    ),
    _DashboardCardSpec(
      icon: Icons.schedule,
      label: 'Availability',
      blurb: 'Weekly schedule + overrides per staff.',
    ),
    _DashboardCardSpec(
      icon: Icons.inbox,
      label: 'Bookings',
      blurb: 'Incoming + upcoming appointments.',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _BusinessHeader(business: business),
        const SizedBox(height: 8),
        if (business.isReadOnly) _PendingBanner(status: business.status),
        if (business.isSubmittable) _SubmittableBanner(status: business.status),
        const SizedBox(height: 16),
        for (final spec in _cards) ...[
          _DashboardCard(spec: spec),
          const SizedBox(height: 8),
        ],
      ],
    );
  }
}

class _BusinessHeader extends StatelessWidget {
  const _BusinessHeader({required this.business});
  final OwnerBusinessView business;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          business.name ?? 'Unnamed business',
          style: textTheme.headlineSmall,
        ),
        const SizedBox(height: 2),
        Row(
          children: [
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              decoration: BoxDecoration(
                color: colors.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                business.status,
                style: textTheme.labelSmall?.copyWith(
                  color: colors.onSurfaceVariant,
                  letterSpacing: 0.5,
                ),
              ),
            ),
            if (business.city != null) ...[
              const SizedBox(width: 8),
              Text(
                business.city!,
                style: textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }
}

class _PendingBanner extends StatelessWidget {
  const _PendingBanner({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (title, body) = status == 'SUSPENDED'
        ? (
            'Suspended',
            'Your business is suspended. Contact support to restore it.',
          )
        : (
            'Awaiting review',
            'An admin is reviewing your business. You will be notified when the '
                'decision lands.',
          );
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.secondaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: colors.onSecondaryContainer,
                ),
          ),
          const SizedBox(height: 4),
          Text(
            body,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSecondaryContainer,
                ),
          ),
        ],
      ),
    );
  }
}

class _SubmittableBanner extends StatelessWidget {
  const _SubmittableBanner({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (title, body) = status == 'REJECTED'
        ? (
            'Rejected',
            'Your previous submission was rejected. Fix the noted issues '
                'and submit again.',
          )
        : (
            'Draft',
            'Your business is in draft. Add services + staff + availability, '
                'then submit for review.',
          );
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.tertiaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: colors.onTertiaryContainer,
                ),
          ),
          const SizedBox(height: 4),
          Text(
            body,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onTertiaryContainer,
                ),
          ),
        ],
      ),
    );
  }
}

class _DashboardCardSpec {
  const _DashboardCardSpec({
    required this.icon,
    required this.label,
    required this.blurb,
  });
  final IconData icon;
  final String label;
  final String blurb;
}

class _DashboardCard extends StatelessWidget {
  const _DashboardCard({required this.spec});
  final _DashboardCardSpec spec;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      elevation: 0,
      color: colors.surfaceContainerHighest,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () {
          // Each card is a placeholder. The follow-up commits
          // replace these SnackBars with real screens.
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(
                '${spec.label} — coming soon in the next owner-flow commit.',
              ),
              duration: const Duration(seconds: 2),
            ),
          );
        },
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Icon(spec.icon, size: 32, color: colors.primary),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      spec.label,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      spec.blurb,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right, color: colors.onSurfaceVariant),
            ],
          ),
        ),
      ),
    );
  }
}
