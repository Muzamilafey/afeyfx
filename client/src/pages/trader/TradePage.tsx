import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronDown, Clock, Minus, Plus, Search, X } from 'lucide-react';
import { CandleChart, type PriceMarker } from '../../charts/CandleChart';
import { useToast } from '../../components/Toaster';
import { useAuth } from '../../hooks/useAuth';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { livePnl, useTrader } from '../../hooks/useTrader';
import { api } from '../../services/api';
import { fmtNum, fmtPct, fmtPrice, fmtSigned, pnlClass } from '../../utils/format';
import type { Candle, Position, Trade } from '../../types';

const TFS = [
  { tf: '1m', ms: 60_000 },
  { tf: '5m', ms: 300_000 },
  { tf: '15m', ms: 900_000 },
  { tf: '1h', ms: 3_600_000 },
] as const;
type Tf = (typeof TFS)[number]['tf'];

function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-400">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> {now.toISOString().slice(11, 19)} UTC
    </span>
  );
}

function AssetPicker({ symbol, onPick }: { symbol: string; onPick(s: string): void }) {
  const { markets, prices } = useTrader();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const m = markets.find((x) => x.symbol === symbol);
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex min-w-56 items-center gap-3 rounded-xl bg-slate-900/90 px-3 py-2 text-left ring-1 ring-slate-800 backdrop-blur hover:ring-slate-700" aria-haspopup="listbox">
        <CoinBadge symbol={symbol} />
        <div className="flex-1 leading-tight">
          <div className="font-bold text-slate-50">{symbol}</div>
          <div className={`text-xs font-semibold ${pnlClass(m?.change24hPct)}`}>{fmtPct(m?.change24hPct)} 24h</div>
        </div>
        <ChevronDown size={16} className="text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-40 mt-2 w-80 rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl">
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-slate-950 px-2">
            <Search size={14} className="text-slate-500" />
            <input autoFocus className="h-9 flex-1 bg-transparent text-sm outline-none" placeholder="Search markets" value={q} onChange={(e) => setQ(e.target.value.toUpperCase())} />
          </div>
          <div className="max-h-72 overflow-auto" role="listbox">
            {markets
              .filter((x) => x.symbol.includes(q))
              .map((x) => (
                <button key={x.symbol} role="option" aria-selected={x.symbol === symbol} onClick={() => (onPick(x.symbol), setOpen(false))} className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-slate-800 ${x.symbol === symbol ? 'bg-slate-800' : ''}`}>
                  <CoinBadge symbol={x.symbol} />
                  <span className="flex-1 text-sm font-semibold">{x.symbol}</span>
                  <span className="font-mono text-xs text-slate-300">{fmtPrice(prices[x.symbol]?.last ?? x.price)}</span>
                  <span className={`w-16 text-right text-xs font-semibold ${pnlClass(x.change24hPct)}`}>{fmtPct(x.change24hPct)}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function CoinBadge({ symbol, size = 30 }: { symbol: string; size?: number }) {
  const base = symbol.split('/')[0];
  const colors: Record<string, string> = { BTC: '#f7931a', ETH: '#627eea', SOL: '#14f195', BNB: '#f3ba2f', XRP: '#23292f', ADA: '#0033ad', DOGE: '#c2a633' };
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-black text-white" style={{ width: size, height: size, background: colors[base] ?? '#0284c7' }}>
      {base.slice(0, 3)}
    </span>
  );
}

function Stepper({ label, value, onChange, step, min, max, format, hint }: { label: string; value: number; onChange(v: number): void; step: number; min: number; max: number; format(v: number): string; hint?: string }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v * 1e6) / 1e6));
  return (
    <fieldset className="rounded-xl border border-slate-700 px-3 pt-1 pb-2">
      <legend className="px-1 text-xs text-slate-400">{label}</legend>
      <div className="flex items-center gap-2">
        <button type="button" className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-slate-200 hover:bg-slate-700" onClick={() => onChange(clamp(value - step))} aria-label={`Decrease ${label}`}>
          <Minus size={15} />
        </button>
        <input className="w-full bg-transparent text-center font-mono text-xl font-semibold text-slate-50 outline-none" value={format(value)} onChange={(e) => {
          const n = Number(e.target.value.replace(/[^0-9.]/g, ''));
          if (Number.isFinite(n)) onChange(clamp(label.includes('%') ? n / 100 : n));
        }} aria-label={label} />
        <button type="button" className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-slate-200 hover:bg-slate-700" onClick={() => onChange(clamp(value + step))} aria-label={`Increase ${label}`}>
          <Plus size={15} />
        </button>
      </div>
      {hint && <div className="mt-0.5 text-center text-[10px] font-bold tracking-wider text-sky-400 uppercase">{hint}</div>}
    </fieldset>
  );
}

function OrderTicket({ symbol }: { symbol: string }) {
  const { account, prices, markets, reloadAccount, reloadPositions } = useTrader();
  const { user } = useAuth();
  const toast = useToast();
  const [investment, setInvestment] = useState(100);
  const [sl, setSl] = useState(0.02);
  const [tpOn, setTpOn] = useState(true);
  const [tp, setTp] = useState(0.04);
  const [busy, setBusy] = useState<'LONG' | 'SHORT' | null>(null);
  const price = prices[symbol]?.last ?? markets.find((m) => m.symbol === symbol)?.price;
  const fees = investment * 0.001 * 2;
  const blocked = !user?.emailVerified ? 'Verify your email to trade' : !price ? 'Waiting for market data' : investment > (account?.available ?? 0) ? 'Insufficient demo balance' : null;

  const place = async (direction: 'LONG' | 'SHORT') => {
    setBusy(direction);
    try {
      const r = await api<{ position: Position }>('/account/orders', { method: 'POST', body: { symbol, direction, investment, stopLossPct: sl, takeProfitPct: tpOn ? tp : undefined, idempotencyKey: crypto.randomUUID() } });
      toast('success', `${direction === 'LONG' ? 'Buy' : 'Sell'} ${symbol} filled`, `${fmtNum(r.position.amount, 6)} @ ${fmtPrice(r.position.entryPrice)}`);
      await Promise.all([reloadPositions(), reloadAccount()]);
    } catch (e) {
      toast('error', 'Order rejected', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-bold text-slate-50">
          <CoinBadge symbol={symbol} size={24} /> {symbol}
        </span>
        <span className="font-mono text-sm text-slate-300">{fmtPrice(price)}</span>
      </div>
      <Stepper label="Investment" value={investment} onChange={setInvestment} step={10} min={10} max={100_000} format={(v) => `$${fmtNum(v, 0)}`} />
      <div className="grid grid-cols4 grid-cols-4 gap-1.5">
        {[50, 100, 500, 1000].map((v) => (
          <button key={v} className={`rounded-lg py-1 text-xs font-semibold ${investment === v ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`} onClick={() => setInvestment(v)}>
            ${v}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stepper label="Stop loss %" value={sl} onChange={setSl} step={0.005} min={0.001} max={0.5} format={(v) => `${(v * 100).toFixed(1)}%`} />
        <div className={tpOn ? '' : 'opacity-50'}>
          <Stepper label="Take profit %" value={tp} onChange={setTp} step={0.005} min={0.001} max={2} format={(v) => `${(v * 100).toFixed(1)}%`} />
        </div>
      </div>
      <label className="flex items-center justify-between text-xs text-slate-400">
        Take profit
        <input type="checkbox" checked={tpOn} onChange={(e) => setTpOn(e.target.checked)} className="h-4 w-4 accent-sky-500" />
      </label>
      <div className="space-y-1 rounded-lg bg-slate-900 p-2.5 text-xs">
        <div className="flex justify-between"><span className="text-slate-400">Units</span><span className="font-mono text-slate-200">{price ? fmtNum(investment / price, 6) : '—'}</span></div>
        <div className="flex justify-between"><span className="text-slate-400">Max loss at stop ≈</span><span className="font-mono text-red-400">-${fmtNum(investment * sl + fees)}</span></div>
        {tpOn && <div className="flex justify-between"><span className="text-slate-400">Profit at target ≈</span><span className="font-mono text-emerald-400">+${fmtNum(investment * tp - fees)}</span></div>}
        <div className="flex justify-between"><span className="text-slate-400">Est. fees</span><span className="font-mono text-slate-300">${fmtNum(fees)}</span></div>
      </div>
      <button className="flex h-14 w-full items-center justify-between rounded-xl bg-emerald-500 px-5 text-lg font-bold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-400 disabled:opacity-50" disabled={!!blocked || !!busy} onClick={() => place('LONG')}>
        {busy === 'LONG' ? 'Placing…' : 'Buy'} <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/25"><ArrowUp size={16} /></span>
      </button>
      <button className="flex h-14 w-full items-center justify-between rounded-xl bg-red-500 px-5 text-lg font-bold text-white shadow-lg shadow-red-900/30 transition hover:bg-red-400 disabled:opacity-50" disabled={!!blocked || !!busy} onClick={() => place('SHORT')}>
        {busy === 'SHORT' ? 'Placing…' : 'Sell'} <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/25"><ArrowDown size={16} /></span>
      </button>
      {blocked && <div className="text-center text-xs text-amber-400">{blocked}</div>}
      <p className="text-center text-[10px] leading-snug text-slate-500">Demo account · virtual funds. Simulated fills include fees, spread and slippage.</p>
    </div>
  );
}

function TradesPanel() {
  const { positions, prices, reloadPositions, reloadAccount } = useTrader();
  const toast = useToast();
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [closed, setClosed] = useState<Trade[]>([]);
  const loadClosed = () => api<{ trades: Trade[] }>('/account/history?limit=30').then((r) => setClosed(r.trades), () => undefined);
  useEffect(() => void loadClosed(), []);
  useSocketEvent('trade', () => void loadClosed());

  const close = async (p: Position) => {
    try {
      const r = await api<{ trade: Trade }>(`/account/positions/${p._id}/close`, { method: 'POST' });
      toast(r.trade.netPnl >= 0 ? 'success' : 'info', `Closed ${p.symbol}`, `Net P&L ${fmtSigned(r.trade.netPnl)}`);
      await Promise.all([reloadPositions(), reloadAccount(), loadClosed()]);
    } catch (e) {
      toast('error', 'Close failed', (e as Error).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-2 border-b border-slate-800 text-sm">
        {(['open', 'closed'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex items-center justify-center gap-2 border-b-2 py-2.5 font-semibold ${tab === t ? 'border-sky-500 text-slate-50' : 'border-transparent text-slate-400'}`}>
            {t === 'open' ? 'Trades' : <Clock size={15} />} <span className="rounded-full bg-slate-800 px-2 text-xs">{t === 'open' ? positions.length : closed.length}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {tab === 'open' &&
          (positions.length ? (
            positions.map((p) => {
              const pnl = livePnl(p, prices[p.symbol]?.[p.direction === 'LONG' ? 'bid' : 'ask']);
              return (
                <div key={p._id} className="rounded-xl bg-slate-900 p-3 ring-1 ring-slate-800">
                  <div className="flex items-center gap-2">
                    <CoinBadge symbol={p.symbol} size={22} />
                    <span className="flex-1 truncate text-sm font-semibold">{p.symbol}</span>
                    <span className={`flex items-center gap-0.5 text-xs font-bold ${p.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>
                      {p.direction === 'LONG' ? <ArrowUp size={13} /> : <ArrowDown size={13} />} {p.direction === 'LONG' ? 'BUY' : 'SELL'}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-slate-400">
                    <span>Entry <b className="font-mono text-slate-200">{fmtPrice(p.entryPrice)}</b></span>
                    <span className="text-right">Size <b className="font-mono text-slate-200">${fmtNum(p.entryPrice * p.amount, 0)}</b></span>
                    <span>SL <b className="font-mono text-red-400">{fmtPrice(p.stopLoss)}</b></span>
                    <span className="text-right">TP <b className="font-mono text-emerald-400">{fmtPrice(p.takeProfit)}</b></span>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className={`font-mono text-base font-bold ${pnlClass(pnl)}`}>{fmtSigned(pnl)} $</span>
                    <button className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-700" onClick={() => void close(p)}>
                      <X size={13} /> Close
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-10 text-center text-sm text-slate-500">No open trades.<br />Choose an amount and press Buy or Sell.</div>
          ))}
        {tab === 'closed' &&
          (closed.length ? (
            closed.map((t) => (
              <div key={t._id} className="flex items-center gap-2 rounded-xl bg-slate-900 p-3 ring-1 ring-slate-800">
                <CoinBadge symbol={t.symbol} size={22} />
                <div className="flex-1 leading-tight">
                  <div className="text-sm font-semibold">{t.symbol}</div>
                  <div className="text-[11px] text-slate-500">{t.direction === 'LONG' ? 'Buy' : 'Sell'} · {t.exitReason}</div>
                </div>
                <span className={`font-mono text-sm font-bold ${pnlClass(t.netPnl)}`}>{fmtSigned(t.netPnl)} $</span>
              </div>
            ))
          ) : (
            <div className="py-10 text-center text-sm text-slate-500">No closed trades yet</div>
          ))}
      </div>
    </div>
  );
}

export function TradePage() {
  const { markets, prices, positions, account } = useTrader();
  const [params, setParams] = useSearchParams();
  const symbol = params.get('symbol') || markets[0]?.symbol || 'BTC/USDT';
  const [tf, setTf] = useState<Tf>('1m');
  const tfMs = TFS.find((t) => t.tf === tf)!.ms;
  const [candles, setCandles] = useState<Candle[]>([]);
  const [live, setLive] = useState<Candle | null>(null);
  const toast = useToast();
  const welcomed = useRef(false);

  useEffect(() => {
    if (params.get('welcome') && !welcomed.current) {
      welcomed.current = true;
      toast('success', 'Welcome to AfeyFX!', 'Your $10,000 demo account is ready.');
      params.delete('welcome');
      setParams(params, { replace: true });
    }
  }, [params, setParams, toast]);

  useEffect(() => {
    let alive = true;
    setCandles([]);
    setLive(null);
    api<{ candles: Candle[] }>(`/market-data/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${tf}&limit=500`)
      .then((r) => alive && setCandles(r.candles))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol, tf]);

  // Build the forming candle from streaming ticks.
  const tick = prices[symbol];
  useEffect(() => {
    if (!tick) return;
    const bucket = Math.floor(tick.timestamp / tfMs) * tfMs;
    setLive((c) => {
      if (!c || c.timestamp !== bucket) {
        const open = c?.close ?? candles[candles.length - 1]?.close ?? tick.last;
        return { timestamp: bucket, open, high: Math.max(open, tick.last), low: Math.min(open, tick.last), close: tick.last, volume: 0 };
      }
      return { ...c, high: Math.max(c.high, tick.last), low: Math.min(c.low, tick.last), close: tick.last };
    });
  }, [tick, tfMs, candles]);

  useSocketEvent<Candle & { symbol: string; timeframe: string }>('candle', (c) => {
    if (c.symbol === symbol && c.timeframe === tf) setCandles((cs) => [...cs.filter((x) => x.timestamp !== c.timestamp), { timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }].slice(-800));
  });

  const lines: PriceMarker[] = useMemo(
    () => positions.filter((p) => p.symbol === symbol).map((p) => ({ price: p.entryPrice, color: p.direction === 'LONG' ? '#22c55e' : '#ef4444', title: p.direction === 'LONG' ? 'BUY' : 'SELL' })),
    [positions, symbol],
  );
  const m = markets.find((x) => x.symbol === symbol);

  return (
    <div className="flex h-full min-h-[640px] flex-col lg:flex-row">
      <section className="relative flex min-h-[420px] min-w-0 flex-1 flex-col">
        <div className="absolute top-3 left-3 z-20 flex flex-wrap items-center gap-3">
          <AssetPicker symbol={symbol} onPick={(s) => setParams({ symbol: s })} />
          <div className="flex rounded-xl bg-slate-900/90 p-1 ring-1 ring-slate-800">
            {TFS.map((t) => (
              <button key={t.tf} onClick={() => setTf(t.tf)} className={`rounded-lg px-2.5 py-1 text-xs font-bold ${tf === t.tf ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-100'}`}>
                {t.tf}
              </button>
            ))}
          </div>
        </div>
        <div className="absolute top-[70px] left-4 z-10 flex flex-col gap-1 sm:top-4 sm:left-auto sm:right-24 sm:items-end">
          <UtcClock />
          {m && <span className="text-[11px] text-slate-500">Spread {fmtPct(m.spreadPct, 3)} · Vol 24h ${fmtNum(m.volume24h, 0)}</span>}
        </div>
        <div className="min-h-0 flex-1 pt-16">
          {candles.length ? <CandleChart candles={candles} live={live} lines={lines} fill /> : <div className="flex h-full items-center justify-center text-sm text-slate-500">Loading market data…</div>}
        </div>
      </section>
      <aside className="flex w-full shrink-0 flex-col border-t border-slate-800 bg-slate-950 lg:w-[320px] lg:border-t-0 lg:border-l">
        <div className="border-b border-slate-800 p-4">
          <OrderTicket symbol={symbol} />
        </div>
        <div className="flex min-h-[280px] flex-1 flex-col">
          <TradesPanel />
        </div>
        <div className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500">
          Available <b className="font-mono text-slate-300">${fmtNum(account?.available)}</b> · Equity <b className="font-mono text-slate-300">${fmtNum(account?.equity)}</b>
        </div>
      </aside>
    </div>
  );
}
