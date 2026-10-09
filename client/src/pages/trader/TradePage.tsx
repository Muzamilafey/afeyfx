import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronDown, Clock, Minus, Plus, Search, X } from 'lucide-react';
import { CandleChart, type PriceMarker } from '../../charts/CandleChart';
import { useToast } from '../../components/Toaster';
import { useAuth } from '../../hooks/useAuth';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { CHART_TFS, useChartCandles, type ChartTf } from '../../hooks/useChartCandles';
import { livePnl, pricePrecision, useTrader } from '../../hooks/useTrader';
import { useFeatures } from '../../hooks/useFeatures';
import { MarketIcon } from '../../components/MarketIcon';
import { api } from '../../services/api';
import { fmtNum, fmtPct, fmtPriceDp, fmtSigned, pnlClass } from '../../utils/format';
import type { Position, Trade } from '../../types';


const TF_TITLE: Record<ChartTf, string> = { '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour', '4h': '4 hours', '1d': '1 day', '1w': '1 week (from Monday, UTC)', '1M': '1 month (UTC)' };

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

const CAT_LABEL: Record<string, string> = { crypto: 'Crypto', forex: 'Forex', metals: 'Metals' };

function AssetPicker({ symbol, onPick }: { symbol: string; onPick(s: string): void }) {
  const { markets, prices } = useTrader();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const cats = [...new Set(markets.map((m) => m.category ?? 'crypto'))];
  const [cat, setCat] = useState<string>('all');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const m = markets.find((x) => x.symbol === symbol);
  const list = markets.filter((x) => (cat === 'all' || (x.category ?? 'crypto') === cat) && (x.symbol.replace('/', '').includes(q.replace('/', '')) || (x.name ?? '').toUpperCase().includes(q)));
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex min-w-56 items-center gap-3 rounded-xl bg-slate-900/90 px-3 py-2 text-left ring-1 ring-slate-800 backdrop-blur hover:ring-slate-700" aria-haspopup="listbox">
        <MarketIcon symbol={symbol} />
        <div className="flex-1 leading-tight">
          <div className="font-bold text-slate-50">{symbol}</div>
          <div className={`text-xs font-semibold ${pnlClass(m?.change24hPct)}`}>
            {m?.marketOpen === false ? <span className="text-amber-400">Market closed</span> : <>{fmtPct(m?.change24hPct)} 24h</>}
          </div>
        </div>
        <ChevronDown size={16} className="text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-40 mt-2 w-[22rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-2xl">
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-slate-950 px-2">
            <Search size={14} className="text-slate-500" />
            <input autoFocus className="h-9 flex-1 bg-transparent text-sm outline-none" placeholder="Search EUR/USD, gold, bitcoin…" value={q} onChange={(e) => setQ(e.target.value.toUpperCase())} />
          </div>
          {cats.length > 1 && (
            <div className="mb-2 flex gap-1 text-xs" role="tablist">
              {['all', ...cats].map((c) => (
                <button key={c} role="tab" aria-selected={cat === c} onClick={() => setCat(c)} className={`rounded-lg px-3 py-1 font-semibold ${cat === c ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
                  {c === 'all' ? 'All' : CAT_LABEL[c] ?? c}
                </button>
              ))}
            </div>
          )}
          <div className="max-h-80 overflow-auto" role="listbox">
            {list.map((x) => (
              <button key={x.symbol} role="option" aria-selected={x.symbol === symbol} onClick={() => (onPick(x.symbol), setOpen(false))} className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-slate-800 ${x.symbol === symbol ? 'bg-slate-800' : ''}`}>
                <MarketIcon symbol={x.symbol} size={28} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block text-sm font-semibold">{x.symbol}</span>
                  <span className="block truncate text-[11px] text-slate-500">{x.name}</span>
                </span>
                <span className="font-mono text-xs text-slate-300">{x.unavailable ? '—' : fmtPriceDp(prices[x.symbol]?.last ?? x.price, x.pricePrecision)}</span>
                <span className={`w-14 text-right text-xs font-semibold ${x.marketOpen === false ? 'text-amber-400' : pnlClass(x.change24hPct)}`}>{x.marketOpen === false ? 'Closed' : fmtPct(x.change24hPct)}</span>
              </button>
            ))}
            {!list.length && <div className="py-6 text-center text-sm text-slate-500">No markets found</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** @deprecated use MarketIcon */
export const CoinBadge = MarketIcon;

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

type Sizing = 'lots' | 'usd';
const LOT_PRESETS = [0.01, 0.05, 0.1, 0.5];

/**
 * Order ticket. Forex & metals trade in standard lots (1.00 lot = 100,000 units of the base
 * currency; gold 100 oz) with stops in pips, like MT4/MT5; crypto trades by USD amount. Every
 * figure is in USD at live prices: pip value, the funds the position needs (positions are fully
 * funded, 1:1), spread, commission, and the P&L at the stop and at the target.
 */
function OrderTicket({ symbol }: { symbol: string }) {
  const { account, accountType, prices, markets, reloadAccount, reloadPositions, openDeposit } = useTrader();
  const { features } = useFeatures();
  const { user } = useAuth();
  const toast = useToast();
  const isReal = accountType === 'REAL';
  const market = markets.find((m) => m.symbol === symbol);
  const dp = pricePrecision(markets, symbol);
  const lotCapable = !!market?.contractSize && !!market?.pipSize;
  const [sizingPref, setSizing] = useState<Sizing>('lots');
  const sizing: Sizing = lotCapable ? sizingPref : 'usd';
  const [investment, setInvestment] = useState(100);
  const [lots, setLots] = useState(0.01);
  const [sl, setSl] = useState(0.02);
  const [tpOn, setTpOn] = useState(true);
  const [tp, setTp] = useState(0.04);
  const [slPips, setSlPips] = useState(20);
  const [tpPips, setTpPips] = useState(40);
  const [busy, setBusy] = useState<'LONG' | 'SHORT' | null>(null);
  const tick = prices[symbol];
  const price = tick?.last ?? market?.price;
  const bid = tick?.bid ?? market?.bid;
  const ask = tick?.ask ?? market?.ask;
  const quoteUsd = market?.quoteUsd ?? (market?.quote === 'USD' || market?.quote === 'USDT' ? 1 : null);
  const feeRate = market?.feeRate ?? 0.001;

  // Everything below is in USD.
  const pipSize = market?.pipSize ?? 0;
  const units = sizing === 'lots' ? lots * (market?.contractSize ?? 0) : price && quoteUsd ? investment / quoteUsd / price : 0;
  const notional = price && quoteUsd ? units * price * quoteUsd : sizing === 'usd' ? investment : 0;
  const slPct = sizing === 'lots' && price ? (slPips * pipSize) / price : sl;
  const tpPct = sizing === 'lots' && price ? (tpPips * pipSize) / price : tp;
  const pipValue = quoteUsd && pipSize ? units * pipSize * quoteUsd : null;
  const spreadCost = bid && ask && quoteUsd ? units * (ask - bid) * quoteUsd : 0;
  const fees = notional * feeRate * 2;
  const lossAtStop = notional * slPct + fees + spreadCost;
  const profitAtTarget = notional * tpPct - fees - spreadCost;
  const needed = notional;

  const blocked = !user?.emailVerified
    ? 'Verify your email to trade'
    : isReal && !features.realTrading
      ? 'Real-account trading is not open yet'
      : market?.marketOpen === false
        ? 'Market closed — forex trades Sunday 21:00 to Friday 21:00 UTC'
        : !price || !quoteUsd
          ? 'Waiting for market data'
          : needed > (account?.available ?? 0)
            ? `Insufficient ${isReal ? '' : 'demo '}balance: this trade needs $${fmtNum(needed)}`
            : null;

  const place = async (direction: 'LONG' | 'SHORT') => {
    setBusy(direction);
    try {
      const size = sizing === 'lots' ? { lots } : { investment };
      const r = await api<{ position: Position }>('/account/orders', { method: 'POST', body: { account: accountType, symbol, direction, ...size, stopLossPct: slPct, takeProfitPct: tpOn ? tpPct : undefined, idempotencyKey: crypto.randomUUID() } });
      const what = r.position.lots ? `${fmtNum(r.position.lots, 2)} lot${r.position.lots === 1 ? '' : 's'}` : fmtNum(r.position.amount, market?.category === 'crypto' ? 6 : 2);
      toast('success', `${direction === 'LONG' ? 'Buy' : 'Sell'} ${symbol} filled`, `${what} @ ${fmtPriceDp(r.position.entryPrice, dp)}${isReal ? ' · Real account' : ''}`);
      await Promise.all([reloadPositions(), reloadAccount()]);
    } catch (e) {
      toast('error', 'Order rejected', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const row = (label: string, value: ReactNode, cls = 'text-slate-200') => (
    <div className="flex justify-between">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono ${cls}`}>{value}</span>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-bold text-slate-50">
          <MarketIcon symbol={symbol} size={24} /> {symbol}
        </span>
        <span className="font-mono text-sm text-slate-300">{fmtPriceDp(price, dp)}</span>
      </div>
      {lotCapable && (
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-900 p-1 text-xs" role="tablist" aria-label="Order size in">
          {(['lots', 'usd'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={sizing === m} onClick={() => setSizing(m)} className={`rounded-md py-1.5 font-semibold ${sizing === m ? 'bg-slate-700 text-slate-50' : 'text-slate-400 hover:text-slate-200'}`}>
              {m === 'lots' ? 'Lots' : 'Amount ($)'}
            </button>
          ))}
        </div>
      )}
      {sizing === 'lots' ? (
        <>
          <Stepper label="Volume (lots)" value={lots} onChange={(v) => setLots(Math.max(0.01, Math.round(v * 100) / 100))} step={0.01} min={0.01} max={100} format={(v) => v.toFixed(2)} hint={`${fmtNum(units, 0)} ${market?.base ?? ''}${market?.category === 'metals' ? ' oz' : ''}`} />
          <div className="grid grid-cols-4 gap-1.5">
            {LOT_PRESETS.map((v) => (
              <button key={v} className={`rounded-lg py-1 text-xs font-semibold ${lots === v ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`} onClick={() => setLots(v)}>
                {v.toFixed(2)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Stepper label="Stop loss (pips)" value={slPips} onChange={(v) => setSlPips(Math.round(v))} step={5} min={1} max={5000} format={(v) => fmtNum(v, 0)} hint={pipValue ? `-$${fmtNum(slPips * pipValue)}` : undefined} />
            <div className={tpOn ? '' : 'opacity-50'}>
              <Stepper label="Take profit (pips)" value={tpPips} onChange={(v) => setTpPips(Math.round(v))} step={5} min={1} max={10000} format={(v) => fmtNum(v, 0)} hint={pipValue ? `+$${fmtNum(tpPips * pipValue)}` : undefined} />
            </div>
          </div>
        </>
      ) : (
        <>
          <Stepper label="Investment" value={investment} onChange={setInvestment} step={10} min={10} max={100_000} format={(v) => `$${fmtNum(v, 0)}`} />
          <div className="grid grid-cols-4 gap-1.5">
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
        </>
      )}
      <label className="flex items-center justify-between text-xs text-slate-400">
        Take profit
        <input type="checkbox" checked={tpOn} onChange={(e) => setTpOn(e.target.checked)} className="h-4 w-4 accent-sky-500" />
      </label>
      <div className="space-y-1 rounded-lg bg-slate-900 p-2.5 text-xs">
        {sizing === 'lots' ? row('Units', `${fmtNum(units, 0)}${market?.category === 'metals' ? ' oz' : ` ${market?.base ?? ''}`}`) : row('Units', price ? fmtNum(units, market?.category === 'crypto' ? 6 : 2) : '—')}
        {pipValue !== null && row('Pip value', `$${fmtNum(pipValue, pipValue < 1 ? 4 : 2)}`)}
        {row('Funds required (1:1)', `$${fmtNum(needed)}`)}
        {row('Max loss at stop ≈', `-$${fmtNum(lossAtStop)}`, 'text-red-400')}
        {tpOn && row('Profit at target ≈', `${profitAtTarget >= 0 ? '+' : '-'}$${fmtNum(Math.abs(profitAtTarget))}`, profitAtTarget >= 0 ? 'text-emerald-400' : 'text-red-400')}
        {row('Spread + fees', `$${fmtNum(spreadCost + fees)}`, 'text-slate-300')}
      </div>
      <button className="flex h-14 w-full items-center justify-between rounded-xl bg-emerald-500 px-5 text-lg font-bold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-400 disabled:opacity-50" disabled={!!blocked || !!busy} onClick={() => place('LONG')}>
        {busy === 'LONG' ? 'Placing…' : 'Buy'} <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/25"><ArrowUp size={16} /></span>
      </button>
      <button className="flex h-14 w-full items-center justify-between rounded-xl bg-red-500 px-5 text-lg font-bold text-white shadow-lg shadow-red-900/30 transition hover:bg-red-400 disabled:opacity-50" disabled={!!blocked || !!busy} onClick={() => place('SHORT')}>
        {busy === 'SHORT' ? 'Placing…' : 'Sell'} <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/25"><ArrowDown size={16} /></span>
      </button>
      {blocked && <div className="text-center text-xs text-amber-400">{blocked}</div>}
      {isReal && features.deposits && (account?.available ?? 0) < needed && (
        <button className="w-full rounded-lg bg-emerald-500/15 py-2 text-sm font-bold text-emerald-400 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25" onClick={openDeposit}>
          + Deposit with M-Pesa
        </button>
      )}
      <p className="text-center text-[10px] leading-snug text-slate-500">
        {sizing === 'lots' ? 'Positions are fully funded (no leverage): 1 lot needs its full value. ' : ''}
        {isReal ? 'Real account · real money. Fills at the live bid/ask incl. commission. Trading involves risk of loss.' : 'Demo account · virtual funds. Simulated fills include spread, commission and slippage.'}
      </p>
    </div>
  );
}

function TradesPanel() {
  const { positions, prices, markets, accountType, reloadPositions, reloadAccount } = useTrader();
  const toast = useToast();
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [closed, setClosed] = useState<Trade[]>([]);
  const loadClosed = () => api<{ trades: Trade[] }>(`/account/history?limit=30&account=${accountType}`).then((r) => setClosed(r.trades), () => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void loadClosed(), [accountType]);
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
                    <MarketIcon symbol={p.symbol} size={22} />
                    <span className="flex-1 truncate text-sm font-semibold">{p.symbol}</span>
                    <span className={`flex items-center gap-0.5 text-xs font-bold ${p.direction === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>
                      {p.direction === 'LONG' ? <ArrowUp size={13} /> : <ArrowDown size={13} />} {p.direction === 'LONG' ? 'BUY' : 'SELL'}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-slate-400">
                    <span>Entry <b className="font-mono text-slate-200">{fmtPriceDp(p.entryPrice, pricePrecision(markets, p.symbol))}</b></span>
                    <span className="text-right">{p.lots ? <>Lots <b className="font-mono text-slate-200">{fmtNum(p.lots, 2)}</b></> : <>Size <b className="font-mono text-slate-200">${fmtNum(p.entryPrice * p.amount * (p.quoteRate ?? 1), 0)}</b></>}</span>
                    <span>SL <b className="font-mono text-red-400">{fmtPriceDp(p.stopLoss, pricePrecision(markets, p.symbol))}</b></span>
                    <span className="text-right">TP <b className="font-mono text-emerald-400">{fmtPriceDp(p.takeProfit, pricePrecision(markets, p.symbol))}</b></span>
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
                <MarketIcon symbol={t.symbol} size={22} />
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
  const [tf, setTf] = useState<ChartTf>('1m');
  const { candles, live, loading } = useChartCandles(symbol, tf, prices[symbol]);
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

  const lines: PriceMarker[] = useMemo(
    () => positions.filter((p) => p.symbol === symbol).map((p) => ({ price: p.entryPrice, color: p.direction === 'LONG' ? '#22c55e' : '#ef4444', title: p.direction === 'LONG' ? 'BUY' : 'SELL' })),
    [positions, symbol],
  );
  const m = markets.find((x) => x.symbol === symbol);

  return (
    <div className="flex h-full min-h-[640px] flex-col lg:flex-row">
      <section className="relative flex min-h-[420px] min-w-0 flex-1 flex-col">
        <div className="z-20 flex flex-wrap items-center gap-2 p-2 sm:absolute sm:top-3 sm:left-3 sm:gap-3 sm:p-0">
          <AssetPicker symbol={symbol} onPick={(s) => setParams({ symbol: s })} />
          <div className="flex rounded-xl bg-slate-900/90 p-1 ring-1 ring-slate-800">
            {CHART_TFS.map((t) => (
              <button key={t.tf} onClick={() => setTf(t.tf)} title={TF_TITLE[t.tf]} aria-pressed={tf === t.tf} className={`rounded-lg px-2 py-1 text-xs font-bold sm:px-2.5 ${tf === t.tf ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-100'}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="absolute top-4 right-24 z-10 hidden flex-col items-end gap-1 sm:flex">
          <UtcClock />
          {m && <span className="text-[11px] text-slate-500">{m.name ? `${m.name} · ` : ''}Spread {fmtPct(m.spreadPct, 3)}{m.category === 'crypto' ? ` · Vol 24h $${fmtNum(m.volume24h, 0)}` : ''}</span>}
        </div>
        <div className="min-h-[340px] flex-1 sm:min-h-0 sm:pt-16">
          {candles.length ? <CandleChart candles={candles} live={live} lines={lines} fill precision={pricePrecision(markets, symbol)} /> : <div className="flex h-full items-center justify-center text-sm text-slate-500">{loading ? 'Loading market data…' : 'No candles for this timeframe yet'}</div>}
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
