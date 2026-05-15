// EthioLink Mobile — placeholder browse / home screen.
//
// Phase 9 Track 3 scaffold. Lands after a successful (fake)
// sign-in. The real screen will query `GET /v1/categories` +
// `GET /v1/businesses` and render the marketplace grid; the
// placeholder shows the four MVP categories as static cards so
// the navigation loop ("login → browse → ...") works end-to-end.
//
// The bottom navigation bar wires to the placeholder bookings +
// profile screens so the operator can walk every scaffold screen
// without modifying code.

import 'package:flutter/material.dart';

import '../../core/auth/auth_service.dart';
import '../bookings/bookings_screen.dart';
import '../profile/profile_screen.dart';

class BrowseScreen extends StatefulWidget {
  const BrowseScreen({
    required this.session,
    this.authServiceOverride,
    super.key,
  });

  final AuthSession session;

  /// Forwarded to `ProfileScreen` so the sign-out button can use
  /// the same (potentially test-injected) `AuthService` as the
  /// surrounding `LoginScreen`.
  final AuthService? authServiceOverride;

  @override
  State<BrowseScreen> createState() => _BrowseScreenState();
}

class _BrowseScreenState extends State<BrowseScreen> {
  int _selectedIndex = 0;

  late final List<Widget> _tabs = <Widget>[
    _BrowseTab(session: widget.session),
    BookingsScreen(session: widget.session),
    ProfileScreen(
      session: widget.session,
      authServiceOverride: widget.authServiceOverride,
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _tabs[_selectedIndex],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _selectedIndex,
        onDestinationSelected: (i) => setState(() => _selectedIndex = i),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.search_outlined),
            selectedIcon: Icon(Icons.search),
            label: 'Browse',
          ),
          NavigationDestination(
            icon: Icon(Icons.event_outlined),
            selectedIcon: Icon(Icons.event),
            label: 'Bookings',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person),
            label: 'Profile',
          ),
        ],
      ),
    );
  }
}

class _BrowseTab extends StatelessWidget {
  const _BrowseTab({required this.session});

  final AuthSession session;

  static const _placeholderCategories = <_CategoryCard>[
    _CategoryCard(icon: Icons.content_cut, label: 'Salons'),
    _CategoryCard(icon: Icons.cut, label: 'Barbers'),
    _CategoryCard(icon: Icons.spa, label: 'Spas'),
    _CategoryCard(icon: Icons.brush, label: 'Beauty Pros'),
  ];

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        SliverAppBar(
          title: const Text('Discover'),
          floating: true,
        ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          sliver: SliverToBoxAdapter(
            child: Text(
              'Welcome back, ${session.email}.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
          sliver: SliverGrid(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              crossAxisSpacing: 12,
              mainAxisSpacing: 12,
              childAspectRatio: 1.2,
            ),
            delegate: SliverChildBuilderDelegate(
              (context, i) => _placeholderCategories[i],
              childCount: _placeholderCategories.length,
            ),
          ),
        ),
        const SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.fromLTRB(16, 8, 16, 24),
            child: Text(
              'Marketplace listings load here once the API client lands.',
              textAlign: TextAlign.center,
            ),
          ),
        ),
      ],
    );
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      elevation: 0,
      color: colors.surfaceContainerHighest,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('$label — placeholder. Wire the real fetch next.'),
              duration: const Duration(seconds: 2),
            ),
          );
        },
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 36, color: colors.primary),
              const SizedBox(height: 8),
              Text(
                label,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
