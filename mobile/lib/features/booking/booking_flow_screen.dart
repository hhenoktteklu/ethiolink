// EthioLink Mobile — booking flow screen.
//
// The booking funnel's anchor. Tapping "Book" on a service row
// in `BusinessDetailScreen` pushes this screen with the
// pre-fetched service + staff list + business name. The screen
// walks the user through:
//
//   1. Staff   — skipped automatically when only one active
//                staff member services the business.
//   2. Date    — horizontal list of 14 days (today through +13)
//                in `Africa/Addis_Ababa` local time. The
//                date-only string is forwarded to the slots
//                endpoint as both `from` and `to` (one-day
//                window).
//   3. Slot    — `GET /businesses/{id}/staff/{sid}/slots`
//                renders the resulting bookable instants as
//                tappable chips.
//   4. Confirm — recap (service / staff / date+time / price /
//                CASH-only payment method) + Book button.
//   5. Success — appointment id, "Booking requested!" copy,
//                and a Done button that pops back to detail.
//
// Error handling at the confirm step:
//   * 409 SLOT_UNAVAILABLE → clear "Slot just got taken. Pick
//     another." copy with a tap-back to the slot step. The slot
//     list is auto-refreshed when we land back.
//   * 401 UNAUTHENTICATED → "Sign in required" copy + button to
//     close the flow.
//   * Network / 5xx → generic error with retry on the same
//     confirm step.

import 'package:flutter/material.dart';
import 'package:flutter_gen/gen_l10n/app_localizations.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/models/service.dart';
import '../browse/models/staff.dart';
import 'data/booking_repositories.dart';
import 'models/appointment.dart';
import 'models/slot.dart';

/// Page-step machine. Stored as a sealed-style enum-like class
/// in `_BookingFlowState`; nothing leaks outside the file.
enum _Step { staff, date, slot, confirm, success }

class BookingFlowScreen extends StatefulWidget {
  const BookingFlowScreen({
    required this.businessId,
    required this.businessName,
    required this.service,
    required this.staff,
    this.slotsRepositoryOverride,
    this.appointmentsRepositoryOverride,
    super.key,
  });

  final String businessId;
  final String businessName;
  final Service service;
  final List<Staff> staff;

  /// Test seam. Production constructs `Http*` over the
  /// `AppConfigScope` `AppConfig`.
  final SlotsRepository? slotsRepositoryOverride;
  final AppointmentsRepository? appointmentsRepositoryOverride;

  @override
  State<BookingFlowScreen> createState() => _BookingFlowScreenState();
}

class _BookingFlowScreenState extends State<BookingFlowScreen> {
  SlotsRepository? _slotsRepo;
  AppointmentsRepository? _appointmentsRepo;

  _Step _step = _Step.staff;

  Staff? _selectedStaff;
  DateTime? _selectedDate;
  Slot? _selectedSlot;

