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
import '../browse/data/categories_repository.dart';
import 'create_business_flow.dart';
import 'data/business_actions_repository.dart';
import 'data/owner_business_repository.dart';
import 'data/owner_services_repository.dart';
import 'models/owner_business_view.dart';
import 'owner_services_screen.dart';

class OwnerTab extends StatefulWidget {
  const OwnerTab({
    this.repositoryOverride,
    this.actionsRepositoryOverride,
    this.categoriesRepositoryOverride,
    this.servicesRepositoryOverride,
    super.key,
  });

  /// Test seam. Production builds an `HttpOwnerBusinessRepository`
  /// over the `AppConfigScope` `AppConfig`.
  final OwnerBusinessRepository? repositoryOverride;

  /// Test seam for the action repository the create-business flow
  /// and the DRAFT "Submit for review" button drive.
  final BusinessActionsRepository? actionsRepositoryOverride;

  /// Test seam for the categories dropdown inside the
  /// `CreateBusinessFlow` we push from the 404 CTA.
  final CategoriesRepository? categoriesRepositoryOverride;

  /// Test seam for the `OwnerServicesScreen` pushed when the
  /// dashboard's Services card is tapped.
  final OwnerServicesRepository? servicesRepositoryOverride;

  @override
  State<OwnerTab> createState() => _OwnerTabState();
}

class _OwnerTabState extends State<OwnerTab> {
  OwnerBusinessRepository? _repo;
  BusinessActionsRepository? _actionsRepo;
  Future<OwnerBusinessView>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.repositoryOverride ??
        HttpOwnerBusinessRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _actionsRepo = widget.actionsRepositoryOverride ??
        HttpBusinessActionsRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _refresh();
  }

  void _refresh() {
    setState(() {
      _future = _repo!.getMine();
    });
  }

  /// Push the multi-step `CreateBusinessFlow`. The flow pops back
  /// with the freshly-created `OwnerBusinessView` (or `null` if
  /// the user backed out). Either way we refresh — the server is
  /// the source of truth.
  Future<void> _openCreateFlow() async {
    await Navigator.of(context).push<OwnerBusinessView?>(
      MaterialPageRoute<OwnerBusinessView?>(
        builder: (_) => CreateBusinessFlow(
          categoriesRepositoryOverride: widget.categoriesRepositoryOverride,
          actionsRepositoryOverride: widget.actionsRepositoryOverride,
        ),
      ),
    );
    if (!mounted) return;
    _refresh();
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
              return _ErrorBranch(
                error: snapshot.error!,
                onRetry: _refresh,
                onCreateBusiness: _openCreateFlow,
              );
            }
            return OwnerDashboard(
              business: snapshot.data!,
              actionsRepository: _actionsRepo!,
              servicesRepositoryOverride: widget.servicesRepositoryOverride,
              onChanged: _refresh,
            );
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
  const _ErrorBranch({
    required this.error,
    required this.onRetry,
    required this.onCreateBusiness,
  });
  final Object error;
  final VoidCallback onRetry;
  final VoidCallback onCreateBusiness;

  @override
  Widget build(BuildContext context) {
    // The expected `OwnerBusinessLoadFailure` carries the typed
    // `kind`. Anything else (a thrown `Exception` from a fake repo,
    // for example) falls through to the generic error.
    if (error is OwnerBusinessLoadFailure) {
      switch ((error as OwnerBusinessLoadFailure).kind) {
        case OwnerBusinessLoadFailureKind.notFound:
          return _CreateBusinessCta(
            onRetry: onRetry,
            onCreate: onCreateBusiness,
          );
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
  const _CreateBusinessCta({required this.onRetry, required this.onCreate});
  final VoidCallback onRetry;
  final VoidCallback onCreate;

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
            onPressed: onCreate,
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
/// the current state. DRAFT / REJECTED render a banner with a
/// "Submit for review" action that hits
/// `POST /v1/businesses/{id}/submit`.
class OwnerDashboard extends StatelessWidget {
  const OwnerDashboard({
    required this.business,
    required this.actionsRepository,
    required this.onChanged,
    this.servicesRepositoryOverride,
    super.key,
  });
  final OwnerBusinessView business;
  final BusinessActionsRepository actionsRepository;

  /// Test seam forwarded to the `OwnerServicesScreen` we push when
  /// the Services card is tapped.
  final OwnerServicesRepository? servicesRepositoryOverride;

  /// Fired after a successful submit so the OwnerTab can refresh
  /// its loader and pick up the new status.
  final VoidCallback onChanged;

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
        if (business.isSubmittable)
          _SubmittableBanner(
            business: business,
            actionsRepository: actionsRepository,
            onSubmitted: onChanged,
          ),
        const SizedBox(height: 16),
        for (final spec in _cards) ...[
          _DashboardCard(
            spec: spec,
            onTap: () => _openCard(context, spec.label),
          ),
          const SizedBox(height: 8),
        ],
      ],
    );
  }

  /// Dispatches the dashboard-card tap. Services has its own
  /// real screen (Phase 9 Track 3.5 third commit); the remaining
  /// cards still SnackBar-stub until their dedicated commits land.
  void _openCard(BuildContext context, String label) {
    switch (label) {
      case 'Services':
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => OwnerServicesScreen(
              businessId: business.id,
              repositoryOverride: servicesRepositoryOverride,
            ),
          ),
        );
        return;
      default:
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '$label — coming soon in the next owner-flow commit.',
            ),
            duration: const Duration(seconds: 2),
          ),
        );
    }
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

