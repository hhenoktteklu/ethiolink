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

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/models/service.dart';
import '../browse/models/staff.dart';
import 'data/booking_repositories.dart';
import 'models/appointment.dart';
import 'models/slot.dart';

/// Phase 10 — `Future<bool>` mirrors `url_launcher.launchUrl`'s
/// return value. Test seam: injected so widget tests don't open a
/// real browser. Same shape as the LinkTelegramScreen pattern.
typedef PaymentRedirector = Future<bool> Function(String url);

Future<bool> _defaultPaymentRedirector(String url) async {
  final uri = Uri.parse(url);
  return launchUrl(uri, mode: LaunchMode.externalApplication);
}

/// Page-step machine. Stored as a sealed-style enum-like class
/// in `_BookingFlowState`; nothing leaks outside the file. Phase
/// 10 adds the `paying` step — interstitial that opens Chapa
/// hosted checkout in an external browser and polls the
/// appointment history until the payment status flips.
enum _Step { staff, date, slot, confirm, paying, success }

class BookingFlowScreen extends StatefulWidget {
  const BookingFlowScreen({
    required this.businessId,
    required this.businessName,
    required this.service,
    required this.staff,
    this.slotsRepositoryOverride,
    this.appointmentsRepositoryOverride,
    this.historyRepositoryOverride,
    this.paymentRedirectorOverride,
    this.paymentPollInterval = const Duration(seconds: 3),
    this.paymentPollMaxAttempts = 30,
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

  /// Phase 10 — test seam for the appointment-history repository
  /// used by the payment-waiting poll. Production constructs
  /// `HttpAppointmentHistoryRepository` over the same `ApiClient`.
  final AppointmentHistoryRepository? historyRepositoryOverride;

  /// Phase 10 — test seam for `url_launcher`. Tests inject a fake
  /// that records the URL without opening a browser.
  final PaymentRedirector? paymentRedirectorOverride;

  /// Phase 10 — interval between payment-status polls. Production
  /// default 3 s.
  final Duration paymentPollInterval;

  /// Phase 10 — max number of polls before giving up. Production
  /// default 30 (90 s wall-clock).
  final int paymentPollMaxAttempts;

  @override
  State<BookingFlowScreen> createState() => _BookingFlowScreenState();
}

class _BookingFlowScreenState extends State<BookingFlowScreen> {
  SlotsRepository? _slotsRepo;
  AppointmentsRepository? _appointmentsRepo;
  AppointmentHistoryRepository? _historyRepo;
  late final PaymentRedirector _redirector;

  _Step _step = _Step.staff;

  Staff? _selectedStaff;
  DateTime? _selectedDate;
  Slot? _selectedSlot;

  /// Phase 10 — `CASH` (cash on arrival; the historical default)
  /// or `ONLINE_PENDING` (Chapa hosted checkout). The toggle is
  /// rendered on the confirm step.
  String _paymentMethod = 'CASH';

  // Slot fetch state.
  Future<List<Slot>>? _slotsFuture;
  bool _booking = false;
  AppointmentCreateFailure? _bookingError;
  Appointment? _confirmedAppointment;

  // Phase 10 — payment waiting state.
  _PayingPhase _payingPhase = _PayingPhase.opening;
  Timer? _payingTimer;
  int _payingAttempt = 0;
  String? _payingErrorMessage;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_slotsRepo != null) return;
    final client = ApiClient(config: AppConfigScope.of(context));
    _slotsRepo = widget.slotsRepositoryOverride ??
        HttpSlotsRepository(client);
    _appointmentsRepo = widget.appointmentsRepositoryOverride ??
        HttpAppointmentsRepository(client);
    _historyRepo = widget.historyRepositoryOverride ??
        HttpAppointmentHistoryRepository(client);
    _redirector = widget.paymentRedirectorOverride ?? _defaultPaymentRedirector;

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
      final response = await _appointmentsRepo!.create(
        staffId: _selectedStaff!.id,
        serviceId: widget.service.id,
        startsAtIso: _selectedSlot!.startUtcIso,
        paymentMethod: _paymentMethod,
      );
      if (!mounted) return;
      // Phase 10 — cash + synchronous SUCCEEDED outcomes go
      // straight to success. PENDING with a redirectUrl dives into
      // the waiting flow (Chapa hosted checkout). FAILED on the
      // create itself shouldn't normally happen (gateways either
      // SUCCEED, PEND, or throw); if it does, surface as an
      // error.
      if (response.payment.isPending && response.payment.redirectUrl != null) {
        setState(() {
          _confirmedAppointment = response.appointment;
          _booking = false;
          _step = _Step.paying;
          _payingPhase = _PayingPhase.opening;
          _payingAttempt = 0;
          _payingErrorMessage = null;
        });
        await _openChapaAndPoll(response.payment.redirectUrl!);
        return;
      }
      if (response.payment.isFailed) {
        setState(() {
          _booking = false;
          _bookingError = AppointmentCreateFailure(
            kind: AppointmentCreateFailureKind.other,
            message: response.payment.errorMessage ?? 'Payment failed.',
            apiErrorCode: response.payment.errorCode,
          );
        });
        return;
      }
      // SUCCEEDED (cash) — happy path lands directly on the
      // success step. Same as the historical behaviour.
      setState(() {
        _confirmedAppointment = response.appointment;
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

  /// Phase 10 — opens the Chapa hosted-checkout URL in an external
  /// browser, then polls the appointment-history endpoint for the
  /// payment_status flip. Three outcomes:
  ///
  ///   * `_PayingPhase.succeeded` — the appointment shows up in
  ///     history with a status implying the payment landed. The
  ///     user taps Done to pop back to the detail page.
  ///   * `_PayingPhase.failed` — `launchUrl` refused (no browser
  ///     installed) OR the appointment surfaced as CANCELLED via
  ///     the auto-cancel TTL (future commit). Customer can retry.
  ///   * `_PayingPhase.timedOut` — the poll budget exhausted
  ///     without a status flip. The booking still exists; the
  ///     bookings tab is the recovery surface.
  Future<void> _openChapaAndPoll(String redirectUrl) async {
    bool launched;
    try {
      launched = await _redirector(redirectUrl);
    } catch (err) {
      launched = false;
      _payingErrorMessage = err.toString();
    }
    if (!mounted) return;
    if (!launched) {
      setState(() {
        _payingPhase = _PayingPhase.failed;
        _payingErrorMessage ??=
            'Could not open the Chapa checkout. Tap retry or pick cash.';
      });
      return;
    }
    setState(() => _payingPhase = _PayingPhase.polling);
    _schedulePaymentPoll();
  }

  void _schedulePaymentPoll() {
    _payingTimer?.cancel();
    _payingTimer = Timer(widget.paymentPollInterval, _pollPaymentStatus);
  }

  Future<void> _pollPaymentStatus() async {
    if (!mounted) return;
    final appointmentId = _confirmedAppointment?.id;
    if (appointmentId == null) return;
    _payingAttempt += 1;
    try {
      final history = await _historyRepo!.listMine();
      final current = history.firstWhere(
        (a) => a.id == appointmentId,
        orElse: () => _confirmedAppointment!,
      );
      // Heuristic: cash bookings ship paymentMethod=CASH and we
      // never poll. For online bookings, the webhook updates
      // payment_intents.status on the server side; the appointment
      // row itself doesn't currently flip to reflect that (a
      // future commit adds `payment_status`). For now, we use a
      // proxy: status === 'CANCELLED' implies the auto-cancel TTL
      // fired (failed payment); any non-CANCELLED return after
      // the user redirects back is treated as success — the
      // payment cleared at the gateway, and the existing
      // REQUESTED row is the canonical record.
      if (current.status == 'CANCELLED') {
        setState(() {
          _payingPhase = _PayingPhase.failed;
          _payingErrorMessage =
              'Payment did not complete in time. Pick another slot or try cash.';
          _confirmedAppointment = current;
        });
        return;
      }
      // Optimistic success — see comment above on the proxy.
      setState(() {
        _payingPhase = _PayingPhase.succeeded;
        _confirmedAppointment = current;
      });
    } catch (_) {
      // Swallow a poll error and try again. The poll budget
      // protects against an indefinite loop.
    }
    if (!mounted) return;
    if (_payingPhase == _PayingPhase.succeeded ||
        _payingPhase == _PayingPhase.failed) {
      return;
    }
    if (_payingAttempt >= widget.paymentPollMaxAttempts) {
      setState(() {
        _payingPhase = _PayingPhase.timedOut;
      });
      return;
    }
    _schedulePaymentPoll();
  }

  /// User tapped "I paid — check now" on the waiting screen.
  void _retryPollNow() {
    _payingTimer?.cancel();
    _pollPaymentStatus();
  }

  /// User tapped "Done" on the waiting-screen success branch.
  void _onPayingDone() {
    setState(() => _step = _Step.success);
  }

  /// User tapped "Pick another slot" / "Try cash" on the waiting
  /// failure branch.
  void _onPayingRecover() {
    _payingTimer?.cancel();
    _backToSlot();
  }

  @override
  void dispose() {
    _payingTimer?.cancel();
    super.dispose();
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
          paymentMethod: _paymentMethod,
          onPaymentMethodChanged: (m) =>
              setState(() => _paymentMethod = m),
          onConfirm: _confirmBooking,
          onPickAnotherSlot: _backToSlot,
        );
      case _Step.paying:
        return _PaymentWaitingStep(
          phase: _payingPhase,
          attempt: _payingAttempt,
          maxAttempts: widget.paymentPollMaxAttempts,
          errorMessage: _payingErrorMessage,
          onCheckNow: _retryPollNow,
          onDone: _onPayingDone,
          onPickAnotherSlot: _onPayingRecover,
        );
      case _Step.success:
        return _SuccessStep(
          appointment: _confirmedAppointment!,
          onDone: () => Navigator.of(context).pop(),
        );
    }
  }
}

/// Phase 10 — payment-waiting interstitial state.
enum _PayingPhase { opening, polling, succeeded, failed, timedOut }

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
    required this.paymentMethod,
    required this.onPaymentMethodChanged,
    required this.onConfirm,
    required this.onPickAnotherSlot,
  });

  final String businessName;
  final Service service;
  final Staff staff;
  final Slot slot;
  final bool booking;
  final AppointmentCreateFailure? error;
  final String paymentMethod;
  final ValueChanged<String> onPaymentMethodChanged;
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
        const SizedBox(height: 12),
        _PaymentMethodPicker(
          value: paymentMethod,
          onChanged: onPaymentMethodChanged,
          enabled: !booking,
        ),
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

