import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Banknote, ChartCandlestick, Check, ChevronDown, GraduationCap, History, LayoutGrid, LogOut, PlugZap, Plus, RotateCcw, Send, Shield, User as UserIcon, Wallet } from 'lucide-react';
import { Logo } from '../components/BrandIcons';
import { ThemeToggle } from '../components/ThemeToggle';
import { useToast } from '../components/Toaster';
import { useAuth, isAdmin } from '../hooks/useAuth';
import { TraderProvider, useTrader } from '../hooks/useTrader';
import { useFeatures } from '../hooks/useFeatures';
import { DepositModal } from '../components/payments/DepositModal';
import { VerifySelfButton } from '../components/VerifySelfButton';
import { useSocketStatus } from '../hooks/useSocketEvent';
import { api } from '../services/api';
import { fmtNum } from '../utils/format';

const NAV = [
  { to: '/', label: 'Trade', icon: ChartCandlestick, end: true },
  { to: '/markets', label: 'Markets', icon: LayoutGrid },
  { to: '/history', label: 'History', icon: History },
  { to: '/account', label: 'Account', icon: UserIcon },
];
const PAYMENTS_NAV = { to: '/payments', label: 'Payments', icon: Banknote };
const BROKERS_NAV = { to: '/brokers', label: 'Brokers', icon: PlugZap };

