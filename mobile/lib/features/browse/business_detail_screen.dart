// EthioLink Mobile — business detail screen.
//
// Pushed when the operator taps a row on `BusinessesScreen`.
// Composes four concurrent fetches into one scrollable page:
//
//   * Header — business profile (name, city, address, rating,
//     featured chip, description).
//   * Contact — phone / Telegram / WhatsApp when present.
//   * Services — bookable services with price + duration. Each
//     row has a placeholder "Book" button; the slot picker +
//     booking confirmation flow lands in the next mobile commit.
//   * Staff — active staff roster with display name + role.
//   * Reviews — recent reviews list with star ratings.
//
// Each section renders its own loading / success / empty /
// error sub-state. Top-level success is gated on the BUSINESS
// fetch — the others render independently underneath. A 5xx on
// reviews doesn't blank the rest of the page; it just renders an
// inline retry for the reviews section.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../booking/booking_flow_screen.dart';
import '../booking/data/booking_repositories.dart';
import 'data/business_detail_repositories.dart';
import 'models/business_detail.dart';
import 'models/review.dart';
import 'models/service.dart';
import 'models/staff.dart';

class BusinessDetailScreen extends StatefulWidget {
  const BusinessDetailScreen({
    required this.businessId,
    this.initialName,
    this.repositoriesOverride,
    this.slotsRepositoryOverride,
    this.appointmentsRepositoryOverride,
    super.key,
  });

  /// UUID of the business to load.
  final String businessId;

  /// Optional pre-known display name passed in by the listing
  /// screen. Used to seed the AppBar so the user sees the name
  /// during the initial fetch latency. Replaced with the
  /// canonical value once the API responds.
  final String? initialName;

  /// Test seam. Production builds an `Http*` bundle from
  /// `AppConfigScope`.
  final BusinessDetailRepositories? repositoriesOverride;

  /// Forwarded to the booking flow when the user taps "Book" on
  /// a service row. Production leaves these `null`; tests
  /// inject fakes.
  final SlotsRepository? slotsRepositoryOverride;
  final AppointmentsRepository? appointmentsRepositoryOverride;

  @override
  State<BusinessDetailScreen> createState() => _BusinessDetailScreenState();
}

class _BusinessDetailScreenState extends State<BusinessDetailScreen> {
  BusinessDetailRepositories? _repos;

  Future<BusinessDetail>? _businessFuture;
  Future<List<Service>>? _servicesFuture;
  Future<List<Staff>>? _staffFuture;
  Future<List<Review>>? _reviewsFuture;

