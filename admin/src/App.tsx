// EthioLink admin — top-level routes.
//
// Three route groups:
//
//   1. `/login` — public, renders the Cognito hosted-UI sign-in
//      button and handles the OAuth callback (`?code=...`).
//   2. Protected layout — wraps every authenticated page in
//      `ProtectedRoute` (redirects to `/login` if the caller isn't
//      ADMIN) and `AdminLayout` (header + sign-out + page outlet).
//      Dashboard is the only page wired in this scaffold; the
//      businesses / users / categories / bookings pages are
//      follow-up commits.
//   3. Catch-all → redirect to `/`, which then re-enters the
//      protected group.

import { Navigate, Route, Routes } from 'react-router-dom';

import { AdminLayout } from './components/AdminLayout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppointmentsPage } from './pages/AppointmentsPage';
import { BusinessDetailPage } from './pages/BusinessDetailPage';
import { BusinessesPage } from './pages/BusinessesPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { UsersPage } from './pages/UsersPage';

export function App() {
    return (
        <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
                element={
                    <ProtectedRoute>
                        <AdminLayout />
                    </ProtectedRoute>
                }
            >
                <Route path="/" element={<DashboardPage />} />
                <Route path="/businesses" element={<BusinessesPage />} />
                <Route path="/businesses/:id" element={<BusinessDetailPage />} />
                <Route path="/categories" element={<CategoriesPage />} />
                <Route path="/users" element={<UsersPage />} />
                <Route path="/appointments" element={<AppointmentsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}
