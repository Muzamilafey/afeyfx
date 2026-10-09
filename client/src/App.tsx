import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth, isAdmin } from './hooks/useAuth';
import { ThemeProvider } from './hooks/useTheme';
import { ToastProvider } from './components/Toaster';
import { MainLayout } from './layouts/MainLayout';
import { TraderLayout } from './layouts/TraderLayout';
import { TraderLoginPage } from './pages/auth/TraderLoginPage';
import { SignupPage } from './pages/auth/SignupPage';
import { AdminLoginPage } from './pages/auth/AdminLoginPage';
import { VerifyEmailPage } from './pages/auth/VerifyEmailPage';
import { OAuthCallbackPage } from './pages/auth/OAuthCallbackPage';
import { TradePage } from './pages/trader/TradePage';
import { MarketsPage } from './pages/trader/MarketsPage';
import { HistoryPage } from './pages/trader/HistoryPage';
import { AccountPage } from './pages/trader/AccountPage';
import { WithdrawalPage } from './pages/trader/WithdrawalPage';
import { PaymentsPage } from './pages/trader/PaymentsPage';
import { BrokersPage } from './pages/trader/BrokersPage';
import { AdminPaymentsPage } from './pages/admin/AdminPaymentsPage';
import { AdminBrokersPage } from './pages/admin/AdminBrokersPage';
import { AdminIntegrationsPage } from './pages/admin/AdminIntegrationsPage';
import { FeaturesProvider } from './hooks/useFeatures';
import { DashboardPage } from './pages/DashboardPage';
import { TradesPage } from './pages/TradesPage';
import { StrategiesPage } from './pages/StrategiesPage';
import { BacktestsPage } from './pages/BacktestsPage';
import { PerformancePage } from './pages/PerformancePage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminPage } from './pages/AdminPage';

function Loading() {
  return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-500">Loading…</div>;
}

/** Trader area: any signed-in user. */
function RequireUser({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

/** Admin console: admins only; everyone else goes to the admin sign-in or back to the terminal. */
function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/admin/login" replace />;
  if (!isAdmin(user)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Signed-in users skip the sign-in pages. */
function GuestOnly({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (user) return <Navigate to={admin && isAdmin(user) ? '/admin' : '/'} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<GuestOnly><TraderLoginPage /></GuestOnly>} />
              <Route path="/signup" element={<GuestOnly><SignupPage /></GuestOnly>} />
              <Route path="/admin/login" element={<GuestOnly admin><AdminLoginPage /></GuestOnly>} />
              <Route path="/verify-email" element={<VerifyEmailPage />} />
              <Route path="/auth/callback" element={<OAuthCallbackPage />} />

              <Route path="/admin" element={<RequireAdmin><FeaturesProvider><MainLayout /></FeaturesProvider></RequireAdmin>}>
                <Route index element={<DashboardPage />} />
                <Route path="trades" element={<TradesPage />} />
                <Route path="strategies" element={<StrategiesPage />} />
                <Route path="backtests" element={<BacktestsPage />} />
                <Route path="performance" element={<PerformancePage />} />
                <Route path="system" element={<AdminPage />} />
                <Route path="payments" element={<AdminPaymentsPage />} />
                <Route path="brokers" element={<AdminBrokersPage />} />
                <Route path="integrations" element={<AdminIntegrationsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/admin" replace />} />
              </Route>

              <Route element={<RequireUser><FeaturesProvider><TraderLayout /></FeaturesProvider></RequireUser>}>
                <Route index element={<TradePage />} />
                <Route path="markets" element={<MarketsPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="account" element={<AccountPage />} />
                <Route path="withdrawal" element={<WithdrawalPage />} />
                <Route path="payments" element={<PaymentsPage />} />
                <Route path="brokers" element={<BrokersPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