  /// Cached staff snapshot once `_staffFuture` resolves. The
  /// Book button on each service row reads this to populate the
  /// `BookingFlowScreen` constructor. Null until the staff fetch
  /// completes; the Book button is disabled in that window.
  List<Staff>? _staff;
  String? _businessName;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repos != null) return;
    _repos = widget.repositoriesOverride ??
        BusinessDetailRepositories.over(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _fetchAll();
  }

  void _fetchAll() {
    setState(() {
      _businessFuture = _repos!.detail.getById(widget.businessId);
      _servicesFuture = _repos!.services.listForBusiness(widget.businessId);
      _staffFuture = _repos!.staff.listForBusiness(widget.businessId);
      _reviewsFuture = _repos!.reviews.listForBusiness(widget.businessId);
      _staff = null;
      _businessName = widget.initialName;
    });

    // Cache snapshots once each fetch completes — used by the
    // Book button to construct `BookingFlowScreen` without
    // re-awaiting the futures.
    //
    // Use the `then(..., onError: ...)` form rather than chaining
    // `.catchError((_) {})`. With Dart 3's stricter generics,
    // `Future<T>.catchError`'s callback MUST return `FutureOr<T>`;
    // an empty block returns `Null`, which trips a type error.
    // `then`'s `onError` is plain `Function?` and doesn't carry
    // that constraint.
    _staffFuture!.then(
      (staff) {
        if (!mounted) return;
        setState(() => _staff = staff);
      },
      onError: (Object _) {
        // Swallowed — the section error path renders for the user.
      },
    );
    _businessFuture!.then(
      (b) {
        if (!mounted) return;
        setState(() => _businessName = b.name ?? widget.initialName);
      },
      onError: (Object _) {},
    );
  }

  void _onBookTapped(Service service) {
    final staff = _staff;
    final businessName = _businessName ?? 'this business';
    if (staff == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Staff list still loading — try again in a moment.'),
          duration: Duration(seconds: 2),
        ),
      );
      return;
    }
    if (staff.where((s) => s.isActive).isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'No active staff available for this service yet.',
          ),
          duration: Duration(seconds: 2),
        ),
      );
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => BookingFlowScreen(
          businessId: widget.businessId,
          businessName: businessName,
          service: service,
          staff: staff,
          slotsRepositoryOverride: widget.slotsRepositoryOverride,
          appointmentsRepositoryOverride:
              widget.appointmentsRepositoryOverride,
        ),
      ),
    );
  }

  Future<void> _refresh() async {
    _fetchAll();
    // `Future.wait` fails fast on the first error; we want to wait
    // for ALL four sections to settle so the UI stops the pull-to-
    // refresh spinner regardless of which sections errored. Each
    // future is widened to `dynamic` via `then` so the success and
    // error paths share a return type — the strict-generics
    // `catchError((_) => null as Object?)` pattern doesn't compile
    // under Dart 3.
    await Future.wait<dynamic>([
      _businessFuture!.then<dynamic>((v) => v, onError: (Object _) => null),
      _servicesFuture!.then<dynamic>((v) => v, onError: (Object _) => null),
      _staffFuture!.then<dynamic>((v) => v, onError: (Object _) => null),
      _reviewsFuture!.then<dynamic>((v) => v, onError: (Object _) => null),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: FutureBuilder<BusinessDetail>(
          future: _businessFuture,
          builder: (context, snapshot) {
            final name =
                snapshot.data?.name ?? widget.initialName ?? 'Business';
            return Text(name);
          },
        ),
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: FutureBuilder<BusinessDetail>(
          future: _businessFuture,
          builder: (context, snapshot) {
            if (snapshot.connectionState == ConnectionState.waiting) {
              return const _PageLoading();
            }
            if (snapshot.hasError) {
              return _PageError(error: snapshot.error!, onRetry: _fetchAll);
            }
            final business = snapshot.data!;
            return ListView(
              children: [
                _HeaderSection(business: business),
                if (business.hasAnyContact)
                  _ContactSection(business: business),
                _SectionDivider(),
                _ServicesSection(
                  future: _servicesFuture!,
                  onBookTapped: _onBookTapped,
                ),
                _SectionDivider(),
                _StaffSection(future: _staffFuture!),
                _SectionDivider(),
                _ReviewsSection(future: _reviewsFuture!),
                const SizedBox(height: 24),
              ],
            );
          },
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Top-level states
// ---------------------------------------------------------------------------

class _PageLoading extends StatelessWidget {
  const _PageLoading();
  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: const [
        SizedBox(height: 120),
        Center(child: CircularProgressIndicator()),
      ],
    );
  }
}

class _PageError extends StatelessWidget {
  const _PageError({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isNetwork = error is BusinessDetailLoadFailure &&
        (error as BusinessDetailLoadFailure).isNetworkError;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
      children: [
        Icon(
          isNetwork ? Icons.wifi_off : Icons.error_outline,
          size: 56,
          color: colors.error,
        ),
        const SizedBox(height: 12),
        Text(
          isNetwork
              ? "Can't reach the server"
              : 'Could not load this business',
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

// ---------------------------------------------------------------------------
// Header + contact
// ---------------------------------------------------------------------------

class _HeaderSection extends StatelessWidget {
  const _HeaderSection({required this.business});
  final BusinessDetail business;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final name = business.name ?? 'Unnamed business';
    final ratingLine = business.ratingCount == 0
        ? 'No reviews yet'
        : '★ ${business.ratingAvg.toStringAsFixed(1)} '
            '(${business.ratingCount} review${business.ratingCount == 1 ? '' : 's'})';

    final addressLine = <String>[
      if (business.addressLine != null) business.addressLine!,
      if (business.city != null) business.city!,
    ].join(', ');

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(name, style: textTheme.headlineSmall),
              ),
              if (business.isCurrentlyFeatured) ...[
                const SizedBox(width: 8),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: colors.tertiaryContainer,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    'Featured',
                    style: textTheme.labelSmall?.copyWith(
                      color: colors.onTertiaryContainer,
                    ),
                  ),
                ),
              ],
            ],
          ),
          if (addressLine.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              addressLine,
              style: textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: 4),
          Text(
            ratingLine,
            style: textTheme.bodySmall?.copyWith(
              color: colors.onSurfaceVariant,
            ),
          ),
          if (business.descriptionEn != null) ...[
            const SizedBox(height: 12),
            Text(business.descriptionEn!, style: textTheme.bodyMedium),
          ],
        ],
      ),
    );
  }
}

