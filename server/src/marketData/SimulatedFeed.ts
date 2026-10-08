import { TIMEFRAME_MS, type Candle, type OrderBook, type Ticker, type Timeframe } from '../types';

/**
 * DEVELOPMENT / DEMO ONLY synthetic market feed (MARKET_DATA_SOURCE=simulated).
 * Geometric random walk with volatility clustering, a realistic spread and a 20-level order book.
 * It lets the UI, paper trading and the engine run without exchange access. It is refused in
 * production and LIVE trading is impossible while it is active. Results on synthetic data say
 * nothing about real-market performance.
 */
const SEED_PRICES: Record<string, number> = {
  BTC: 65_000, ETH: 3_200, SOL: 150, BNB: 580, XRP: 0.6, ADA: 0.45, DOGE: 0.15, LTC: 80, AVAX: 30, DOT: 6.5, LINK: 15, TRX: 0.13, BCH: 450, ATOM: 7, NEAR: 5.5, UNI: 8, XLM: 0.1, TON: 6,
};
/** Approximate levels for synthetic forex/metal quotes (development only). */
const FX_SEEDS: Record<string, number> = {
  'EUR/USD': 1.085, 'GBP/USD': 1.27, 'USD/JPY': 155.2, 'USD/CHF': 0.88, 'AUD/USD': 0.66, 'USD/CAD': 1.37, 'NZD/USD': 0.6,
  'EUR/GBP': 0.854, 'EUR/JPY': 168.4, 'EUR/CHF': 0.955, 'EUR/AUD': 1.644, 'EUR/CAD': 1.486, 'EUR/NZD': 1.808,
  'GBP/JPY': 197.1, 'GBP/CHF': 1.118, 'GBP/AUD': 1.924, 'GBP/CAD': 1.74, 'GBP/NZD': 2.116,
  'AUD/JPY': 102.4, 'AUD/CAD': 0.904, 'AUD/CHF': 0.581, 'AUD/NZD': 1.1, 'CAD/JPY': 113.3, 'CAD/CHF': 0.642, 'CHF/JPY': 176.4, 'NZD/JPY': 93.1, 'NZD/CAD': 0.822, 'NZD/CHF': 0.528,
  'USD/ZAR': 18.3, 'USD/MXN': 17.6, 'USD/SGD': 1.35, 'USD/HKD': 7.81, 'USD/NOK': 10.6, 'USD/SEK': 10.5, 'USD/TRY': 33.2, 'USD/PLN': 3.95, 'USD/CNH': 7.26, 'EUR/TRY': 36.0, 'EUR/NOK': 11.5, 'EUR/SEK': 11.4, 'EUR/PLN': 4.29,
  'XAU/USD': 2_350, 'XAG/USD': 29.5, 'XPT/USD': 990, 'XPD/USD': 960,
};

interface Profile {
  seed: number;
  /** Volatility multiplier vs. crypto. */
  vol: number;
  /** Bid/ask spread as a fraction of price. */
  spread: number;
  /** Typical size per book level. */
  qty: number;
}

export function profileFor(symbol: string): Profile {
  if (FX_SEEDS[symbol] !== undefined) {
    const metal = symbol.startsWith('X');
    const exotic = /(ZAR|MXN|TRY|NOK|SEK|PLN|CNH|HKD|SGD)/.test(symbol);
    return { seed: FX_SEEDS[symbol], vol: metal ? 0.35 : exotic ? 0.25 : 0.12, spread: metal ? 0.0002 : exotic ? 0.0004 : 0.00008, qty: metal ? 200 : 2_000_000 };
  }
  const seed = SEED_PRICES[symbol.split('/')[0]] ?? 100;
  return { seed, vol: 1, spread: 0.0002, qty: seed > 1000 ? 0.4 : seed > 10 ? 15 : 8000 };
}

interface SymState {
  profile: Profile;
  price: number;
  vol: number; // per-second log-return std
  open: Map<Timeframe, Candle>;
}

export interface SimulatedFeedHandlers {
  onTicker(t: Ticker): void;
  onBook(b: OrderBook): void;
  onClosedCandles(symbol: string, tf: Timeframe, candles: Candle[]): void;
  /** The candle still forming in each timeframe, on every tick. */
  onFormingCandle?(symbol: string, tf: Timeframe, candle: Candle): void;
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
      const profile = profileFor(sym);
      const base = profile.seed;
      const series: Candle[] = [];
      let p = base;
      let vol = 0.0005 * profile.vol;
      for (let i = minutes; i >= 1; i--) {
        vol = Math.min(0.0015 * profile.vol, Math.max(0.00015 * profile.vol, vol * (1 + 0.05 * this.gauss())));
        const open = p;
        const close = open * Math.exp(vol * this.gauss());
        const high = Math.max(open, close) * (1 + Math.abs(this.gauss()) * vol * 0.4);
        const low = Math.min(open, close) * (1 - Math.abs(this.gauss()) * vol * 0.4);
        series.push({ timestamp: nowMin - i * 60_000, open, high, low, close, volume: (20 + this.rand() * 80) * (profile.qty / 8) });
        p = close;
      }
      // Anchor the walk so the latest price sits near a realistic level for the asset.
      const scale = (base * (1 - 0.02 * profile.vol + this.rand() * 0.04 * profile.vol)) / p;
      for (const c of series) {
        c.open *= scale;
        c.high *= scale;
        c.low *= scale;
        c.close *= scale;
      }
      p *= scale;
      const byTf = new Map<Timeframe, Candle[]>();
      for (const tf of this.timeframes) byTf.set(tf, aggregate(series, TIMEFRAME_MS[tf]).slice(-bars));
      out.set(sym, byTf);
      this.state.set(sym, { profile, price: p, vol: 0.00025 * profile.vol, open: new Map() });
    }
    return out;
  }

  private intervalMs = 1000;

  start(intervalMs = 1000) {
    this.intervalMs = intervalMs;
    if (!this.state.size) this.history(10);
    for (const sym of this.symbols) if (!this.state.has(sym)) this.state.set(sym, { profile: profileFor(sym), price: profileFor(sym).seed, vol: 0.00025 * profileFor(sym).vol, open: new Map() });
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  tick(now = Date.now()) {
    for (const [sym, s] of this.state) {
      const pv = s.profile.vol;
      // Per-tick volatility scaled for the tick interval (calibrated for 1s ticks).
      const scale = Math.sqrt(this.intervalMs / 1000);
      s.vol = Math.min(0.0015 * pv, Math.max(0.00008 * pv, s.vol * (1 + 0.04 * this.gauss())));
      s.price *= Math.exp(s.vol * scale * this.gauss());
      const spread = s.price * s.profile.spread;
      const bid = s.price - spread / 2;
      const ask = s.price + spread / 2;
      const qty = s.profile.qty;
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
        c.volume += qty * this.rand() * 0.2 * scale;
        s.open.set(tf, c);
        this.h.onFormingCandle?.(sym, tf, { ...c });
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
