import { TIMEFRAME_MS, type Candle, type OrderBook, type Ticker, type Timeframe } from '../types';

/**
 * DEVELOPMENT / DEMO ONLY synthetic market feed (MARKET_DATA_SOURCE=simulated).
 * Geometric random walk with volatility clustering, a realistic spread and a 20-level order book.
 * It lets the UI, paper trading and the engine run without exchange access. It is refused in
 * production and LIVE trading is impossible while it is active. Results on synthetic data say
 * nothing about real-market performance.
 */
const SEED_PRICES: Record<string, number> = { BTC: 65_000, ETH: 3_200, SOL: 150, BNB: 580, XRP: 0.6, ADA: 0.45, DOGE: 0.15 };

interface SymState {
  price: number;
  vol: number; // per-second log-return std
  open: Map<Timeframe, Candle>;
}

export interface SimulatedFeedHandlers {
  onTicker(t: Ticker): void;
  onBook(b: OrderBook): void;
  onClosedCandles(symbol: string, tf: Timeframe, candles: Candle[]): void;
}

export class SimulatedFeed {
  private state = new Map<string, SymState>();
  private timer?: NodeJS.Timeout;
  private rand: () => number;

  constructor(
    private symbols: string[],
    private timeframes: Timeframe[],
    private h: SimulatedFeedHandlers,
    seed = Date.now() % 2 ** 31,
  ) {
    let a = seed >>> 0;
    this.rand = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  private gauss() {
    const u = Math.max(this.rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }

  /** Build closed-candle history for every timeframe from one 1-minute random walk ending now. */
  history(bars = 500): Map<string, Map<Timeframe, Candle[]>> {
    const out = new Map<string, Map<Timeframe, Candle[]>>();
    const maxTfMin = Math.max(...this.timeframes.map((t) => TIMEFRAME_MS[t] / 60_000));
    const minutes = Math.min(bars * maxTfMin, 200_000);
    const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
    for (const sym of this.symbols) {
      const base = SEED_PRICES[sym.split('/')[0]] ?? 100;
      const series: Candle[] = [];
      let p = base * (0.85 + this.rand() * 0.3);
      let vol = 0.0012;
      for (let i = minutes; i >= 1; i--) {
        vol = Math.min(0.006, Math.max(0.0004, vol * (1 + 0.05 * this.gauss())));
        const open = p;
        const close = open * Math.exp(vol * this.gauss());
        const high = Math.max(open, close) * (1 + Math.abs(this.gauss()) * vol * 0.4);
        const low = Math.min(open, close) * (1 - Math.abs(this.gauss()) * vol * 0.4);
        series.push({ timestamp: nowMin - i * 60_000, open, high, low, close, volume: (20 + this.rand() * 80) * (base > 1000 ? 0.05 : base > 10 ? 2 : 2000) });
        p = close;
      }
      const byTf = new Map<Timeframe, Candle[]>();
      for (const tf of this.timeframes) byTf.set(tf, aggregate(series, TIMEFRAME_MS[tf]).slice(-bars));
      out.set(sym, byTf);
      this.state.set(sym, { price: p, vol: 0.00025, open: new Map() });
    }
    return out;
  }

  start(intervalMs = 1000) {
    if (!this.state.size) this.history(10);
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  tick(now = Date.now()) {
    for (const [sym, s] of this.state) {
      s.vol = Math.min(0.0015, Math.max(0.00008, s.vol * (1 + 0.04 * this.gauss())));
      s.price *= Math.exp(s.vol * this.gauss());
      const spread = s.price * 0.0002;
      const bid = s.price - spread / 2;
      const ask = s.price + spread / 2;
      const qty = s.price > 1000 ? 0.4 : s.price > 10 ? 15 : 8000;
      this.h.onTicker({ symbol: sym, timestamp: now, last: s.price, bid, ask });
      this.h.onBook({
        symbol: sym,
        timestamp: now,
        bids: Array.from({ length: 20 }, (_, i) => ({ price: bid * (1 - i * 0.0001), amount: qty * (1 + this.rand() * 2) })),
        asks: Array.from({ length: 20 }, (_, i) => ({ price: ask * (1 + i * 0.0001), amount: qty * (1 + this.rand() * 2) })),
      });
      for (const tf of this.timeframes) {
        const step = TIMEFRAME_MS[tf];
        const bucket = Math.floor(now / step) * step;
        let c = s.open.get(tf);
        if (c && c.timestamp !== bucket) {
          this.h.onClosedCandles(sym, tf, [c]);
          c = undefined;
        }
        if (!c) c = { timestamp: bucket, open: s.price, high: s.price, low: s.price, close: s.price, volume: 0 };
        c.high = Math.max(c.high, s.price);
        c.low = Math.min(c.low, s.price);
        c.close = s.price;
        c.volume += qty * this.rand() * 0.2;
        s.open.set(tf, c);
      }
    }
  }

  /** Seed the live walk from the last historical close so the chart is continuous. */
  setPrice(symbol: string, price: number) {
    const s = this.state.get(symbol);
    if (s) s.price = price;
  }
}

export function aggregate(minutes: Candle[], stepMs: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const m of minutes) {
    const b = Math.floor(m.timestamp / stepMs) * stepMs;
    if (!cur || cur.timestamp !== b) {
      if (cur) out.push(cur);
      cur = { timestamp: b, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume };
    } else {
      cur.high = Math.max(cur.high, m.high);
      cur.low = Math.min(cur.low, m.low);
      cur.close = m.close;
      cur.volume += m.volume;
    }
  }
  // Drop the last bucket if it is not complete (closed candles only).
  if (cur && cur.timestamp + stepMs <= Math.floor(Date.now() / 60_000) * 60_000) out.push(cur);
  return out;
}