  // Slot fetch state.
  Future<List<Slot>>? _slotsFuture;
  bool _booking = false;
  AppointmentCreateFailure? _bookingError;
  Appointment? _confirmedAppointment;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_slotsRepo != null) return;
    final client = ApiClient(config: AppConfigScope.of(context));
    _slotsRepo = widget.slotsRepositoryOverride ??
        HttpSlotsRepository(client);
    _appointmentsRepo = widget.appointmentsRepositoryOverride ??
        HttpAppointmentsRepository(client);

    // Auto-advance past the staff step when there's only one
    // option. The business detail screen's staff section already
    // shows the roster; jumping straight to date is the right
    // UX.
    final active = widget.staff.where((s) => s.isActive).toList();
    if (active.length == 1) {
      _selectedStaff = active.first;
      _step = _Step.date;
    } else if (active.isEmpty) {
      // Defensive — the business detail flow shouldn't surface
      // the Book button when there are zero active staff. If it
      // does, we still render the staff step with an empty-state.
      _step = _Step.staff;
    }
  }

  // ---- Step transitions -------------------------------------------------

  void _onStaffChosen(Staff staff) {
    setState(() {
      _selectedStaff = staff;
      _step = _Step.date;
    });
  }

  void _onDateChosen(DateTime date) {
    setState(() {
      _selectedDate = date;
      _step = _Step.slot;
      _slotsFuture = _fetchSlots();
    });
  }

  void _onSlotChosen(Slot slot) {
    setState(() {
      _selectedSlot = slot;
      _step = _Step.confirm;
    });
  }

  void _backToSlot() {
    setState(() {
      _selectedSlot = null;
      _bookingError = null;
      _step = _Step.slot;
      _slotsFuture = _fetchSlots();
    });
  }

  Future<List<Slot>> _fetchSlots() async {
    final staff = _selectedStaff!;
    final date = _selectedDate!;
    final iso = _dateOnly(date);
    return _slotsRepo!.list(
      businessId: widget.businessId,
      staffId: staff.id,
      serviceId: widget.service.id,
      fromDate: iso,
      toDate: iso,
    );
  }

  Future<void> _confirmBooking() async {
    setState(() {
      _booking = true;
      _bookingError = null;
    });
    try {
      final appointment = await _appointmentsRepo!.create(
        staffId: _selectedStaff!.id,
        serviceId: widget.service.id,
        startsAtIso: _selectedSlot!.startUtcIso,
        paymentMethod: 'CASH',
      );
      if (!mounted) return;
      setState(() {
        _confirmedAppointment = appointment;
        _booking = false;
        _step = _Step.success;
      });
    } on AppointmentCreateFailure catch (e) {
      if (!mounted) return;
      setState(() {
        _bookingError = e;
        _booking = false;
      });
    }
  }

  // ---- Build ------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Book ${widget.service.nameEn}'),
      ),
      body: _stepBody(),
    );
  }

  Widget _stepBody() {
    switch (_step) {
      case _Step.staff:
        return _StaffStep(
          staff: widget.staff.where((s) => s.isActive).toList(),
          onChosen: _onStaffChosen,
        );
      case _Step.date:
        return _DateStep(onChosen: _onDateChosen);
      case _Step.slot:
        return _SlotStep(
          staff: _selectedStaff!,
          date: _selectedDate!,
          future: _slotsFuture!,
          onChosen: _onSlotChosen,
          onRetry: () => setState(() {
            _slotsFuture = _fetchSlots();
          }),
        );
      case _Step.confirm:
        return _ConfirmStep(
          businessName: widget.businessName,
          service: widget.service,
          staff: _selectedStaff!,
          slot: _selectedSlot!,
          booking: _booking,
          error: _bookingError,
          onConfirm: _confirmBooking,
          onPickAnotherSlot: _backToSlot,
        );
      case _Step.success:
        return _SuccessStep(
          appointment: _confirmedAppointment!,
          onDone: () => Navigator.of(context).pop(),
        );
    }
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

class _StaffStep extends StatelessWidget {
  const _StaffStep({required this.staff, required this.onChosen});

  final List<Staff> staff;
  final ValueChanged<Staff> onChosen;

  @override
  Widget build(BuildContext context) {
    if (staff.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Center(
          child: Text(
            'No active staff members. Please pick a different '
            'service or check back later.',
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    return ListView.separated(
      itemCount: staff.length,
      separatorBuilder: (_, __) => const Divider(height: 0),
      itemBuilder: (context, i) {
        final s = staff[i];
        return ListTile(
          leading: const Icon(Icons.person),
          title: Text(s.displayName),
          subtitle: s.role != null ? Text(s.role!) : null,
          trailing: const Icon(Icons.chevron_right),
          onTap: () => onChosen(s),
        );
      },
    );
  }
}

class _DateStep extends StatelessWidget {
  const _DateStep({required this.onChosen});
  final ValueChanged<DateTime> onChosen;

  @override
  Widget build(BuildContext context) {
    final today = DateTime.now();
    final dates = List<DateTime>.generate(
      14,
      (i) => DateTime(today.year, today.month, today.day + i),
    );
    return ListView.separated(
      itemCount: dates.length,
      separatorBuilder: (_, __) => const Divider(height: 0),
      itemBuilder: (context, i) {
        final d = dates[i];
        return ListTile(
          leading: const Icon(Icons.calendar_today),
          title: Text(_humanDate(d)),
          subtitle: Text(_dateOnly(d)),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => onChosen(d),
        );
      },
    );
  }
}

class _SlotStep extends StatelessWidget {
  const _SlotStep({
    required this.staff,
    required this.date,
    required this.future,
    required this.onChosen,
    required this.onRetry,
  });

  final Staff staff;
  final DateTime date;
  final Future<List<Slot>> future;
  final ValueChanged<Slot> onChosen;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(
              '${staff.displayName} · ${_humanDate(date)}',
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
        ),
        Expanded(
          child: FutureBuilder<List<Slot>>(
            future: future,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(child: CircularProgressIndicator());
              }
              if (snapshot.hasError) {
                final isNetwork = snapshot.error is SlotsLoadFailure &&
                    (snapshot.error as SlotsLoadFailure).isNetworkError;
                return _ErrorStateBody(
                  title: isNetwork
                      ? "Can't reach the server"
                      : 'Could not load slots',
                  message: snapshot.error!.toString(),
                  onRetry: onRetry,
                  isNetwork: isNetwork,
                );
              }
              final slots = snapshot.data!;
              if (slots.isEmpty) {
                return _EmptyStateBody(
                  title: 'No open slots',
                  message: 'Try a different day or staff member.',
                  onRetry: onRetry,
                );
              }
              return GridView.builder(
                padding: const EdgeInsets.all(16),
                gridDelegate:
                    const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 3,
                  crossAxisSpacing: 8,
                  mainAxisSpacing: 8,
                  childAspectRatio: 2.2,
                ),
                itemCount: slots.length,
                itemBuilder: (context, i) {
                  final s = slots[i];
                  return OutlinedButton(
                    onPressed: () => onChosen(s),
                    child: Text(_humanTime(s.startUtc)),
                  );
                },
              );
            },
          ),
        ),
      ],
    );
  }
}

