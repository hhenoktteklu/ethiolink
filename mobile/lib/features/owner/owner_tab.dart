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
import 'package:ethiolink/generated/l10n/app_localizations.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/data/categories_repository.dart';
import 'create_business_flow.dart';
import 'data/availability_repository.dart';
import 'data/business_actions_repository.dart';
import 'data/featuring_repository.dart';
import 'data/owner_bookings_repository.dart';
import 'data/owner_business_repository.dart';
import 'data/owner_services_repository.dart';
import 'data/owner_staff_repository.dart';
import 'models/owner_business_view.dart';
import 'owner_availability_screen.dart';
import 'owner_bookings_screen.dart';
import 'owner_profile_screen.dart';
import 'owner_promote_screen.dart';
import 'owner_services_screen.dart';
import 'owner_staff_screen.dart';
import 'submit_readiness.dart';

class OwnerTab extends StatefulWidget {
  const OwnerTab({
    this.repositoryOverride,
    this.actionsRepositoryOverride,
    this.categoriesRepositoryOverride,
    this.servicesRepositoryOverride,
    this.staffRepositoryOverride,
    this.availabilityRepositoryOverride,
    this.bookingsRepositoryOverride,
    this.featuringRepositoryOverride,
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

  /// Test seam for the `OwnerStaffScreen` pushed when the
  /// dashboard's Staff card is tapped.
  final OwnerStaffRepository? staffRepositoryOverride;

  /// Test seam for the `OwnerAvailabilityScreen` pushed when the
  /// dashboard's Availability card is tapped.
  final AvailabilityRepository? availabilityRepositoryOverride;

  /// Test seam for the `OwnerBookingsScreen` pushed when the
  /// dashboard's Bookings card is tapped.
  final OwnerBookingsRepository? bookingsRepositoryOverride;

  /// Test seam for the `OwnerPromoteScreen` pushed when the
  /// dashboard's Promote card is tapped.
  final FeaturingRepository? featuringRepositoryOverride;

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
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.navOwner)),
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
              categoriesRepositoryOverride:
                  widget.categoriesRepositoryOverride,
              servicesRepositoryOverride: widget.servicesRepositoryOverride,
              staffRepositoryOverride: widget.staffRepositoryOverride,
              availabilityRepositoryOverride:
                  widget.availabilityRepositoryOverride,
              bookingsRepositoryOverride: widget.bookingsRepositoryOverride,
              featuringRepositoryOverride:
                  widget.featuringRepositoryOverride,
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
    final l10n = AppLocalizations.of(context);
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
          l10n.ownerNoBusinessTitle,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        Text(
          l10n.ownerNoBusinessBody,
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
            label: Text(l10n.ownerCreateBusinessAction),
          ),
        ),
        const SizedBox(height: 8),
        Center(
          child: TextButton(
            onPressed: onRetry,
            child: Text(l10n.ownerRefreshAction),
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
    final l10n = AppLocalizations.of(context);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(Icons.lock_outline, size: 56, color: colors.error),
        const SizedBox(height: 12),
        Text(
          l10n.ownerAccessDeniedTitle,
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
            label: Text(AppLocalizations.of(context).commonTryAgain),
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
    this.categoriesRepositoryOverride,
    this.servicesRepositoryOverride,
    this.staffRepositoryOverride,
    this.availabilityRepositoryOverride,
    this.bookingsRepositoryOverride,
    this.featuringRepositoryOverride,
    super.key,
  });
  final OwnerBusinessView business;
  final BusinessActionsRepository actionsRepository;

  /// Test seam forwarded to the `OwnerProfileScreen` we push when
  /// the Profile card is tapped.
  final CategoriesRepository? categoriesRepositoryOverride;

  /// Test seam forwarded to the `OwnerServicesScreen` we push when
  /// the Services card is tapped.
  final OwnerServicesRepository? servicesRepositoryOverride;

  /// Test seam forwarded to the `OwnerStaffScreen` we push when
  /// the Staff card is tapped.
  final OwnerStaffRepository? staffRepositoryOverride;

  /// Test seam forwarded to the `OwnerAvailabilityScreen` we push
  /// when the Availability card is tapped.
  final AvailabilityRepository? availabilityRepositoryOverride;

  /// Test seam forwarded to the `OwnerBookingsScreen` we push
  /// when the Bookings card is tapped.
  final OwnerBookingsRepository? bookingsRepositoryOverride;

  /// Test seam forwarded to the `OwnerPromoteScreen` we push when
  /// the Promote card is tapped.
  final FeaturingRepository? featuringRepositoryOverride;

  /// Fired after a successful submit so the OwnerTab can refresh
  /// its loader and pick up the new status.
  final VoidCallback onChanged;

  /// Stable identifiers for the six dashboard entry cards. The
  /// `_openCard` switch dispatches off these enum values rather
  /// than a label string so the dispatch survives locale changes
  /// — only the rendered label moves through `AppLocalizations`.
  /// Promote sits between Profile and Services so the upsell is
  /// the first option after the business identity card.
  static const _cards = <_DashboardCardKind>[
    _DashboardCardKind.profile,
    _DashboardCardKind.promote,
    _DashboardCardKind.services,
    _DashboardCardKind.staff,
    _DashboardCardKind.availability,
    _DashboardCardKind.bookings,
  ];

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    // Compute submit-readiness once at the dashboard level so the
    // banner AND any cards that visually reflect blockers (today
    // only the Profile card) share the same source of truth.
    // Other statuses (PENDING_REVIEW / APPROVED / SUSPENDED) don't
    // render a submit affordance; the chip is silent for them
    // even if readiness somehow flags issues.
    final readiness = business.isSubmittable
        ? evaluateSubmitReadiness(business)
        : const SubmitReadiness(<SubmitReadinessIssue>[]);
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
        for (final kind in _cards) ...[
          _DashboardCard(
            spec: _specFor(kind, l10n),
            // Only the Profile card has a submit-gate today
            // (backend's missingForSubmit lists name + description
            // + city + categoryId, all owned by the profile
            // screen). Services / Staff / Availability cards
            // are NOT submit gates server-side, so we don't
            // dangle a misleading "Missing info" chip on them.
            // If a future commit promotes one of those to a
            // submit gate, extend submit_readiness.dart AND
            // mirror the section name here.
            incomplete: kind == _DashboardCardKind.profile &&
                readiness.blockedSections.contains('Profile'),
            onTap: () => _openCard(context, kind),
          ),
          const SizedBox(height: 8),
        ],
      ],
    );
  }

  /// Builds the icon / label / blurb for a card kind. The label
  /// flows through `AppLocalizations`; blurbs stay English-only
  /// for this commit and get a native-speaker translation pass
  /// alongside the Amharic ARB.
  static _DashboardCardSpec _specFor(
    _DashboardCardKind kind,
    AppLocalizations l10n,
  ) {
    switch (kind) {
      case _DashboardCardKind.profile:
        return _DashboardCardSpec(
          icon: Icons.business,
          label: l10n.ownerCardProfile,
          blurb: 'Name, description, contact, location.',
        );
      case _DashboardCardKind.promote:
        return _DashboardCardSpec(
          icon: Icons.campaign,
          label: l10n.ownerCardPromote,
          blurb: 'Feature your business at the top of search.',
        );
      case _DashboardCardKind.services:
        return _DashboardCardSpec(
          icon: Icons.design_services,
          label: l10n.ownerCardServices,
          blurb: 'Bookable services + price + duration.',
        );
      case _DashboardCardKind.staff:
        return _DashboardCardSpec(
          icon: Icons.badge,
          label: l10n.ownerCardStaff,
          blurb: 'Active staff roster.',
        );
      case _DashboardCardKind.availability:
        return _DashboardCardSpec(
          icon: Icons.schedule,
          label: l10n.ownerCardAvailability,
          blurb: 'Weekly schedule + overrides per staff.',
        );
      case _DashboardCardKind.bookings:
        return _DashboardCardSpec(
          icon: Icons.inbox,
          label: l10n.ownerCardBookings,
          blurb: 'Incoming + upcoming appointments.',
        );
    }
  }

  /// Dispatches the dashboard-card tap. All five cards have real
  /// screens — Track 3.5 closed end-to-end.
  void _openCard(BuildContext context, _DashboardCardKind kind) {
    switch (kind) {
      case _DashboardCardKind.profile:
        Navigator.of(context).push(
          MaterialPageRoute<OwnerBusinessView?>(
            builder: (_) => OwnerProfileScreen(
              business: business,
              actionsRepositoryOverride: actionsRepository,
              categoriesRepositoryOverride: categoriesRepositoryOverride,
            ),
          ),
        ).then((updated) {
          if (updated != null) onChanged();
        });
        return;
      case _DashboardCardKind.promote:
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => OwnerPromoteScreen(
              businessId: business.id,
              repositoryOverride: featuringRepositoryOverride,
            ),
          ),
        );
        return;
      case _DashboardCardKind.services:
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => OwnerServicesScreen(
              businessId: business.id,
              repositoryOverride: servicesRepositoryOverride,
            ),
          ),
        );
        return;
      case _DashboardCardKind.staff:
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => OwnerStaffScreen(
              businessId: business.id,
              repositoryOverride: staffRepositoryOverride,
            ),
          ),
        );
        return;
      case _DashboardCardKind.availability:
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => OwnerAvailabilityScreen(
              businessId: business.id,
              staffRepositoryOverride: staffRepositoryOverride,
              availabilityRepositoryOverride:
                  availabilityRepositoryOverride,
            ),
          ),
        );
        return;
      case _DashboardCardKind.bookings:
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => OwnerBookingsScreen(
              businessId: business.id,
              repositoryOverride: bookingsRepositoryOverride,
            ),
          ),
        );
        return;
    }
  }
}

