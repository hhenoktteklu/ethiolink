// EthioLink Mobile — top-level owner role screens.
//
// The role-nav refactor splits what used to be a single
// "My Business" tab into three top-level tabs:
//
//   * Dashboard         → OwnerDashboardScreen     (status banners,
//                                                   submit checklist,
//                                                   rejection note,
//                                                   submit CTA)
//   * Business Setup    → OwnerBusinessSetupScreen (Profile / Services /
//                                                   Staff / Availability /
//                                                   Promote cards)
//   * Appointments      → OwnerAppointmentsScreen  (owner-side
//                                                   appointment queue —
//                                                   the
//                                                   GET /v1/businesses/
//                                                   {id}/appointments
//                                                   endpoint, NOT the
//                                                   customer-side
//                                                   /v1/me/appointments)
//
// All three reuse the existing OwnerTab loader + status-banner +
// dashboard-card widgets via OwnerTab's `mode` parameter (added
// in this commit). The mode parameter gates which subset of the
// dashboard surface renders:
//   - dashboardOnly → status banner + checklist (Setup cards hidden)
//   - setupOnly     → setup cards (status banner hidden)
//   - full          → the legacy combined view (kept so the existing
//                     owner_tab_test.dart suite still works)
//
// Appointments needs its own loader because it pushes through to
// the existing OwnerBookingsScreen (which lives outside OwnerTab)
// after resolving the business id. Conceptually the three tabs
// SHOULD share one /v1/me/business cache; today each tab fetches
// independently. The duplicated round-trips are acceptable for
// the role-nav cutover and a future commit can hoist a
// shared-loader provider.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/data/categories_repository.dart';
import 'data/availability_repository.dart';
import 'data/business_actions_repository.dart';
import 'data/featuring_repository.dart';
import 'data/owner_bookings_repository.dart';
import 'data/owner_business_repository.dart';
import 'data/owner_services_repository.dart';
import 'data/owner_staff_repository.dart';
import 'models/owner_business_view.dart';
import 'owner_bookings_screen.dart';
import 'owner_tab.dart' show OwnerTab, OwnerDashboardMode;

/// Owner Dashboard tab — status banner + submit-readiness
/// checklist + rejection-note + submit CTA. NO Setup cards
/// (those live in OwnerBusinessSetupScreen).
class OwnerDashboardScreen extends StatelessWidget {
  const OwnerDashboardScreen({
    this.repositoryOverride,
    this.actionsRepositoryOverride,
    this.categoriesRepositoryOverride,
    super.key,
  });

  final OwnerBusinessRepository? repositoryOverride;
  final BusinessActionsRepository? actionsRepositoryOverride;
  final CategoriesRepository? categoriesRepositoryOverride;

  @override
  Widget build(BuildContext context) {
    return OwnerTab(
      mode: OwnerDashboardMode.dashboardOnly,
      repositoryOverride: repositoryOverride,
      actionsRepositoryOverride: actionsRepositoryOverride,
      categoriesRepositoryOverride: categoriesRepositoryOverride,
    );
  }
}

/// Owner Business Setup tab — Profile / Services / Staff /
/// Availability / Promote cards. NO status banner / submit CTA
/// (those live in OwnerDashboardScreen). The Bookings card from
/// the legacy combined view is also omitted here because
/// OwnerAppointmentsScreen is a top-level tab now.
class OwnerBusinessSetupScreen extends StatelessWidget {
  const OwnerBusinessSetupScreen({
    this.repositoryOverride,
    this.actionsRepositoryOverride,
    this.categoriesRepositoryOverride,
    this.servicesRepositoryOverride,
    this.staffRepositoryOverride,
    this.availabilityRepositoryOverride,
    this.featuringRepositoryOverride,
    super.key,
  });

  final OwnerBusinessRepository? repositoryOverride;
  final BusinessActionsRepository? actionsRepositoryOverride;
  final CategoriesRepository? categoriesRepositoryOverride;
  final OwnerServicesRepository? servicesRepositoryOverride;
  final OwnerStaffRepository? staffRepositoryOverride;
  final AvailabilityRepository? availabilityRepositoryOverride;
  final FeaturingRepository? featuringRepositoryOverride;

  @override
  Widget build(BuildContext context) {
    return OwnerTab(
      mode: OwnerDashboardMode.setupOnly,
      repositoryOverride: repositoryOverride,
      actionsRepositoryOverride: actionsRepositoryOverride,
      categoriesRepositoryOverride: categoriesRepositoryOverride,
      servicesRepositoryOverride: servicesRepositoryOverride,
      staffRepositoryOverride: staffRepositoryOverride,
      availabilityRepositoryOverride: availabilityRepositoryOverride,
      featuringRepositoryOverride: featuringRepositoryOverride,
    );
  }
}

/// Owner Appointments tab — loads the owner's business and
/// renders the existing OwnerBookingsScreen for its
/// `businessId`. Surfaces a "Create your business first" CTA
/// when no business is owned, mirroring the dashboard's 404
/// branch. Reads from
/// `GET /v1/businesses/{businessId}/appointments` — the
/// owner-side endpoint, NOT the customer `/v1/me/appointments`.
class OwnerAppointmentsScreen extends StatefulWidget {
  const OwnerAppointmentsScreen({
    this.repositoryOverride,
    this.bookingsRepositoryOverride,
    super.key,
  });

  final OwnerBusinessRepository? repositoryOverride;
  final OwnerBookingsRepository? bookingsRepositoryOverride;

  @override
  State<OwnerAppointmentsScreen> createState() =>
      _OwnerAppointmentsScreenState();
}

class _OwnerAppointmentsScreenState extends State<OwnerAppointmentsScreen> {
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
    setState(() => _future = _repo!.getMine());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Appointments')),
      body: FutureBuilder<OwnerBusinessView>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return _ErrorBody(
              error: snapshot.error!,
              onRetry: _refresh,
            );
          }
          final business = snapshot.data!;
          // OwnerBookingsScreen already renders its own Scaffold
          // + appbar; we strip ours by wrapping in a Builder that
          // returns the screen body. Cleanest hack: just embed
          // the screen as the body. The inner screen's appbar
          // overrides ours (Flutter stacks them; in practice the
          // inner appbar is what shows because OwnerBookingsScreen
          // is itself a Scaffold). We accept the dual-appbar quirk
          // for now; a follow-up can extract a non-Scaffold body
          // widget from OwnerBookingsScreen.
          return OwnerBookingsScreen(
            businessId: business.id,
            repositoryOverride: widget.bookingsRepositoryOverride,
          );
        },
      ),
    );
  }
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final msg = error.toString();
    // Detect the no-business-yet branch via the canonical 404
    // message from `me.business.ts`. If we hit it on the
    // Appointments tab we can't list anything; nudge the owner
    // back to the Dashboard / Setup tabs first.
    final isNoBusiness = msg.contains('No business profile yet');
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            isNoBusiness ? Icons.storefront_outlined : Icons.error_outline,
            size: 56,
            color: isNoBusiness ? colors.primary : colors.error,
          ),
          const SizedBox(height: 12),
          Text(
            isNoBusiness
                ? 'Create your business first'
                : 'Something went wrong',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 4),
          Text(
            isNoBusiness
                ? 'Open the Setup tab to create your business profile, then '
                    'come back here to manage appointments.'
                : msg,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
          ),
          if (!isNoBusiness) ...[
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onRetry,
              icon: const Icon(Icons.refresh),
              label: const Text('Try again'),
            ),
          ],
        ],
      ),
    );
  }
}