class _SubmittableBanner extends StatefulWidget {
  const _SubmittableBanner({
    required this.business,
    required this.actionsRepository,
    required this.onSubmitted,
  });
  final OwnerBusinessView business;
  final BusinessActionsRepository actionsRepository;

  /// Invoked after a successful submit so the OwnerTab can refresh
  /// the loader and re-render the now-PENDING_REVIEW state.
  final VoidCallback onSubmitted;

  @override
  State<_SubmittableBanner> createState() => _SubmittableBannerState();
}

class _SubmittableBannerState extends State<_SubmittableBanner> {
  bool _busy = false;
  BusinessActionFailure? _error;

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.actionsRepository.submitBusiness(widget.business.id);
      if (!mounted) return;
      widget.onSubmitted();
    } on BusinessActionFailure catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (title, body) = widget.business.status == 'REJECTED'
        ? (
            'Rejected',
            'Your previous submission was rejected. Fix the noted issues '
                'and submit again.',
          )
        : (
            'Draft',
            'Your business is in draft. Submit it for admin review when '
                'you are ready.',
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
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(
              _errorCopy(_error!),
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.error,
                  ),
            ),
          ],
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: FilledButton.icon(
              onPressed: _busy ? null : _submit,
              icon: _busy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.send),
              label: const Text('Submit for review'),
            ),
          ),
        ],
      ),
    );
  }

  /// Maps the action-failure kind to user-facing copy for the
  /// inline message under the banner. Mirrors the
  /// `CreateBusinessFlow._ErrorBanner` mapping but lives separately
  /// because the banner inside the dashboard is space-constrained.
  String _errorCopy(BusinessActionFailure e) {
    switch (e.kind) {
      case BusinessActionFailureKind.validation:
        return e.message;
      case BusinessActionFailureKind.conflict:
        return 'This business is not in a submittable state right now.';
      case BusinessActionFailureKind.forbidden:
        return 'Access denied — sign out and back in to refresh your role.';
      case BusinessActionFailureKind.unauthenticated:
        return 'Sign in again to continue.';
      case BusinessActionFailureKind.network:
        return "Can't reach the server. Check your connection and retry.";
      case BusinessActionFailureKind.serverError:
      case BusinessActionFailureKind.notFound:
      case BusinessActionFailureKind.malformedResponse:
      case BusinessActionFailureKind.other:
        return 'Something went wrong. ${e.message}';
    }
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
  const _DashboardCard({required this.spec, required this.onTap});
  final _DashboardCardSpec spec;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      elevation: 0,
      color: colors.surfaceContainerHighest,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
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