enum _DashboardCardKind {
  profile,
  promote,
  services,
  staff,
  availability,
  bookings,
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

  /// Local pre-flight: if the OwnerBusinessView already has
  /// blocking gaps we render the checklist + disable the submit
  /// button INSTEAD of issuing a network call we know will fail.
  /// Server-side defense-in-depth fires through `_error` if a
  /// concurrent edit cleared a field between fetches.
  SubmitReadiness get _readiness =>
      evaluateSubmitReadiness(widget.business);

  /// Issue list to render. Prefers the server's `missing[]` when
  /// present (handles the rare race where the dashboard's cached
  /// view is fresher than the server's). Falls back to the local
  /// readiness when only one side flagged the issue.
  List<SubmitReadinessIssue> get _issuesToRender {
    final err = _error;
    if (err != null && err.kind == BusinessActionFailureKind.validation) {
      final mapped = <SubmitReadinessIssue>[];
      for (final key in err.missingFields) {
        final issue = issueForBackendField(key);
        if (issue != null) {
          mapped.add(issue);
        } else {
          // Unknown field — surface the raw key so we don't
          // silently hide a new backend gate. The dashboard
          // section falls back to "Other".
          mapped.add(SubmitReadinessIssue(
            backendFieldKey: key,
            section: 'Other',
            fieldLabel: key,
          ));
        }
      }
      if (mapped.isNotEmpty) return mapped;
    }
    return _readiness.issues;
  }

