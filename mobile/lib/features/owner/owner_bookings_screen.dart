// EthioLink Mobile — owner bookings inbox.
//
// Phase 9 Track 3.5 sixth commit. Replaces the dashboard
// Bookings card's SnackBar placeholder with the real owner-side
// appointments inbox.
//
// Two screens live here:
//
//   * `OwnerBookingsScreen` — list with a Requested / Accepted /
//     All filter at the top. Loading / success / empty / error
//     sub-states. Tap a row → pushes the detail screen.
//
//   * `OwnerAppointmentDetailScreen` — read-only row of fields +
//     status-keyed action buttons:
//       - REQUESTED → Accept + Reject
//       - ACCEPTED  → Cancel + Complete (business cancel bypasses
//         the customer-side cutoff; the API derives the actor)
//       - REJECTED / CANCELLED / COMPLETED / NO_SHOW → read-only
//     Reject + Cancel open a dialog with an optional reason
//     TextField. Confirmation issues the POST, pops back with the
//     updated `Appointment`, and the list refreshes.
//
// 409 CONFLICT renders an inline banner: the API surfaces it for
// invalid transitions (e.g. accepting an already-ACCEPTED row).
// The detail screen uses action-specific copy keyed off
// `OwnerBookingsFailure.action`.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../booking/models/appointment.dart';
import 'data/owner_bookings_repository.dart';

// ---------------------------------------------------------------------------
// List screen
// ---------------------------------------------------------------------------

class OwnerBookingsScreen extends StatefulWidget {
  const OwnerBookingsScreen({
    required this.businessId,
    this.repositoryOverride,
    super.key,
  });

  final String businessId;

  /// Test seam — production constructs `HttpOwnerBookingsRepository`
  /// from the `AppConfigScope` `AppConfig`.
  final OwnerBookingsRepository? repositoryOverride;

  @override
  State<OwnerBookingsScreen> createState() => _OwnerBookingsScreenState();
}

class _OwnerBookingsScreenState extends State<OwnerBookingsScreen> {
  OwnerBookingsRepository? _repo;

  /// `null` → "All". Otherwise one of the `AppointmentStatus`
  /// values. The MVP filter chips are limited to Requested /
  /// Accepted / All — the long tail (Rejected / Cancelled /
  /// Completed) is reachable via "All" + the status badges.
  String? _filter;

