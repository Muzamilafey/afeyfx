import { useEffect, useState } from 'react';
import { MetricsTable } from '../../components/MetricsTable';
import { Empty } from '../../components/ui';
import { api } from '../../services/api';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { CoinBadge } from './TradePage';
import { fmtNum, fmtPct, fmtPrice, fmtSigned, fmtTime, pnlClass } from '../../utils/format';
import type { Metrics, Trade } from '../../types';

export function HistoryPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [perf, setPerf] = useState<{ overall: Metrics } | null>(null);
  const load = () => {
    api<{ trades: Trade[] }>('/account/history?limit=200').then((r) => setTrades(r.trades), () => undefined);
    api<{ overall: Metrics }>('/account/performance').then(setPerf, () => undefined);
  };
  useEffect(load, []);
  useSocketEvent('trade', load);
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-50">Trade history</h1>
        <p className="text-sm text-slate-400">Every demo trade, winners and losers, net of fees and slippage.</p>
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
                    <td className="font-sans"><span className="flex items-center gap-2"><CoinBadge symbol={t.symbol} size={20} />{t.symbol}</span></td>
                    <td className={t.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}>{t.direction === 'LONG' ? 'BUY' : 'SELL'}</td>
                    <td>{fmtTime(t.openedAt)}</td>
                    <td>{fmtTime(t.closedAt)}</td>
                    <td>{fmtPrice(t.entryPrice)}</td>
                    <td>{fmtPrice(t.exitPrice)}</td>
                    <td>${fmtNum(t.entryPrice * t.amount, 0)}</td>
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
