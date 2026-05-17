// EthioLink Mobile — appointment history (bookings tab).
//
// Phase 9 mobile commit "add mobile appointment history". Replaces
// the scaffold's empty-state with a real `GET /v1/me/appointments`
// list. The endpoint returns every customer-side booking
// ordered by `starts_at DESC, id DESC`; the screen partitions
// into Upcoming (REQUESTED / ACCEPTED with `startsAt` in the
// future) and Past (everything else).
//
// Tapping a row pushes `AppointmentDetailScreen` which surfaces
// the lifecycle actions: Cancel while REQUESTED/ACCEPTED;
// Review while COMPLETED. The screen's repository overrides
// are threaded through so widget tests stay network-free.

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_service.dart';
import '../../core/config/app_config_scope.dart';
import '../booking/data/booking_repositories.dart';
import '../booking/models/appointment.dart';
import 'appointment_detail_screen.dart';

class BookingsScreen extends StatefulWidget {
  const BookingsScreen({
    required this.session,
    this.historyRepositoryOverride,
    this.appointmentsRepositoryOverride,
    super.key,
  });

  final AuthSession session;

  /// Test seam — production builds an `HttpAppointmentHistoryRepository`
  /// over the `AppConfigScope` `AppConfig`.
  final AppointmentHistoryRepository? historyRepositoryOverride;

  /// Forwarded to `AppointmentDetailScreen`'s cancel / review
  /// actions.
  final AppointmentsRepository? appointmentsRepositoryOverride;

  @override
  State<BookingsScreen> createState() => _BookingsScreenState();
}

class _BookingsScreenState extends State<BookingsScreen> {
  AppointmentHistoryRepository? _repo;
  Future<List<Appointment>>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.historyRepositoryOverride ??
        HttpAppointmentHistoryRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _refresh();
  }

  void _refresh() {
    setState(() {
      _future = _repo!.listMine();
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.bookingsTitle)),
      body: RefreshIndicator(
        onRefresh: () async {
          _refresh();
          await _future;
        },
        child: FutureBuilder<List<Appointment>>(
          future: _future,
          builder: (context, snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const _LoadingBody();
            }
            if (snapshot.hasError) {
              return _ErrorBody(error: snapshot.error!, onRetry: _refresh);
            }
            final all = snapshot.data ?? <Appointment>[];
            if (all.isEmpty) {
              return const _EmptyBody();
            }
            final upcoming = all.where((a) => a.isUpcoming).toList();
            final past = all.where((a) => !a.isUpcoming).toList();
            return _Results(
              upcoming: upcoming,
              past: past,
              onTap: _openDetail,
            );
          },
        ),
      ),
    );
  }

  Future<void> _openDetail(Appointment a) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => AppointmentDetailScreen(
          appointment: a,
          appointmentsRepositoryOverride:
              widget.appointmentsRepositoryOverride,
        ),
      ),
    );
    // The detail screen may have cancelled the appointment;
    // refresh the list when we return so the row reflects the
    // updated status.
    _refresh();
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
  const _EmptyBody();
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(
          Icons.event_available_outlined,
          size: 80,
          color: colors.onSurfaceVariant,
        ),
        const SizedBox(height: 12),
        Text(
          'No bookings yet',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'Browse the marketplace and book your first appointment. '
          'Pull down to refresh.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
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
    final colors = Theme.of(context).colorScheme;
    final isNetwork = error is AppointmentHistoryLoadFailure &&
        (error as AppointmentHistoryLoadFailure).isNetworkError;
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

class _Results extends StatelessWidget {
  const _Results({
    required this.upcoming,
    required this.past,
    required this.onTap,
  });

  final List<Appointment> upcoming;
  final List<Appointment> past;
  final ValueChanged<Appointment> onTap;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        if (upcoming.isNotEmpty) ...[
          const _SectionHeader(label: 'Upcoming'),
          for (final a in upcoming)
            _AppointmentRow(appointment: a, onTap: onTap),
        ],
        if (past.isNotEmpty) ...[
          const _SectionHeader(label: 'Past'),
          for (final a in past) _AppointmentRow(appointment: a, onTap: onTap),
        ],
        const SizedBox(height: 16),
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.label});
  final String label;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelLarge?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              letterSpacing: 0.5,
            ),
      ),
    );
  }
}

class _AppointmentRow extends StatelessWidget {
  const _AppointmentRow({required this.appointment, required this.onTap});
  final Appointment appointment;
  final ValueChanged<Appointment> onTap;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return ListTile(
      leading: _StatusBadge(status: appointment.status),
      title: Text(humanDateTime(appointment.startsAt)),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Service: ${shortId(appointment.serviceId)}'),
          Text('Staff: ${shortId(appointment.staffId)}'),
          Text(
            '${appointment.paymentMethod} · ${appointment.priceEtb.toStringAsFixed(0)} ETB',
            style: textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => onTap(appointment),
      isThreeLine: true,
    );
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (color, icon) = switch (status) {
      'REQUESTED' => (colors.secondary, Icons.hourglass_top),
      'ACCEPTED' => (colors.primary, Icons.check_circle_outline),
      'COMPLETED' => (colors.tertiary, Icons.task_alt),
      'CANCELLED' => (colors.outline, Icons.cancel_outlined),
      'REJECTED' => (colors.error, Icons.block),
      'NO_SHOW' => (colors.error, Icons.do_not_disturb),
      _ => (colors.outline, Icons.help_outline),
    };
    return CircleAvatar(
      backgroundColor: color.withValues(alpha: 0.15),
      child: Icon(icon, color: color),
    );
  }
}

// ---------------------------------------------------------------------------
// Shared formatting helpers — exposed for the detail screen too.
// ---------------------------------------------------------------------------

String humanDateTime(DateTime d) {
  final local = d.toLocal();
  String two(int n) => n < 10 ? '0$n' : '$n';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${months[local.month - 1]} ${local.day}, ${local.year} '
      'at ${two(local.hour)}:${two(local.minute)}';
}

/// Short UUID for the list-row labels. The detail screen surfaces
/// the full id under "Reference". Full service / staff name
/// resolution requires a separate fetch the history endpoint
/// doesn't perform; deferred to a follow-up commit.
String shortId(String id) {
  if (id.length <= 8) return id;
  return id.substring(0, 8);
}