class _ConfirmStep extends StatelessWidget {
  const _ConfirmStep({
    required this.businessName,
    required this.service,
    required this.staff,
    required this.slot,
    required this.booking,
    required this.error,
    required this.onConfirm,
    required this.onPickAnotherSlot,
  });

  final String businessName;
  final Service service;
  final Staff staff;
  final Slot slot;
  final bool booking;
  final AppointmentCreateFailure? error;
  final VoidCallback onConfirm;
  final VoidCallback onPickAnotherSlot;

  String get _priceLabel {
    final p = service.priceEtb;
    return p == null ? 'Price on request' : '${p.toStringAsFixed(0)} ETB';
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final l10n = AppLocalizations.of(context);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(l10n.bookingFlowConfirmTitle, style: textTheme.titleLarge),
        const SizedBox(height: 16),
        _Row(label: 'Business', value: businessName),
        _Row(label: 'Service', value: service.nameEn),
        _Row(label: 'Duration', value: '${service.durationMinutes} min'),
        _Row(label: 'Staff', value: staff.displayName),
        _Row(label: 'When', value: _humanDateTime(slot.startUtc)),
        _Row(label: 'Price', value: _priceLabel),
        _Row(label: 'Payment', value: 'Cash at the business'),
        const SizedBox(height: 16),
        if (error != null) _BookingErrorPanel(
          error: error!,
          onPickAnotherSlot: onPickAnotherSlot,
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: booking ? null : onConfirm,
          icon: booking
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.check),
          label: Text(
            booking
                ? l10n.bookingFlowBookingInProgress
                : l10n.bookingFlowConfirmAction,
          ),
        ),
      ],
    );
  }
}

