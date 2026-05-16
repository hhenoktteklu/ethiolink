// EthioLink Mobile — appointment detail / lifecycle actions.
//
// Pushed from `BookingsScreen` when the customer taps a row.
// Surfaces the full `AppointmentView` + two lifecycle actions
// driven by `AppointmentsRepository`:
//
//   * Cancel — visible while status is REQUESTED or ACCEPTED.
//     Renders an optional reason text field. On success, the
//     appointment object updates in place + the screen flips
//     into a confirmation state. On 409 CONFLICT, the error
//     panel renders the cutoff-specific copy.
//
//   * Review — visible while status is COMPLETED. Star-rating
//     picker + optional comment. On 409 CONFLICT (duplicate
//     review), the panel surfaces the "already reviewed" copy
//     so the customer doesn't keep retrying.
//
// The screen never refetches `GET /v1/appointments/{id}` —
// the API doesn't ship a public-customer single-read endpoint;
// the listing's `Appointment` snapshot is the source of truth.
// On any lifecycle mutation the response carries the fresh
// `Appointment` (cancel) or `Review` (review) which the screen
// uses to update state.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../booking/data/booking_repositories.dart';
import '../booking/models/appointment.dart';
import 'bookings_screen.dart' show humanDateTime, shortId;

class AppointmentDetailScreen extends StatefulWidget {
  const AppointmentDetailScreen({
    required this.appointment,
    this.appointmentsRepositoryOverride,
    super.key,
  });

  final Appointment appointment;
  final AppointmentsRepository? appointmentsRepositoryOverride;

  @override
  State<AppointmentDetailScreen> createState() =>
      _AppointmentDetailScreenState();
}

class _AppointmentDetailScreenState extends State<AppointmentDetailScreen> {
  AppointmentsRepository? _repo;
  late Appointment _appointment;

  final _reasonController = TextEditingController();
  final _commentController = TextEditingController();

  int _reviewRating = 5;
  bool _cancelling = false;
  bool _reviewing = false;
  AppointmentActionFailure? _cancelError;
  AppointmentActionFailure? _reviewError;
  bool _reviewSubmitted = false;

  @override
  void initState() {
    super.initState();
    _appointment = widget.appointment;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.appointmentsRepositoryOverride ??
        HttpAppointmentsRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
  }

  @override
  void dispose() {
    _reasonController.dispose();
    _commentController.dispose();
    super.dispose();
  }

  Future<void> _onCancel() async {
    setState(() {
      _cancelling = true;
      _cancelError = null;
    });
    try {
      final updated = await _repo!.cancel(
        appointmentId: _appointment.id,
        reason: _reasonController.text.trim().isEmpty
            ? null
            : _reasonController.text.trim(),
      );
      if (!mounted) return;
      setState(() {
        _appointment = updated;
        _cancelling = false;
      });
    } on AppointmentActionFailure catch (e) {
      if (!mounted) return;
      setState(() {
        _cancelError = e;
        _cancelling = false;
      });
    }
  }

  Future<void> _onSubmitReview() async {
    setState(() {
      _reviewing = true;
      _reviewError = null;
    });
    try {
      await _repo!.review(
        appointmentId: _appointment.id,
        rating: _reviewRating,
        comment: _commentController.text.trim().isEmpty
            ? null
            : _commentController.text.trim(),
      );
      if (!mounted) return;
      setState(() {
        _reviewSubmitted = true;
        _reviewing = false;
      });
    } on AppointmentActionFailure catch (e) {
      if (!mounted) return;
      setState(() {
        _reviewError = e;
        _reviewing = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final a = _appointment;
    return Scaffold(
      appBar: AppBar(title: const Text('Appointment')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _Status(status: a.status),
          const SizedBox(height: 16),
          _Row(label: 'When', value: humanDateTime(a.startsAt)),
          _Row(label: 'Status', value: a.status),
          _Row(label: 'Service', value: shortId(a.serviceId)),
          _Row(label: 'Staff', value: shortId(a.staffId)),
          _Row(label: 'Business', value: shortId(a.businessId)),
          _Row(
            label: 'Price',
            value: '${a.priceEtb.toStringAsFixed(0)} ETB',
          ),
          _Row(label: 'Payment', value: _paymentLabel(a.paymentMethod)),
          if (a.cancelledBy != null)
            _Row(label: 'Cancelled by', value: a.cancelledBy!),
          if (a.cancelReason != null)
            _Row(label: 'Cancel reason', value: a.cancelReason!),
          _Row(label: 'Reference', value: a.id),
          const SizedBox(height: 24),
          if (a.isCancellable) _CancelSection(
            controller: _reasonController,
            busy: _cancelling,
            error: _cancelError,
            onCancel: _onCancel,
          ),
          if (a.isReviewable && !_reviewSubmitted) _ReviewSection(
            rating: _reviewRating,
            onRatingChanged: (r) => setState(() => _reviewRating = r),
            commentController: _commentController,
            busy: _reviewing,
            error: _reviewError,
            onSubmit: _onSubmitReview,
          ),
          if (_reviewSubmitted) _ReviewThankYou(),
        ],
      ),
    );
  }

  static String _paymentLabel(String pm) {
    return pm == 'CASH' ? 'Cash at the business' : pm;
  }
}

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
            width: 120,
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

class _Status extends StatelessWidget {
  const _Status({required this.status});
  final String status;
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: colors.primaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        status,
        style: Theme.of(context).textTheme.titleMedium?.copyWith(
              color: colors.onPrimaryContainer,
              letterSpacing: 1,
            ),
      ),
    );
  }
}

