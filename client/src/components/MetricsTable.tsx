import { fmtNum, fmtPct, fmtRatio, pnlClass } from '../utils/format';
import type { Metrics } from '../types';

export function MetricsTable({ metrics: m, compact = false }: { metrics: Metrics; compact?: boolean }) {
  const rows: [string, string, string?][] = [
    ['Total return', fmtPct(m.totalReturn), pnlClass(m.totalReturn)],
    ['Max drawdown', fmtPct(m.maxDrawdown), 'text-red-300'],
    ['Sharpe', fmtRatio(m.sharpe)],
    ['Sortino', fmtRatio(m.sortino)],
    ['Profit factor', fmtRatio(m.profitFactor)],
    ['Expectancy', fmtNum(m.expectancy), pnlClass(m.expectancy)],
    ['Win rate', fmtPct(m.winRate, 1)],
    ['Trades', String(m.numberOfTrades)],
    ['Avg trade', fmtNum(m.averageTrade), pnlClass(m.averageTrade)],
    ['Fees', fmtNum(m.totalFees)],
    ['Slippage', fmtNum(m.totalSlippage)],
    ['Win / loss streak', `${m.longestWinStreak} / ${m.longestLossStreak}`],
  ];
  return (
    <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-4 xl:grid-cols-6'}`}>
      {rows.map(([k, v, cls]) => (
        <div key={k} className="rounded border border-slate-800 bg-slate-950/50 px-2 py-1.5">
          <div className="text-[10px] text-slate-500 uppercase">{k}</div>
          <div className={`font-mono text-sm ${cls ?? ''}`}>{v}</div>
        </div>
      ))}
    </div>
  );
}
