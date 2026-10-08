import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { AccountTabs } from '../../components/AccountTabs';
import { MarketIcon } from '../../components/MarketIcon';
import { useTrader } from '../../hooks/useTrader';
import { fmtNum, fmtPct, fmtPriceDp } from '../../utils/format';

const LABEL: Record<string, string> = { all: 'All', crypto: 'Crypto', forex: 'Forex', metals: 'Metals' };

export function MarketsPage() {
  const { markets, prices, simulated } = useTrader();
  const nav = useNavigate();
  const cats = ['all', ...new Set(markets.map((m) => m.category ?? 'crypto'))];
  const [cat, setCat] = useState('all');
  const list = markets.filter((m) => cat === 'all' || (m.category ?? 'crypto') === cat);
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <AccountTabs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">Markets</h1>
          <p className="text-sm text-slate-400">
            {markets.length} instruments, live prices streamed in real time{simulated ? ' · simulated data (development)' : ''}.
          </p>
        </div>
        {cats.length > 2 && (
          <div className="flex gap-1 rounded-xl bg-slate-900 p-1 ring-1 ring-slate-800" role="tablist">
            {cats.map((c) => (
              <button key={c} role="tab" aria-selected={cat === c} onClick={() => setCat(c)} className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${cat === c ? 'bg-sky-600 text-white' : 'text-slate-300 hover:text-white'}`}>
                {LABEL[c] ?? c} <span className="ml-1 text-xs opacity-70">{c === 'all' ? markets.length : markets.filter((m) => (m.category ?? 'crypto') === c).length}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((m) => {
          const p = prices[m.symbol]?.last ?? m.price;
          const closed = m.marketOpen === false;
          return (
            <button key={m.symbol} onClick={() => nav(`/?symbol=${encodeURIComponent(m.symbol)}`)} className="group rounded-2xl bg-slate-900 p-4 text-left ring-1 ring-slate-800 transition hover:ring-sky-600">
              <div className="flex items-center gap-3">
                <MarketIcon symbol={m.symbol} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-slate-50">{m.symbol}</div>
                  <div className="truncate text-xs text-slate-500">{m.name ?? m.exchange}</div>
                </div>
                {closed ? (
                  <span className="rounded-lg bg-amber-500/15 px-2 py-1 text-xs font-bold text-amber-400">Closed</span>
                ) : (
                  <span className={`rounded-lg px-2 py-1 text-xs font-bold ${(m.change24hPct ?? 0) >= 0 ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>{fmtPct(m.change24hPct)}</span>
                )}
              </div>
              <div className="mt-4 font-mono text-2xl font-bold text-slate-50">{m.unavailable ? '—' : fmtPriceDp(p, m.pricePrecision)}</div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-slate-500">
                <span>
                  Spread
                  <br />
                  <b className="font-mono text-slate-300">{fmtPct(m.spreadPct, 3)}</b>
                </span>
                <span>
                  Volatility
                  <br />
                  <b className="font-mono text-slate-300">{fmtPct(m.volatility, 2)}</b>
                </span>
                <span>
                  {m.category === 'crypto' ? 'Vol 24h' : 'Market'}
                  <br />
                  <b className="font-mono text-slate-300">{m.category === 'crypto' ? `$${fmtNum(m.volume24h, 0)}` : LABEL[m.category ?? 'forex']}</b>
                </span>
              </div>
              <div className="mt-3 flex items-center gap-1 text-xs font-semibold text-sky-400 opacity-80 group-hover:opacity-100">
                Trade <ArrowRight size={13} />
              </div>
            </button>
          );
        })}
        {!markets.length && <div className="text-sm text-slate-500">No markets available yet.</div>}
      </div>
    </div>
  );
}
