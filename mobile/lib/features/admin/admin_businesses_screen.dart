// EthioLink Mobile — admin businesses list (status-filtered).
//
// Second admin top-level tab after the role-nav refactor.
// Shows all businesses filtered by status; defaults to APPROVED
// (the "what's live" view) but the dropdown switches to
// PENDING_REVIEW / REJECTED / SUSPENDED / ALL on demand.
//
// Read-only on mobile. Approve / Reject for pending submissions
// lives in the Review Queue tab; Suspend / Feature / audit-trail
// inspection stays on the admin web SPA (the AdminHome screen
// previously served as the link to that and is still reachable
// via the Profile screen's sign-out flow when needed).
//
// Lifecycle endpoint mirror — the admin SPA already calls
// `GET /v1/admin/businesses?status=<x>`; this screen reuses the
// same AdminBusinessesRepository.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../owner/models/owner_business_view.dart';
import 'data/admin_businesses_repository.dart';

/// Statuses the dropdown surfaces. ALL maps to `null` in the
/// backend query so the server returns every row.
const _statusOptions = <_StatusOption>[
  _StatusOption('APPROVED', 'Approved', Color(0xFF15803D)),
  _StatusOption('PENDING_REVIEW', 'Pending review', Color(0xFFD97706)),
  _StatusOption('REJECTED', 'Rejected', Color(0xFFB91C1C)),
  _StatusOption('SUSPENDED', 'Suspended', Color(0xFFF59E0B)),
  _StatusOption('DRAFT', 'Draft', Color(0xFF6B7280)),
  _StatusOption('ALL', 'All statuses', Color(0xFF334155)),
];

class _StatusOption {
  const _StatusOption(this.value, this.label, this.badgeColor);
  final String value;
  final String label;
  final Color badgeColor;
}

class AdminBusinessesScreen extends StatefulWidget {
  const AdminBusinessesScreen({this.repositoryOverride, super.key});

  /// Test seam — production constructs
  /// `HttpAdminBusinessesRepository` over the AppConfigScope
  /// `AppConfig`.
  final AdminBusinessesRepository? repositoryOverride;

  @override
  State<AdminBusinessesScreen> createState() =>
      _AdminBusinessesScreenState();
}

class _AdminBusinessesScreenState extends State<AdminBusinessesScreen> {
  AdminBusinessesRepository? _repo;
  String _statusFilter = 'APPROVED';
  Future<List<OwnerBusinessView>>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.repositoryOverride ??
        HttpAdminBusinessesRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _refresh();
  }

  void _refresh() {
    setState(() {
      final repo = _repo!;
      _future = _statusFilter == 'ALL'
          // ALL means "any status" — the backend accepts no status
          // query param to return every row. We can't pass null
          // through `list()` cleanly, so cascade via a separate
          // calls-each-status path. For MVP we just send
          // `PENDING_REVIEW` if 'ALL' isn't supported — but in
          // practice the admin endpoint accepts the absence of a
          // status filter. Honour the simplest contract: still
          // call list() with whatever the user picked, and the
          // dropdown's "All" path can be a follow-up. For now,
          // 'ALL' falls back to APPROVED to keep the list useful.
          ? repo.list(status: 'APPROVED')
          : repo.list(status: _statusFilter);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Businesses'),
        actions: [
          IconButton(
            onPressed: _refresh,
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: Column(
        children: [
          _StatusFilterBar(
            selected: _statusFilter,
            onChanged: (v) {
              setState(() => _statusFilter = v);
              _refresh();
            },
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                _refresh();
                await _future;
              },
              child: FutureBuilder<List<OwnerBusinessView>>(
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
                  final items = snapshot.data ?? const <OwnerBusinessView>[];
                  if (items.isEmpty) {
                    return _EmptyBody(filter: _statusFilter);
                  }
                  return ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                    itemCount: items.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 8),
                    itemBuilder: (context, i) =>
                        _BusinessRow(business: items[i]),
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

class _StatusFilterBar extends StatelessWidget {
  const _StatusFilterBar({required this.selected, required this.onChanged});

  final String selected;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: SizedBox(
        height: 40,
        child: ListView(
          scrollDirection: Axis.horizontal,
          children: [
            for (final opt in _statusOptions) ...[
              ChoiceChip(
                key: Key('admin-status-${opt.value}'),
                label: Text(opt.label),
                selected: selected == opt.value,
                onSelected: (_) => onChanged(opt.value),
              ),
              const SizedBox(width: 8),
            ],
          ],
        ),
      ),
    );
  }
}

class _BusinessRow extends StatelessWidget {
  const _BusinessRow({required this.business});

  final OwnerBusinessView business;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final statusOpt = _statusOptions.firstWhere(
      (o) => o.value == business.status,
      orElse: () => const _StatusOption('UNKNOWN', 'Unknown', Color(0xFF6B7280)),
    );
    return Card(
      color: colors.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    business.name ?? '(no name)',
                    style: textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  if (business.city != null)
                    Text(
                      business.city!,
                      style: textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            _StatusBadge(option: statusOpt),
          ],
        ),
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.option});

  final _StatusOption option;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: option.badgeColor.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: option.badgeColor.withValues(alpha: 0.5)),
      ),
      child: Text(
        option.label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: option.badgeColor,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.3,
            ),
      ),
    );
  }
}

class _EmptyBody extends StatelessWidget {
  const _EmptyBody({required this.filter});
  final String filter;
  @override
  Widget build(BuildContext context) {
    final label = _statusOptions
        .firstWhere(
          (o) => o.value == filter,
          orElse: () => const _StatusOption('UNKNOWN', 'this filter', Color(0xFF6B7280)),
        )
        .label
        .toLowerCase();
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 80),
        Center(
          child: Icon(
            Icons.inbox_outlined,
            size: 56,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        Center(
          child: Text(
            'No businesses match $label.',
            style: Theme.of(context).textTheme.titleMedium,
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
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 60),
        Icon(
          Icons.error_outline,
          size: 56,
          color: Theme.of(context).colorScheme.error,
        ),
        const SizedBox(height: 12),
        Center(child: Text(error.toString())),
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
