import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useTrader } from '../../hooks/useTrader';
import { CoinBadge } from './TradePage';
import { fmtNum, fmtPct, fmtPrice, pnlClass } from '../../utils/format';

export function MarketsPage() {
  const { markets, prices, simulated } = useTrader();
  const nav = useNavigate();
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-50">Markets</h1>
        <p className="text-sm text-slate-400">Live prices streamed in real time{simulated ? ' · simulated data (development)' : ''}.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {markets.map((m) => {
          const p = prices[m.symbol]?.last ?? m.price;
          return (
            <button key={m.symbol} onClick={() => nav(`/?symbol=${encodeURIComponent(m.symbol)}`)} className="group rounded-2xl bg-slate-900 p-4 text-left ring-1 ring-slate-800 transition hover:ring-sky-600">
              <div className="flex items-center gap-3">
                <CoinBadge symbol={m.symbol} size={36} />
                <div className="flex-1">
                  <div className="font-bold text-slate-50">{m.symbol}</div>
                  <div className="text-xs text-slate-500">{m.exchange}</div>
                </div>
                <span className={`rounded-lg px-2 py-1 text-xs font-bold ${(m.change24hPct ?? 0) >= 0 ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>{fmtPct(m.change24hPct)}</span>
              </div>
              <div className="mt-4 font-mono text-2xl font-bold text-slate-50">{fmtPrice(p)}</div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-slate-500">
                <span>Spread<br /><b className="font-mono text-slate-300">{fmtPct(m.spreadPct, 3)}</b></span>
                <span>Volatility<br /><b className="font-mono text-slate-300">{fmtPct(m.volatility, 2)}</b></span>
                <span>Vol 24h<br /><b className={`font-mono ${pnlClass(0)}`}>${fmtNum(m.volume24h, 0)}</b></span>
              </div>
              <div className="mt-3 flex items-center gap-1 text-xs font-semibold text-sky-400 opacity-80 group-hover:opacity-100">Trade <ArrowRight size={13} /></div>
            </button>
          );
        })}
        {!markets.length && <div className="text-sm text-slate-500">No markets available yet.</div>}
      </div>
    </div>
  );
}
