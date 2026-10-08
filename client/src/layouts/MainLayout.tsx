import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, isAdmin } from '../hooks/useAuth';
import { useSocketStatus } from '../hooks/useSocketEvent';
import { TradingStatusProvider, useTradingStatus } from '../hooks/useTradingStatus';
import { ModeBanner, ModePill } from '../components/ModeBanner';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/trades', label: 'Trades & Orders' },
  { to: '/strategies', label: 'Strategies' },
  { to: '/backtests', label: 'Backtests' },
  { to: '/performance', label: 'Performance' },
  { to: '/settings', label: 'Account & 2FA' },
];

function Shell() {
  const { user, logout } = useAuth();
  const { settings } = useTradingStatus();
  const connected = useSocketStatus();
  const mode = settings?.mode ?? 'PAPER';
  return (
    <div className="flex min-h-screen flex-col">
      <ModeBanner mode={mode} emergency={settings?.emergencyShutdown} />
      <div className="flex flex-1">
        <aside className="hidden w-52 shrink-0 border-r border-slate-800 bg-slate-950 p-3 md:block">
          <div className="mb-6 px-2 text-lg font-bold tracking-tight">
            Afey<span className="text-emerald-400">FX</span>
          </div>
          <nav className="flex flex-col gap-1">
            {[...NAV, ...(isAdmin(user) ? [{ to: '/admin', label: 'Admin' }] : [])].map((n) => (
              <NavLink key={n.to} to={n.to} end={'end' in n} className={({ isActive }) => `rounded-md px-3 py-2 text-sm ${isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-2">
            <div className="flex items-center gap-3 text-sm">
              <ModePill mode={mode} />
              {settings && !settings.tradingEnabled && <span className="rounded bg-amber-600 px-2 py-0.5 text-xs font-bold text-white">NEW TRADES STOPPED</span>}
              <span className={`flex items-center gap-1 text-xs ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
                <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} /> {connected ? 'Live feed' : 'Feed disconnected'}
              </span>
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-400">
              <span>
                {user?.email} <span className="text-xs uppercase text-slate-500">({user?.role})</span>
              </span>
              <button className="btn-ghost" onClick={() => void logout()}>
                Sign out
              </button>
            </div>
          </header>
          <nav className="flex gap-1 overflow-x-auto border-b border-slate-800 px-2 py-1 md:hidden">
            {[...NAV, ...(isAdmin(user) ? [{ to: '/admin', label: 'Admin' }] : [])].map((n) => (
              <NavLink key={n.to} to={n.to} end={'end' in n} className={({ isActive }) => `whitespace-nowrap rounded px-2 py-1 text-xs ${isActive ? 'bg-slate-800 text-white' : 'text-slate-400'}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <main className="flex-1 p-4">
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