class _SuccessStep extends StatelessWidget {
  const _SuccessStep({required this.appointment, required this.onDone});
  final Appointment appointment;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final l10n = AppLocalizations.of(context);
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.check_circle, size: 80, color: colors.primary),
          const SizedBox(height: 16),
          Text(l10n.bookingFlowSuccessTitle, style: textTheme.titleLarge),
          const SizedBox(height: 8),
          Text(
            "We've sent the request to ${_humanDateTime(appointment.startsAt)}. "
            "The business will accept or reject it shortly; you'll get an "
            "SMS when they do.",
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            'Reference: ${appointment.id}',
            style: textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: onDone,
            child: Text(l10n.bookingFlowDone),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 100,
            child: Text(
              label,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
          ),
          Expanded(
            child: Text(value, style: Theme.of(context).textTheme.bodyMedium),
          ),
        ],
      ),
    );
  }
}

class _BookingErrorPanel extends StatelessWidget {
  const _BookingErrorPanel({
    required this.error,
    required this.onPickAnotherSlot,
  });
  final AppointmentCreateFailure error;
  final VoidCallback onPickAnotherSlot;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final l10n = AppLocalizations.of(context);
    String title;
    String message;
    Widget? action;

    switch (error.kind) {
      case AppointmentCreateFailureKind.slotUnavailable:
        title = 'Slot just got taken';
        message = 'Someone else grabbed that slot first. Pick another.';
        action = FilledButton.icon(
          onPressed: onPickAnotherSlot,
          icon: const Icon(Icons.refresh),
          label: Text(l10n.bookingFlowPickAnotherSlot),
        );
        break;
      case AppointmentCreateFailureKind.unauthenticated:
        title = 'Sign in required';
        message = 'Your session expired. Sign in again to book.';
        break;
      case AppointmentCreateFailureKind.validation:
        title = 'Booking refused';
        message = error.message;
        break;
      case AppointmentCreateFailureKind.network:
        title = "Can't reach the server";
        message = 'Check your connection and try again.';
        break;
      case AppointmentCreateFailureKind.serverError:
      case AppointmentCreateFailureKind.malformedResponse:
      case AppointmentCreateFailureKind.other:
        title = 'Something went wrong';
        message = error.message;
        break;
    }

    return Container(
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
            message,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onErrorContainer,
                ),
          ),
          if (action != null) ...[
            const SizedBox(height: 12),
            action,
          ],
        ],
      ),
    );
  }
}

class _EmptyStateBody extends StatelessWidget {
  const _EmptyStateBody({
    required this.title,
    required this.message,
    required this.onRetry,
  });
  final String title;
  final String message;
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.event_busy, size: 48),
          const SizedBox(height: 8),
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        ],
      ),
    );
  }
}

class _ErrorStateBody extends StatelessWidget {
  const _ErrorStateBody({
    required this.title,
    required this.message,
    required this.onRetry,
    required this.isNetwork,
  });
  final String title;
  final String message;
  final VoidCallback onRetry;
  final bool isNetwork;
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            isNetwork ? Icons.wifi_off : Icons.error_outline,
            size: 48,
            color: colors.error,
          ),
          const SizedBox(height: 8),
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Try again'),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Date/time formatting — minimal, no `intl` package dependency
// for these single use sites.
// ---------------------------------------------------------------------------

String _dateOnly(DateTime d) {
  String two(int n) => n < 10 ? '0$n' : '$n';
  return '${d.year}-${two(d.month)}-${two(d.day)}';
}

String _humanDate(DateTime d) {
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
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return '${weekdays[d.weekday - 1]}, ${months[d.month - 1]} ${d.day}';
}

String _humanTime(DateTime d) {
  final local = d.toLocal();
  String two(int n) => n < 10 ? '0$n' : '$n';
  return '${two(local.hour)}:${two(local.minute)}';
}

String _humanDateTime(DateTime d) {
  return '${_humanDate(d.toLocal())} at ${_humanTime(d)}';
}