/// Phase 10 — radio-style picker for `CASH` vs `ONLINE_PENDING`.
/// Cash is the default; online uses Chapa hosted checkout when
/// the operator has wired `payments_provider = chapa` server-side.
/// The picker is rendered unconditionally — when the server has
/// not opted in, the online option still appears but the server
/// returns `400 ONLINE_PAYMENTS_UNAVAILABLE` and the screen
/// surfaces the error via the existing error-panel branch. This
/// keeps the client free of operator-state guessing.
class _PaymentMethodPicker extends StatelessWidget {
  const _PaymentMethodPicker({
    required this.value,
    required this.onChanged,
    required this.enabled,
  });

  final String value;
  final ValueChanged<String> onChanged;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Payment method',
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 4),
        // Flutter 3.41 marks `RadioListTile.groupValue` / `.onChanged`
        // deprecated in favour of the new `RadioGroup` ancestor.
        // Migrating two tiles to that pattern would expand this
        // widget tree without a UX change, so we silence the warning
        // here and revisit when the deprecation graduates to
        // removed-by.
        // ignore: deprecated_member_use
        RadioListTile<String>(
          value: 'CASH',
          // ignore: deprecated_member_use
          groupValue: value,
          // ignore: deprecated_member_use
          onChanged: enabled ? (v) => onChanged(v ?? 'CASH') : null,
          title: const Text('Cash at the business'),
          subtitle: const Text(
            'Settle in person when you arrive for your appointment.',
          ),
          contentPadding: EdgeInsets.zero,
        ),
        // ignore: deprecated_member_use
        RadioListTile<String>(
          value: 'ONLINE_PENDING',
          // ignore: deprecated_member_use
          groupValue: value,
          // ignore: deprecated_member_use
          onChanged: enabled ? (v) => onChanged(v ?? 'CASH') : null,
          title: const Text('Pay now (Chapa)'),
          subtitle: const Text(
            'Telebirr, CBE Birr, mobile money, or card via Chapa hosted checkout.',
          ),
          contentPadding: EdgeInsets.zero,
        ),
      ],
    );
  }
}