  Future<void> _submit() async {
    // Pre-flight. If anything's missing locally don't even hit
    // the backend — the structured checklist is already on
    // screen via `_issuesToRender`. (The button is disabled in
    // this state, but this guard is also the failsafe for any
    // future programmatic invocation.)
    if (!_readiness.isReady) {
      // Clear any previous server-side error; the local
      // readiness already covers it.
      setState(() => _error = null);
      return;
    }
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
    final isRejected = widget.business.status == 'REJECTED';
    // Pull the admin's reject-note off the owner-view (populated
    // by GET /v1/me/business from the latest `REJECT_BUSINESS`
    // row in admin_actions). When the admin supplied a note we
    // surface it inline below the banner copy in a distinct
    // sub-container so it reads as the admin's words, not app copy.
    final rejection = widget.business.rejection;
    final hasRejectReason = isRejected &&
        rejection?.reason != null &&
        rejection!.reason!.isNotEmpty;
    final (title, body) = isRejected
        ? (
            'Rejected',
            hasRejectReason
                ? 'An admin rejected this submission. Read the note below, '
                    'address the feedback, and submit again.'
                : 'Your previous submission was rejected. Fix the noted issues '
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
          if (hasRejectReason) ...[
            const SizedBox(height: 10),
            Container(
              key: const Key('ownerRejectReason'),
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: colors.surface,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: colors.outlineVariant),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Admin note',
                    style:
                        Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: colors.onSurfaceVariant,
                              fontWeight: FontWeight.w600,
                              letterSpacing: 0.4,
                            ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    rejection.reason!,
                    style:
                        Theme.of(context).textTheme.bodyMedium?.copyWith(
                              color: colors.onSurface,
                            ),
                  ),
                ],
              ),
            ),
          ],
          // Structured "Complete these before submitting" checklist.
          // Renders when the local readiness flags any blocker OR
          // when a server-side 400 surfaces `details.missing[]`.
          // Replaces the previous vague "Business is missing
          // required fields for submission" inline error — the
          // checklist names every blocking section + field.
          if (_issuesToRender.isNotEmpty) ...[
            const SizedBox(height: 10),
            _SubmitChecklistBlock(
              issues: _issuesToRender,
              key: const Key('ownerSubmitChecklist'),
            ),
          ] else if (_error != null) ...[
            // Non-validation failures (network / server / etc.)
            // still surface inline so the owner knows something
            // didn't go through. validation-kind errors with no
            // parsed missing[] also fall here as a defensive
            // fallback, though in practice the submit Lambda
            // always populates the array.
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
              // Submit is disabled when local readiness flags
              // anything — clicking would just round-trip a 400.
              // Once the owner fixes every blocker the button
              // re-enables.
              onPressed: (_busy || !_readiness.isReady) ? null : _submit,
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
  const _DashboardCard({
    required this.spec,
    required this.onTap,
    this.incomplete = false,
  });
  final _DashboardCardSpec spec;
  final VoidCallback onTap;

  /// When true, the card surfaces a "Missing info" chip next to
  /// the label so the owner can spot the section that's blocking
  /// submit-for-review without expanding the banner checklist.
  /// Today only the Profile card sets this; see the dashboard
  /// build comment.
  final bool incomplete;

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
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            spec.label,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                        if (incomplete) ...[
                          const SizedBox(width: 8),
                          _MissingInfoChip(
                            key: const Key('ownerCardMissingChip'),
                          ),
                        ],
                      ],
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