function AccountMenu() {
  const { account, accounts, accountType, setAccountType, positions, reloadAccount, openDeposit } = useTrader();
  const { features } = useFeatures();
  const { user, logout } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const reset = async () => {
    setOpen(false);
    try {
      await api('/account/demo/reset', { method: 'POST' });
      await reloadAccount();
      toast('success', 'Demo account reset', 'Balance restored to $10,000.');
    } catch (e) {
      toast('error', 'Could not reset', (e as Error).message);
    }
  };
  const isReal = accountType === 'REAL';
  const pick = (t: 'DEMO' | 'REAL') => {
    setAccountType(t);
    setOpen(false);
  };
  const row = (t: 'DEMO' | 'REAL') => (
    <button key={t} onClick={() => pick(t)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-slate-800 ${accountType === t ? 'bg-slate-800 ring-1 ring-sky-600' : ''}`} role="menuitemradio" aria-checked={accountType === t}>
      {t === 'REAL' ? <Send size={18} className="text-emerald-400" /> : <GraduationCap size={18} className="text-amber-400" />}
      <div className="flex-1 leading-tight">
        <div className={`text-[10px] font-bold tracking-wider ${t === 'REAL' ? 'text-emerald-400' : 'text-amber-400'}`}>{t === 'REAL' ? 'LIVE ACCOUNT' : 'DEMO ACCOUNT'}</div>
        <div className="font-mono text-sm font-bold text-slate-50">${fmtNum(accounts[t]?.equity ?? 0)}</div>
      </div>
      {accountType === t && <Check size={16} className="text-sky-400" />}
    </button>
  );
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-1.5 text-left ring-1 ring-slate-800 transition hover:ring-slate-700 sm:gap-3" aria-haspopup="menu" aria-expanded={open}>
        {isReal ? <Send size={22} className="text-emerald-400" /> : <Wallet size={22} className="text-sky-400" />}
        <div className="leading-tight">
          <div className={`text-[10px] font-bold tracking-wider ${isReal ? 'text-emerald-400' : 'text-amber-400'}`}>{isReal ? 'LIVE ACCOUNT' : 'DEMO ACCOUNT'}</div>
          <div className="font-mono text-base font-bold text-slate-50">${fmtNum(account?.equity)}</div>
        </div>
        <ChevronDown size={16} className="text-slate-400" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl" role="menu">
          <div className="px-3 py-2">
            <div className="text-xs text-slate-400">Signed in as</div>
            <div className="truncate text-sm font-semibold text-slate-100">{user?.email}</div>
          </div>
          {features.realAccount && <div className="mb-2 space-y-1">{(['REAL', 'DEMO'] as const).map(row)}</div>}
          <div className="mx-3 mb-2 grid grid-cols-2 gap-2 rounded-lg bg-slate-950 p-2 text-xs">
            <div>
              <div className="text-slate-500">Balance</div>
              <div className="font-mono text-slate-100">${fmtNum(account?.balance)}</div>
            </div>
            <div>
              <div className="text-slate-500">Open P&L</div>
              <div className={`font-mono ${(account?.unrealizedPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtNum(account?.unrealizedPnl)}</div>
            </div>
          </div>
          {features.deposits && (
            <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-emerald-400 hover:bg-slate-800 sm:hidden" onClick={() => (setOpen(false), openDeposit())}>
              <Plus size={15} /> Deposit
            </button>
          )}
          {!isReal && (
            <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50" onClick={reset} disabled={positions.length > 0} title={positions.length ? 'Close open positions first' : ''}>
              <RotateCcw size={15} /> Reset demo balance
            </button>
          )}
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-slate-800" onClick={() => (setOpen(false), nav('/account'))}>
            <UserIcon size={15} /> Account & security
          </button>
          {isAdmin(user) && (
            <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-slate-800" onClick={() => nav('/admin')}>
              <Shield size={15} /> Admin console
            </button>
          )}
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-400 hover:bg-slate-800" onClick={() => void logout().then(() => nav('/login'))}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Shell() {
  const { user } = useAuth();
  const { simulated, openDeposit } = useTrader();
  const { features } = useFeatures();
  const nav = useNavigate();
  const connected = useSocketStatus();
  const toast = useToast();
  const items = [...NAV, ...(features.deposits || features.payouts ? [PAYMENTS_NAV] : []), ...(features.derivConnect || features.mt5Connect ? [BROKERS_NAV] : []), ...(isAdmin(user) ? [{ to: '/admin', label: 'Admin', icon: Shield }] : [])];
  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-950 px-3 sm:px-4">
        <Logo />
        <span className="hidden items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1 text-xs text-slate-400 ring-1 ring-slate-800 sm:flex">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} /> {connected ? 'Live' : 'Reconnecting…'}
        </span>
        {simulated && <span className="hidden rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-300 ring-1 ring-amber-500/30 md:inline">SIMULATED MARKET DATA</span>}
        <div className="flex-1" />
        <AccountMenu />
        {features.deposits && (
          <button onClick={openDeposit} className="hidden h-11 items-center gap-2 rounded-xl bg-emerald-500 px-4 font-bold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-600 sm:flex">
            <Plus size={18} /> Deposit
          </button>
        )}
        {features.payouts && (
          <button onClick={() => nav('/withdrawal')} className="hidden h-11 items-center rounded-xl bg-slate-800 px-4 font-bold text-slate-100 ring-1 ring-slate-700 transition hover:bg-slate-700 lg:flex">
            Withdrawal
          </button>
        )}
        <ThemeToggle />
      </header>
      {user?.mustChangePassword && (
        <div className="bg-sky-500/15 px-4 py-1.5 text-center text-xs text-sky-300">
          An administrator reset your password. Please choose a new one under{' '}
          <button className="font-semibold underline" onClick={() => nav('/account')}>
            Account
          </button>
          .
        </div>
      )}
      {user && !user.emailVerified && (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-center text-xs text-amber-300">
          Verify your email to start trading.
          {features.email ? (
            <button className="font-semibold underline" onClick={() => api('/auth/resend-verification', { method: 'POST' }).then(() => toast('success', 'Verification email sent'), (e) => toast('error', 'Could not send', (e as Error).message))}>
              Resend link
            </button>
          ) : (
            !isAdmin(user) && <span className="text-amber-200/80">Email isn't set up yet — ask an administrator to verify your account.</span>
          )}
          <VerifySelfButton />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-[88px] shrink-0 flex-col items-center gap-1 border-r border-slate-800 bg-slate-950 py-3 md:flex" aria-label="Main">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={'end' in n} className={({ isActive }) => `flex w-[72px] flex-col items-center gap-1 rounded-xl py-3 text-[10px] font-bold tracking-wide uppercase transition ${isActive ? 'bg-sky-600 text-white shadow-lg shadow-sky-900/40' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'}`}>
              <n.icon size={22} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-auto pb-16 md:pb-0">
          <Outlet />
        </main>
      </div>
      <DepositModal />
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-slate-800 bg-slate-950 md:hidden" aria-label="Main mobile">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={'end' in n} className={({ isActive }) => `flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold ${isActive ? 'text-sky-400' : 'text-slate-500'}`}>
            <n.icon size={20} />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function TraderLayout() {
  return (
    <TraderProvider>
      <Shell />
    </TraderProvider>
  );
}
