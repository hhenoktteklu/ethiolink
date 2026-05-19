// EthioLink Mobile — admin review queue.
//
// Lists every business currently in PENDING_REVIEW and lets the
// admin approve or reject inline. Replaces the previous mobile
// admin landing's "the real tools are on the web console"
// message — admins can now action the pending queue without
// leaving the phone. The admin SPA's BusinessesPage stays the
// canonical authority for status filters / featuring / suspend
// audit etc.; this screen is the mobile-first review surface
// for the common case (approve a fresh submission, or reject
// it with a reason).
//
// Lifecycle expectations:
//   * Endpoint is `GET /v1/admin/businesses?status=PENDING_REVIEW`.
//   * Approve POSTs `/v1/admin/businesses/{id}/approve` with
//     optional notes (logged on the APPROVE_BUSINESS row).
//   * Reject POSTs `/v1/admin/businesses/{id}/reject` with the
//     reason. The mobile dialog REQUIRES a non-empty reason —
//     the owner-side dashboard reads it back via
//     `OwnerBusinessView.rejection.reason` so the operator's
//     words carry through to the affected owner.
//   * After either action we re-fetch the queue so the row
//     leaves the list (the response was the updated owner view;
//     a fresh fetch makes the dashboard reflect any concurrent
//     submissions too).

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../owner/models/owner_business_view.dart';
import 'data/admin_businesses_repository.dart';

class AdminReviewQueueScreen extends StatefulWidget {
  const AdminReviewQueueScreen({this.repositoryOverride, super.key});

  /// Test seam — production constructs `HttpAdminBusinessesRepository`
  /// over the `AppConfigScope` `AppConfig`.
  final AdminBusinessesRepository? repositoryOverride;

  @override
  State<AdminReviewQueueScreen> createState() =>
      _AdminReviewQueueScreenState();
}

class _AdminReviewQueueScreenState extends State<AdminReviewQueueScreen> {
  AdminBusinessesRepository? _repo;
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
      _future = _repo!.list(status: 'PENDING_REVIEW');
    });
  }

  Future<void> _onApprove(OwnerBusinessView b) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await _repo!.approve(b.id);
      messenger.showSnackBar(
        SnackBar(content: Text('Approved "${b.name ?? b.id}".')),
      );
      _refresh();
    } on AdminBusinessFailure catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(_errorCopy(e))),
      );
    }
  }

  Future<void> _onReject(OwnerBusinessView b) async {
    final reason = await showDialog<String>(
      context: context,
      builder: (_) => const _RejectReasonDialog(),
    );
    if (reason == null || reason.trim().isEmpty) return;
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await _repo!.reject(b.id, notes: reason.trim());
      messenger.showSnackBar(
        SnackBar(content: Text('Rejected "${b.name ?? b.id}".')),
      );
      _refresh();
    } on AdminBusinessFailure catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(_errorCopy(e))),
      );
    }
  }

  String _errorCopy(AdminBusinessFailure e) {
    switch (e.kind) {
      case AdminBusinessFailureKind.unauthenticated:
        return 'Sign in again to continue.';
      case AdminBusinessFailureKind.forbidden:
        return 'Admin role required. Sign in with an admin account.';
      case AdminBusinessFailureKind.notFound:
        return "That business no longer exists. Pull to refresh.";
      case AdminBusinessFailureKind.conflict:
        return 'That business is no longer in pending review.';
      case AdminBusinessFailureKind.validation:
        return e.message;
      case AdminBusinessFailureKind.network:
        return "Can't reach the server. Try again.";
      case AdminBusinessFailureKind.other:
        return 'Something went wrong. ${e.message}';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Review queue'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: RefreshIndicator(
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
              return const _EmptyBody();
            }
            return ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: items.length,
              separatorBuilder: (_, _) => const SizedBox(height: 12),
              itemBuilder: (context, i) {
                final b = items[i];
                return _ReviewCard(
                  business: b,
                  onApprove: () => _onApprove(b),
                  onReject: () => _onReject(b),
                );
              },
            );
          },
        ),
      ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({
    required this.business,
    required this.onApprove,
    required this.onReject,
  });

  final OwnerBusinessView business;
  final VoidCallback onApprove;
  final VoidCallback onReject;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Card(
      color: colors.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              business.name ?? '(no name)',
              style: textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              [
                if (business.city != null) business.city!,
                'PENDING_REVIEW',
              ].join(' · '),
              style: textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
            if (business.descriptionEn != null &&
                business.descriptionEn!.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                business.descriptionEn!,
                style: textTheme.bodyMedium,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
              ),
            ],
            const SizedBox(height: 12),
            Row(
              children: [
                OutlinedButton.icon(
                  key: Key('admin-reject-${business.id}'),
                  onPressed: onReject,
                  icon: const Icon(Icons.close),
                  label: const Text('Reject'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: colors.error,
                    side: BorderSide(color: colors.error),
                  ),
                ),
                const SizedBox(width: 12),
                FilledButton.icon(
                  key: Key('admin-approve-${business.id}'),
                  onPressed: onApprove,
                  icon: const Icon(Icons.check),
                  label: const Text('Approve'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _RejectReasonDialog extends StatefulWidget {
  const _RejectReasonDialog();

  @override
  State<_RejectReasonDialog> createState() => _RejectReasonDialogState();
}

class _RejectReasonDialogState extends State<_RejectReasonDialog> {
  final _controller = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final trimmed = _controller.text.trim();
    if (trimmed.isEmpty) {
      setState(() => _error = 'Please enter a reason for the rejection.');
      return;
    }
    Navigator.of(context).pop(trimmed);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Reject submission'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'The owner will see this reason on their dashboard.',
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('admin-reject-reason-input'),
            controller: _controller,
            autofocus: true,
            maxLines: 4,
            minLines: 2,
            maxLength: 2000,
            decoration: InputDecoration(
              border: const OutlineInputBorder(),
              hintText: 'e.g. Business license photo is unreadable.',
              errorText: _error,
            ),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('admin-reject-submit'),
          onPressed: _submit,
          style: FilledButton.styleFrom(
            backgroundColor: Theme.of(context).colorScheme.error,
          ),
          child: const Text('Reject'),
        ),
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
      children: [
        const SizedBox(height: 80),
        Icon(
          Icons.inbox_outlined,
          size: 56,
          color: colors.onSurfaceVariant,
        ),
        const SizedBox(height: 12),
        Center(
          child: Text(
            'Queue is clear',
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        const SizedBox(height: 4),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Text(
            'No businesses are waiting for review. Pull down to refresh.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
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
    final isNetwork = error is AdminBusinessFailure &&
        (error as AdminBusinessFailure).kind ==
            AdminBusinessFailureKind.network;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 60),
        Icon(
          isNetwork ? Icons.wifi_off : Icons.error_outline,
          size: 56,
          color: colors.error,
        ),
        const SizedBox(height: 12),
        Center(
          child: Text(
            isNetwork ? "Can't reach the server" : 'Something went wrong',
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        const SizedBox(height: 4),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Text(
            error.toString(),
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
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
