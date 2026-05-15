// EthioLink Mobile — placeholder bookings screen.
//
// Phase 9 Track 3 scaffold. The real screen will load
// `GET /v1/me/appointments` and render the caller's upcoming +
// past bookings grouped by status. The placeholder just shows an
// empty-state with a help line so the bottom-nav tab is
// navigable.

import 'package:flutter/material.dart';

import '../../core/auth/auth_service.dart';

class BookingsScreen extends StatelessWidget {
  const BookingsScreen({required this.session, super.key});

  final AuthSession session;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(
        title: const Text('My Bookings'),
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.event_available_outlined,
                size: 96,
                color: colors.onSurfaceVariant,
              ),
              const SizedBox(height: 16),
              Text(
                'No bookings yet',
                style: textTheme.titleLarge,
              ),
              const SizedBox(height: 8),
              Text(
                'Your appointments load here once the API client is wired. '
                'For now the marketplace browse tab is the working surface.',
                textAlign: TextAlign.center,
                style: textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