class _ContactSection extends StatelessWidget {
  const _ContactSection({required this.business});
  final BusinessDetail business;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    Widget row(IconData icon, String value) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            Icon(icon, size: 18, color: colors.primary),
            const SizedBox(width: 8),
            Text(value, style: textTheme.bodyMedium),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Contact', style: textTheme.titleSmall),
          const SizedBox(height: 4),
          if (business.phone != null) row(Icons.call, business.phone!),
          if (business.telegramHandle != null)
            row(Icons.send, '@${business.telegramHandle!}'),
          if (business.whatsappPhone != null)
            row(Icons.chat, business.whatsappPhone!),
        ],
      ),
    );
  }
}

class _SectionDivider extends StatelessWidget {
  const _SectionDivider();
  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 8, horizontal: 16),
      child: Divider(height: 0),
    );
  }
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

class _ServicesSection extends StatelessWidget {
  const _ServicesSection({required this.future, required this.onBookTapped});
  final Future<List<Service>> future;
  final ValueChanged<Service> onBookTapped;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Services', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          FutureBuilder<List<Service>>(
            future: future,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const _InlineLoading();
              }
              if (snapshot.hasError) {
                return _InlineError(message: snapshot.error.toString());
              }
              final data = snapshot.data!;
              if (data.isEmpty) {
                return const _InlineEmpty(
                  message: 'This business has no published services yet.',
                );
              }
              return Column(
                children: [
                  for (final s in data)
                    _ServiceRow(
                      service: s,
                      onBookTapped: () => onBookTapped(s),
                    ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _ServiceRow extends StatelessWidget {
  const _ServiceRow({required this.service, required this.onBookTapped});
  final Service service;
  final VoidCallback onBookTapped;

  String get _priceLabel {
    final p = service.priceEtb;
    if (p == null) return 'Price on request';
    return '${p.toStringAsFixed(0)} ETB';
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(service.nameEn, style: textTheme.bodyLarge),
                Text(
                  '${service.durationMinutes} min · $_priceLabel',
                  style: textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                if (service.descriptionEn != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    service.descriptionEn!,
                    style: textTheme.bodySmall,
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          OutlinedButton(
            onPressed: service.isActive ? onBookTapped : null,
            child: const Text('Book'),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

class _StaffSection extends StatelessWidget {
  const _StaffSection({required this.future});
  final Future<List<Staff>> future;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Staff', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          FutureBuilder<List<Staff>>(
            future: future,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const _InlineLoading();
              }
              if (snapshot.hasError) {
                return _InlineError(message: snapshot.error.toString());
              }
              final data = snapshot.data!;
              if (data.isEmpty) {
                return const _InlineEmpty(
                  message: 'No staff members listed yet.',
                );
              }
              return Column(
                children: [
                  for (final s in data) _StaffRow(staff: s),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _StaffRow extends StatelessWidget {
  const _StaffRow({required this.staff});
  final Staff staff;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: CircleAvatar(
        backgroundColor: colors.secondaryContainer,
        child: Icon(Icons.person, color: colors.onSecondaryContainer),
      ),
      title: Text(staff.displayName),
      subtitle: staff.role != null ? Text(staff.role!) : null,
      dense: true,
    );
  }
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

class _ReviewsSection extends StatelessWidget {
  const _ReviewsSection({required this.future});
  final Future<List<Review>> future;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Reviews', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          FutureBuilder<List<Review>>(
            future: future,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const _InlineLoading();
              }
              if (snapshot.hasError) {
                return _InlineError(message: snapshot.error.toString());
              }
              final data = snapshot.data!;
              if (data.isEmpty) {
                return const _InlineEmpty(
                  message:
                      'No reviews yet. Customers who complete a booking '
                      'can leave a review.',
                );
              }
              return Column(
                children: [
                  for (final r in data) _ReviewRow(review: r),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _ReviewRow extends StatelessWidget {
  const _ReviewRow({required this.review});
  final Review review;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                '★' * review.rating + '☆' * (5 - review.rating),
                style: textTheme.bodyMedium?.copyWith(
                  color: colors.primary,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                _formatReviewDate(review.createdAt),
                style: textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
          if (review.comment != null) ...[
            const SizedBox(height: 4),
            Text(review.comment!, style: textTheme.bodyMedium),
          ],
        ],
      ),
    );
  }

  static String _formatReviewDate(DateTime d) {
    final iso = d.toUtc().toIso8601String();
    return iso.substring(0, 10); // YYYY-MM-DD
  }
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

class _InlineLoading extends StatelessWidget {
  const _InlineLoading();
  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 16),
      child: Center(
        child: SizedBox(
          width: 20,
          height: 20,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      ),
    );
  }
}

class _InlineEmpty extends StatelessWidget {
  const _InlineEmpty({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Text(
        message,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Text(
        message,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.error,
            ),
      ),
    );
  }
}