  Future<List<Appointment>>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.repositoryOverride ??
        HttpOwnerBookingsRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _refresh();
  }

  void _refresh() {
    setState(() {
      _future = _repo!.listAppointments(
        businessId: widget.businessId,
        status: _filter,
      );
    });
  }

  void _setFilter(String? status) {
    setState(() {
      _filter = status;
    });
    _refresh();
  }

  Future<void> _openDetail(Appointment a) async {
    final updated = await Navigator.of(context).push<Appointment?>(
      MaterialPageRoute<Appointment?>(
        builder: (_) => OwnerAppointmentDetailScreen(
          appointment: a,
          repository: _repo!,
        ),
      ),
    );
    if (updated != null && mounted) _refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Bookings')),
      body: Column(
        children: [
          _FilterBar(value: _filter, onChanged: _setFilter),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                _refresh();
                try {
                  await _future;
                } catch (_) {/* surfaced in FutureBuilder */}
              },
              child: FutureBuilder<List<Appointment>>(
                future: _future,
                builder: (context, snap) {
                  if (snap.connectionState == ConnectionState.waiting) {
                    return const _Loading();
                  }
                  if (snap.hasError) {
                    return _ErrorBranch(
                      error: snap.error!,
                      onRetry: _refresh,
                    );
                  }
                  final list = snap.data ?? const <Appointment>[];
                  if (list.isEmpty) return _EmptyState(filter: _filter);
                  return ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                    itemCount: list.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (context, i) {
                      final a = list[i];
                      return _AppointmentRow(
                        appointment: a,
                        onTap: () => _openDetail(a),
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

class _FilterBar extends StatelessWidget {
  const _FilterBar({required this.value, required this.onChanged});
  final String? value;
  final void Function(String? status) onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Row(
        children: [
          _Chip(
            label: 'Requested',
            selected: value == 'REQUESTED',
            onSelected: () => onChanged('REQUESTED'),
          ),
          const SizedBox(width: 8),
          _Chip(
            label: 'Accepted',
            selected: value == 'ACCEPTED',
            onSelected: () => onChanged('ACCEPTED'),
          ),
          const SizedBox(width: 8),
          _Chip(
            label: 'All',
            selected: value == null,
            onSelected: () => onChanged(null),
          ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    required this.label,
    required this.selected,
    required this.onSelected,
  });
  final String label;
  final bool selected;
  final VoidCallback onSelected;

  @override
  Widget build(BuildContext context) {
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => onSelected(),
    );
  }
}

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
  const _EmptyState({required this.filter});
  final String? filter;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final body = filter == null
        ? 'No appointments yet. Bookings the customer makes for your '
            'business land here.'
        : 'No appointments with status $filter right now.';
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(Icons.inbox_outlined, size: 72, color: colors.primary),
        const SizedBox(height: 12),
        Text(
          'Nothing in this view',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          body,
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
    final isNetwork = error is OwnerBookingsFailure &&
        (error as OwnerBookingsFailure).kind ==
            OwnerBookingsFailureKind.network;
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
          isNetwork ? "Can't reach the server" : 'Could not load bookings',
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

class _AppointmentRow extends StatelessWidget {
  const _AppointmentRow({required this.appointment, required this.onTap});
  final Appointment appointment;
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
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      _formatStart(appointment.startsAt),
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                  _StatusBadge(status: appointment.status),
                ],
              ),
              const SizedBox(height: 6),
              _DetailLine(label: 'Customer', value: appointment.customerId),
              _DetailLine(label: 'Service', value: appointment.serviceId),
              _DetailLine(label: 'Staff', value: appointment.staffId),
              _DetailLine(
                label: 'Price',
                value: '${appointment.priceEtb.toStringAsFixed(0)} ETB',
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DetailLine extends StatelessWidget {
  const _DetailLine({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: Text(
              label,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: Theme.of(context).textTheme.bodySmall,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (bg, fg) = switch (status) {
      'REQUESTED' => (colors.tertiaryContainer, colors.onTertiaryContainer),
      'ACCEPTED' => (colors.primaryContainer, colors.onPrimaryContainer),
      'COMPLETED' => (colors.secondaryContainer, colors.onSecondaryContainer),
      'REJECTED' => (colors.errorContainer, colors.onErrorContainer),
      'CANCELLED' => (colors.surfaceContainerHigh, colors.onSurfaceVariant),
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

String _formatStart(DateTime utc) {
  final local = utc.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} '
      '${two(local.hour)}:${two(local.minute)}';
}

// ---------------------------------------------------------------------------
// Detail screen — actions live here
// ---------------------------------------------------------------------------

class OwnerAppointmentDetailScreen extends StatefulWidget {
  const OwnerAppointmentDetailScreen({
    required this.appointment,
    required this.repository,
    super.key,
  });

  final Appointment appointment;
  final OwnerBookingsRepository repository;

  @override
  State<OwnerAppointmentDetailScreen> createState() =>
      _OwnerAppointmentDetailScreenState();
}

class _OwnerAppointmentDetailScreenState
    extends State<OwnerAppointmentDetailScreen> {
  late Appointment _appt;
  bool _busy = false;
  OwnerBookingsFailure? _error;

  @override
  void initState() {
    super.initState();
    _appt = widget.appointment;
  }

  bool get _isRequested => _appt.status == 'REQUESTED';
  bool get _isAccepted => _appt.status == 'ACCEPTED';

  Future<void> _runAction(
    Future<Appointment> Function() call, {
    String? successLabel,
  }) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final next = await call();
      if (!mounted) return;
      setState(() => _appt = next);
      if (successLabel != null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(successLabel),
            duration: const Duration(seconds: 2),
          ),
        );
      }
    } on OwnerBookingsFailure catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String?> _promptReason({required String title}) {
    // Delegate to a `StatefulWidget` so the `TextEditingController`
    // lifecycle is tied to the dialog widget's mount/unmount cycle,
    // not to the outer `await showDialog(...)` future. The previous
    // form disposed the controller after `showDialog` returned, but
    // Flutter still needed the controller during the dialog route's
    // pop animation — assertions in framework code surfaced as
    // "TextEditingController used after dispose" in widget tests.
    return showDialog<String?>(
      context: context,
      builder: (ctx) => _RejectReasonDialog(title: title),
    );
  }

  Future<void> _accept() => _runAction(
        () => widget.repository.acceptAppointment(_appt.id),
        successLabel: 'Appointment accepted.',
      );

  Future<void> _complete() => _runAction(
        () => widget.repository.completeAppointment(_appt.id),
        successLabel: 'Appointment marked complete.',
      );

  Future<void> _reject() async {
    final reason = await _promptReason(title: 'Reject this appointment?');
    if (reason == null) return;
    await _runAction(
      () => widget.repository.rejectAppointment(
        _appt.id,
        reason: reason.isEmpty ? null : reason,
      ),
      successLabel: 'Appointment rejected.',
    );
  }

  Future<void> _cancel() async {
    final reason = await _promptReason(title: 'Cancel this appointment?');
    if (reason == null) return;
    await _runAction(
      () => widget.repository.cancelAppointment(
        _appt.id,
        reason: reason.isEmpty ? null : reason,
      ),
      successLabel: 'Appointment cancelled.',
    );
  }

  void _popWithLatest() {
    Navigator.of(context).pop<Appointment>(_appt);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Appointment'),
        leading: BackButton(onPressed: _popWithLatest),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  _formatStart(_appt.startsAt),
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
              ),
              _StatusBadge(status: _appt.status),
            ],
          ),
          const SizedBox(height: 16),
          if (_error != null) _ErrorBanner(error: _error!),
          _Field(label: 'Appointment id', value: _appt.id),
          _Field(label: 'Customer id', value: _appt.customerId),
          _Field(label: 'Service id', value: _appt.serviceId),
          _Field(label: 'Staff id', value: _appt.staffId),
          _Field(label: 'Ends at', value: _formatStart(_appt.endsAt)),
          _Field(
            label: 'Price',
            value: '${_appt.priceEtb.toStringAsFixed(0)} ETB',
          ),
          _Field(label: 'Payment', value: _appt.paymentMethod),
          if (_appt.notes != null) _Field(label: 'Notes', value: _appt.notes!),
          if (_appt.cancelReason != null)
            _Field(label: 'Cancel reason', value: _appt.cancelReason!),
          const SizedBox(height: 24),
          if (_isRequested) _requestedActions(),
          if (_isAccepted) _acceptedActions(),
          if (!_isRequested && !_isAccepted) _readOnlyHint(),
        ],
      ),
    );
  }

  Widget _requestedActions() {
    return Row(
      children: [
        Expanded(
          child: OutlinedButton.icon(
            onPressed: _busy ? null : _reject,
            icon: const Icon(Icons.close),
            label: const Text('Reject'),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: FilledButton.icon(
            onPressed: _busy ? null : _accept,
            icon: _busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.check),
            label: const Text('Accept'),
          ),
        ),
      ],
    );
  }

  Widget _acceptedActions() {
    return Row(
      children: [
        Expanded(
          child: OutlinedButton.icon(
            onPressed: _busy ? null : _cancel,
            icon: const Icon(Icons.cancel_outlined),
            label: const Text('Cancel'),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: FilledButton.icon(
            onPressed: _busy ? null : _complete,
            icon: _busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.done_all),
            label: const Text('Mark complete'),
          ),
        ),
      ],
    );
  }

  Widget _readOnlyHint() {
    return Text(
      'No further actions available from this state.',
      style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
          ),
          Text(
            value,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ],
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.error});
  final OwnerBookingsFailure error;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (title, body) = _copyFor(error);
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: colors.onErrorContainer,
                ),
          ),
          const SizedBox(height: 4),
          Text(
            body,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onErrorContainer,
                ),
          ),
        ],
      ),
    );
  }

  /// Action-keyed copy. The 409 path is intentionally specific —
  /// "invalid state transition" is a common operator confusion
  /// the messaging should clear up.
  (String, String) _copyFor(OwnerBookingsFailure e) {
    final action = e.action ?? 'action';
    switch (e.kind) {
      case OwnerBookingsFailureKind.conflict:
        return (
          'Cannot $action',
          'The appointment is no longer in a state where it can be '
              '$action${action == 'accept' || action == 'reject' ? 'ed' : 'led'}. '
              'Pull to refresh and check the latest status.',
        );
      case OwnerBookingsFailureKind.forbidden:
        return (
          'Access denied',
          'Your role may have changed. Sign out and back in, then retry.',
        );
      case OwnerBookingsFailureKind.unauthenticated:
        return ('Sign in required', 'Sign in again to continue.');
      case OwnerBookingsFailureKind.notFound:
        return ('Not found', 'This appointment no longer exists.');
      case OwnerBookingsFailureKind.validation:
        return ('Check your input', e.message);
      case OwnerBookingsFailureKind.network:
        return ("Can't reach the server", 'Check your connection and retry.');
      case OwnerBookingsFailureKind.serverError:
        return ('Something went wrong', 'Please try again in a moment.');
      case OwnerBookingsFailureKind.malformedResponse:
      case OwnerBookingsFailureKind.other:
        return ('Something went wrong', e.message);
    }
  }
}

/// Reject / cancel reason dialog.
///
/// Carved out as a `StatefulWidget` (rather than inline inside the
/// caller's async function) so the `TextEditingController` is
/// constructed in `initState` + disposed in `dispose`, both bound
/// to this widget's element lifecycle. The previous implementation
/// disposed the controller after `showDialog`'s future resolved,
/// which was racing the route's pop animation — the framework
/// asserted `TextEditingController used after dispose` in widget
/// tests.
class _RejectReasonDialog extends StatefulWidget {
  const _RejectReasonDialog({required this.title});
  final String title;
  @override
  State<_RejectReasonDialog> createState() => _RejectReasonDialogState();
}

class _RejectReasonDialogState extends State<_RejectReasonDialog> {
  late final TextEditingController _ctrl = TextEditingController();

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _ctrl,
        maxLines: 3,
        maxLength: 500,
        decoration: const InputDecoration(
          labelText: 'Reason (optional)',
          border: OutlineInputBorder(),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: const Text('Cancel'),
        ),
        FilledButton.tonal(
          onPressed: () => Navigator.of(context).pop(_ctrl.text.trim()),
          child: const Text('Confirm'),
        ),
      ],
    );
  }
}
