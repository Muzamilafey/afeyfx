import { useEffect, useState } from 'react';
import { MetricsTable } from '../../components/MetricsTable';
import { Empty } from '../../components/ui';
import { api } from '../../services/api';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { MarketIcon } from '../../components/MarketIcon';
import { AccountTabs } from '../../components/AccountTabs';
import { pricePrecision, useTrader } from '../../hooks/useTrader';
import { fmtNum, fmtPct, fmtPriceDp, fmtSigned, fmtTime, pnlClass } from '../../utils/format';
import type { Metrics, Trade } from '../../types';

export function HistoryPage() {
  const { accountType, markets } = useTrader();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [perf, setPerf] = useState<{ overall: Metrics } | null>(null);
  const load = () => {
    api<{ trades: Trade[] }>(`/account/history?limit=200&account=${accountType}`).then((r) => setTrades(r.trades), () => undefined);
    api<{ overall: Metrics }>(`/account/performance?account=${accountType}`).then(setPerf, () => undefined);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [accountType]);
  useSocketEvent('trade', load);
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <AccountTabs />
      <div>
        <h1 className="text-2xl font-bold text-slate-50">Trade history · {accountType === 'REAL' ? 'Live account' : 'Demo account'}</h1>
        <p className="text-sm text-slate-400">Every trade, winners and losers, net of fees and slippage. P&L in USD.</p>
      </div>
      {perf && <div className="rounded-2xl bg-slate-900 p-4 ring-1 ring-slate-800"><MetricsTable metrics={perf.overall} /></div>}
      <div className="overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-slate-800">
        {trades.length ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Asset</th><th>Side</th><th>Opened</th><th>Closed</th><th>Entry</th><th>Exit</th><th>Size</th><th>Fees</th><th>Net P&L</th><th>Return</th><th>Reason</th></tr></thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t._id}>
                    <td className="font-sans"><span className="flex items-center gap-2"><MarketIcon symbol={t.symbol} size={20} />{t.symbol}</span></td>
                    <td className={t.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}>{t.direction === 'LONG' ? 'BUY' : 'SELL'}</td>
                    <td>{fmtTime(t.openedAt)}</td>
                    <td>{fmtTime(t.closedAt)}</td>
                    <td>{fmtPriceDp(t.entryPrice, pricePrecision(markets, t.symbol))}</td>
                    <td>{fmtPriceDp(t.exitPrice, pricePrecision(markets, t.symbol))}</td>
                    <td>${fmtNum(t.entryPrice * t.amount * (t.quoteRate ?? 1), 0)}</td>
                    <td>{fmtNum(t.fees)}</td>
                    <td className={pnlClass(t.netPnl)}>{fmtSigned(t.netPnl)}</td>
                    <td className={pnlClass(t.returnPct)}>{fmtPct(t.returnPct)}</td>
                    <td className="font-sans text-slate-400">{t.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No closed trades yet - your history will appear here.</Empty>
        )}
      </div>
    </div>
  );
}
