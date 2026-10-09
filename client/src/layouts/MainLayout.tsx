import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ChartCandlestick } from 'lucide-react';
import { Logo } from '../components/BrandIcons';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuth } from '../hooks/useAuth';
import { VerifySelfButton } from '../components/VerifySelfButton';
import { useSocketStatus } from '../hooks/useSocketEvent';
import { TradingStatusProvider, useTradingStatus } from '../hooks/useTradingStatus';
import { ModeBanner, ModePill } from '../components/ModeBanner';

const NAV = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/traders', label: 'Traders' },
  { to: '/admin/trades', label: 'Trades & Orders' },
  { to: '/admin/strategies', label: 'Strategies' },
  { to: '/admin/backtests', label: 'Backtests' },
  { to: '/admin/performance', label: 'Performance' },
  { to: '/admin/system', label: 'System & Risk' },
  { to: '/admin/payments', label: 'Payments' },
  { to: '/admin/brokers', label: 'Brokers' },
  { to: '/admin/integrations', label: 'Integrations' },
  { to: '/admin/settings', label: 'Account & 2FA' },
];

function Shell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { settings } = useTradingStatus();
  const connected = useSocketStatus();
  const mode = settings?.mode ?? 'PAPER';
  return (
    <div className="flex min-h-screen flex-col">
      <ModeBanner mode={mode} emergency={settings?.emergencyShutdown} />
      <div className="flex flex-1">
        <aside className="hidden w-52 shrink-0 border-r border-slate-800 bg-slate-950 p-3 md:block">
          <div className="mb-6 px-2">
            <Logo />
            <div className="mt-1 text-[10px] font-bold tracking-widest text-slate-500">ADMIN CONSOLE</div>
          </div>
          <nav className="flex flex-col gap-1">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={'end' in n} className={({ isActive }) => `rounded-md px-3 py-2 text-sm ${isActive ? 'bg-slate-800 text-slate-50' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <ModePill mode={mode} />
              {settings && !settings.tradingEnabled && <span className="rounded bg-amber-600 px-2 py-0.5 text-xs font-bold text-white">NEW TRADES STOPPED</span>}
              <span className={`flex items-center gap-1 text-xs ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
                <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} /> <span className="hidden sm:inline">{connected ? 'Live feed' : 'Feed disconnected'}</span>
              </span>
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-400">
              <span className="hidden sm:inline">
                {user?.email} <span className="text-xs uppercase text-slate-500">({user?.role})</span>
              </span>
              <button className="btn-ghost hidden sm:inline-flex" onClick={() => navigate('/')} title="Open the trading terminal">
                <ChartCandlestick size={15} /> Terminal
              </button>
              <ThemeToggle />
              <button className="btn-ghost" onClick={() => void logout().then(() => navigate('/admin/login'))}>
                Sign out
              </button>
            </div>
          </header>
          <nav className="flex gap-1 overflow-x-auto border-b border-slate-800 px-2 py-1 md:hidden">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={'end' in n} className={({ isActive }) => `whitespace-nowrap rounded px-2 py-1 text-xs ${isActive ? 'bg-slate-800 text-slate-50' : 'text-slate-400'}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          {user?.mustChangePassword && <div className="bg-sky-500/15 px-4 py-1.5 text-center text-xs text-sky-300">An administrator reset your password. Choose a new one under Account & 2FA.</div>}
          {user && !user.emailVerified && (
            <div className="flex flex-wrap items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-center text-xs text-amber-300">
              Verify your email address (Account & 2FA) - admin actions are blocked until you do.
              <VerifySelfButton />
            </div>
          )}
          <main className="min-w-0 flex-1 p-3 sm:p-4">
            <Outlet />
          </main>
          <footer className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500">Trading involves substantial risk of loss. No strategy, backtest or AI analysis guarantees profit. Past performance does not predict future results.</footer>
        </div>
      </div>
    </div>
  );
}

export function MainLayout() {
  return (
    <TradingStatusProvider>
      <Shell />
    </TradingStatusProvider>
  );
}
