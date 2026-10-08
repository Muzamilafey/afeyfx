import { useNavigate } from 'react-router-dom';
import { SecuritySettings } from '../../components/SecuritySettings';
import { AccountTabs } from '../../components/AccountTabs';
import { useFeatures } from '../../hooks/useFeatures';
import { useAuth } from '../../hooks/useAuth';
import { useTrader } from '../../hooks/useTrader';
import { useTheme, type ThemePref } from '../../hooks/useTheme';
import { Card, Stat } from '../../components/ui';
import { fmtNum, fmtPct, pnlClass } from '../../utils/format';

export function AccountPage() {
  const { user } = useAuth();
  const { accounts, openDeposit } = useTrader();
  const { features } = useFeatures();
  const nav = useNavigate();
  const demo = accounts.DEMO;
  const real = accounts.REAL;
  const { pref, setPref } = useTheme();
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <AccountTabs />
      <div className="flex items-center gap-4">
        {user?.avatarUrl ? <img src={user.avatarUrl} alt="" className="h-14 w-14 rounded-full" /> : <div className="flex h-14 w-14 items-center justify-center rounded-full bg-sky-600 text-xl font-bold text-white">{user?.name?.[0]?.toUpperCase()}</div>}
        <div>
          <h1 className="text-2xl font-bold text-slate-50">{user?.name}</h1>
          <div className="text-sm text-slate-400">{user?.email} · <span className="uppercase">{user?.role}</span></div>
        </div>
      </div>
      {features.realAccount && (
        <Card
          title="Live account (real money)"
          actions={
            <div className="flex gap-2">
              {features.deposits && (
                <button className="btn-primary !py-1 text-xs" onClick={openDeposit}>
                  Deposit
                </button>
              )}
              {features.payouts && (
                <button className="btn-ghost !py-1 text-xs" onClick={() => nav('/withdrawal')}>
                  Withdraw
                </button>
              )}
            </div>
          }
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Equity" value={`$${fmtNum(real?.equity ?? 0)}`} />
            <Stat label="Available" value={`$${fmtNum(real?.available ?? 0)}`} />
            <Stat label="Trading P&L" value={fmtNum(real?.totalPnl ?? 0)} valueClass={pnlClass(real?.totalPnl)} />
            <Stat label="Net deposits" value={`$${fmtNum(real?.startingBalance ?? 0)}`} />
          </div>
          <p className="mt-3 text-xs text-slate-500">Deposits and withdrawals are not counted as trading profit or loss.</p>
        </Card>
      )}
      <Card title="Demo account">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Equity" value={`$${fmtNum(demo?.equity)}`} />
          <Stat label="Available" value={`$${fmtNum(demo?.available)}`} />
          <Stat label="Total P&L" value={fmtNum(demo?.totalPnl)} valueClass={pnlClass(demo?.totalPnl)} />
          <Stat label="Drawdown" value={fmtPct(demo?.drawdown)} />
        </div>
        <p className="mt-3 text-xs text-slate-500">The demo account uses virtual funds and can be reset at any time.</p>
      </Card>
      <Card title="Appearance">
        <div className="flex gap-2">
          {(['light', 'dark', 'system'] as ThemePref[]).map((p) => (
            <button key={p} onClick={() => setPref(p)} className={`rounded-lg px-4 py-2 text-sm capitalize ${pref === p ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>{p}</button>
          ))}
        </div>
      </Card>
      <SecuritySettings />
    </div>
  );
}