class _CancelSection extends StatelessWidget {
  const _CancelSection({
    required this.controller,
    required this.busy,
    required this.error,
    required this.onCancel,
  });

  final TextEditingController controller;
  final bool busy;
  final AppointmentActionFailure? error;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Cancel this booking',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        TextField(
          controller: controller,
          maxLength: 1000,
          minLines: 2,
          maxLines: 4,
          decoration: const InputDecoration(
            labelText: 'Reason (optional)',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        if (error != null) _ActionErrorPanel(error: error!, action: 'cancel'),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: busy ? null : onCancel,
          icon: busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.cancel_outlined),
          label: Text(busy ? 'Cancelling…' : 'Cancel booking'),
        ),
      ],
    );
  }
}

class _ReviewSection extends StatelessWidget {
  const _ReviewSection({
    required this.rating,
    required this.onRatingChanged,
    required this.commentController,
    required this.busy,
    required this.error,
    required this.onSubmit,
  });

  final int rating;
  final ValueChanged<int> onRatingChanged;
  final TextEditingController commentController;
  final bool busy;
  final AppointmentActionFailure? error;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Leave a review',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            for (var i = 1; i <= 5; i++)
              IconButton(
                onPressed: () => onRatingChanged(i),
                icon: Icon(
                  i <= rating ? Icons.star : Icons.star_border,
                  color: colors.primary,
                  size: 32,
                ),
              ),
          ],
        ),
        TextField(
          controller: commentController,
          maxLength: 2000,
          minLines: 2,
          maxLines: 5,
          decoration: const InputDecoration(
            labelText: 'Comment (optional)',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        if (error != null) _ActionErrorPanel(error: error!, action: 'review'),
        const SizedBox(height: 8),
        FilledButton.icon(
          onPressed: busy ? null : onSubmit,
          icon: busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.rate_review),
          label: Text(busy ? 'Submitting…' : 'Submit review'),
        ),
      ],
    );
  }
}

class _ReviewThankYou extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.primaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(Icons.check_circle, color: colors.onPrimaryContainer),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              'Thanks for your review!',
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: colors.onPrimaryContainer,
                  ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionErrorPanel extends StatelessWidget {
  const _ActionErrorPanel({required this.error, required this.action});

  final AppointmentActionFailure error;

  /// `'cancel'` or `'review'` — drives the conflict-specific copy.
  final String action;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    String title;
    String message;
    switch (error.kind) {
      case AppointmentActionFailureKind.conflict:
        if (action == 'cancel') {
          title = 'Past the cancellation cutoff';
          message =
              "It's too close to the appointment time. Contact the "
              'business directly to cancel.';
        } else {
          title = 'Already reviewed';
          message = "You've already left a review for this appointment.";
        }
        break;
      case AppointmentActionFailureKind.unauthenticated:
        title = 'Sign in required';
        message = 'Your session expired. Sign in again to continue.';
        break;
      case AppointmentActionFailureKind.forbidden:
        title = 'Not allowed';
        message = "You don't have permission to $action this appointment.";
        break;
      case AppointmentActionFailureKind.notFound:
        title = 'Appointment not found';
        message = 'This appointment may have been removed.';
        break;
      case AppointmentActionFailureKind.validation:
        title = 'Request refused';
        message = error.message;
        break;
      case AppointmentActionFailureKind.network:
        title = "Can't reach the server";
        message = 'Check your connection and try again.';
        break;
      case AppointmentActionFailureKind.serverError:
      case AppointmentActionFailureKind.malformedResponse:
      case AppointmentActionFailureKind.other:
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
        ],
      ),
    );
  }
}