/// Small warning chip the dashboard renders next to a section
/// label when that section's fields are blocking submit-for-
/// review. Pairs with `_SubmitChecklistBlock` below — chip
/// surfaces the section identity, checklist enumerates the
/// specific fields.
class _MissingInfoChip extends StatelessWidget {
  // ignore: unused_element_parameter
  const _MissingInfoChip({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: colors.errorContainer,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        'Missing info',
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: colors.onErrorContainer,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.3,
            ),
      ),
    );
  }
}

/// Structured "Complete these before submitting" checklist
/// rendered inside `_SubmittableBanner` when local readiness or
/// the backend's `details.missing[]` array flags blockers.
/// Groups issues by section so the owner sees the same shape
/// regardless of where the gap was caught (local pre-flight or
/// server defense).
class _SubmitChecklistBlock extends StatelessWidget {
  // ignore: unused_element_parameter
  const _SubmitChecklistBlock({required this.issues, super.key});

  final List<SubmitReadinessIssue> issues;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;

    // Group by section, preserve first-seen order so the
    // Profile section always sits at the top of the checklist.
    final grouped = <String, List<SubmitReadinessIssue>>{};
    for (final issue in issues) {
      grouped.putIfAbsent(issue.section, () => <SubmitReadinessIssue>[])
          .add(issue);
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.errorContainer,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: colors.error.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Complete these before submitting',
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: colors.onErrorContainer,
                  fontWeight: FontWeight.w600,
                ),
          ),
          const SizedBox(height: 6),
          for (final entry in grouped.entries) ...[
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                entry.key,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: colors.onErrorContainer,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.2,
                    ),
              ),
            ),
            for (final issue in entry.value)
              Padding(
                padding: const EdgeInsets.only(left: 4, top: 2),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Icon(
                        Icons.radio_button_unchecked,
                        size: 14,
                        color: colors.onErrorContainer,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        issue.fieldLabel,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: colors.onErrorContainer,
                            ),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }
}