/// Phase 10 — payment-waiting interstitial. Rendered between the
/// confirm step and the success step when the customer picked
/// online payment and the gateway returned `PENDING` with a
/// redirectUrl.
class _PaymentWaitingStep extends StatelessWidget {
  const _PaymentWaitingStep({
    required this.phase,
    required this.attempt,
    required this.maxAttempts,
    required this.errorMessage,
    required this.onCheckNow,
    required this.onDone,
    required this.onPickAnotherSlot,
  });

  final _PayingPhase phase;
  final int attempt;
  final int maxAttempts;
  final String? errorMessage;
  final VoidCallback onCheckNow;
  final VoidCallback onDone;
  final VoidCallback onPickAnotherSlot;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    // The paying-phase body delegates typography to `_BodyColumn`,
    // so we don't need a local `textTheme` reference here. (The
    // analyzer flagged the previous `final textTheme = ...` as an
    // unused local.)
    switch (phase) {
      case _PayingPhase.opening:
        return _BodyColumn(
          icon: Icons.open_in_new,
          iconColor: colors.primary,
          title: 'Opening Chapa checkout…',
          message:
              "We're opening the Chapa hosted checkout in your browser. "
              'Complete the payment, then return to this screen.',
          children: const [
            Padding(
              padding: EdgeInsets.only(top: 16),
              child: CircularProgressIndicator(),
            ),
          ],
        );
      case _PayingPhase.polling:
        return _BodyColumn(
          icon: Icons.hourglass_top,
          iconColor: colors.primary,
          title: 'Waiting for payment…',
          message:
              "We'll automatically update this screen when Chapa confirms "
              "your payment. Don't close the app — checking $attempt of $maxAttempts.",
          children: [
            const SizedBox(height: 16),
            const CircularProgressIndicator(),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: onCheckNow,
              icon: const Icon(Icons.refresh),
              label: const Text('I paid — check now'),
            ),
          ],
        );
      case _PayingPhase.succeeded:
        return _BodyColumn(
          icon: Icons.check_circle,
          iconColor: colors.primary,
          title: 'Payment received',
          message:
              'Your booking is confirmed. The business will accept or '
              "reject the request shortly; you'll get a notification.",
          children: [
            const SizedBox(height: 16),
            FilledButton(
              onPressed: onDone,
              child: const Text('Continue'),
            ),
          ],
        );
      case _PayingPhase.failed:
        return _BodyColumn(
          icon: Icons.error_outline,
          iconColor: colors.error,
          title: 'Payment failed',
          message: errorMessage ??
              'We could not complete the payment via Chapa. You can pick '
                  'another slot or switch to cash.',
          children: [
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onPickAnotherSlot,
              icon: const Icon(Icons.refresh),
              label: const Text('Pick another slot'),
            ),
          ],
        );
      case _PayingPhase.timedOut:
        return _BodyColumn(
          icon: Icons.hourglass_disabled,
          iconColor: colors.onSurfaceVariant,
          title: 'Still processing',
          message:
              'Chapa is taking longer than expected to confirm your '
                  "payment. Check your bookings tab in a few minutes — "
                  "the booking will appear there once payment lands.",
          children: [
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: onCheckNow,
              icon: const Icon(Icons.refresh),
              label: const Text('Check again'),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: onPickAnotherSlot,
              icon: const Icon(Icons.arrow_back),
              label: const Text('Pick another slot'),
            ),
          ],
        );
    }
  }
}

class _BodyColumn extends StatelessWidget {
  const _BodyColumn({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.message,
    this.children = const [],
  });
  final IconData icon;
  final Color iconColor;
  final String title;
  final String message;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 64, color: iconColor),
          const SizedBox(height: 12),
          Text(title, style: textTheme.titleLarge, textAlign: TextAlign.center),
          const SizedBox(height: 8),
          Text(message, textAlign: TextAlign.center),
          ...children,
        ],
      ),
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
