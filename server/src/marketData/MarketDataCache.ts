import type { Candle, OrderBook, Ticker } from '../types';

const key = (exchange: string, symbol: string) => `${exchange}:${symbol}`;
const ckey = (exchange: string, symbol: string, tf: string) => `${exchange}:${symbol}:${tf}`;

/**
 * In-memory latest-state cache with receive timestamps, used for staleness detection.
 * Candle buffers hold CLOSED candles only, sorted ascending and de-duplicated by timestamp.
 */
export class MarketDataCache {
  private tickers = new Map<string, { data: Ticker; receivedAt: number }>();
  private books = new Map<string, { data: OrderBook; receivedAt: number }>();
  private candles = new Map<string, Candle[]>();
  private extras = new Map<string, { fundingRate?: number; openInterest?: number; updatedAt: number }>();
  constructor(private maxCandles = 1000) {}

  setTicker(exchange: string, t: Ticker) {
    const prev = this.tickers.get(key(exchange, t.symbol));
    // Drop out-of-order / duplicate events.
    if (prev && t.timestamp < prev.data.timestamp) return false;
    this.tickers.set(key(exchange, t.symbol), { data: t, receivedAt: Date.now() });
    return true;
  }

  getTicker(exchange: string, symbol: string) {
    return this.tickers.get(key(exchange, symbol));
  }

  setOrderBook(exchange: string, b: OrderBook) {
    const prev = this.books.get(key(exchange, b.symbol));
    if (prev && b.timestamp < prev.data.timestamp) return false;
    this.books.set(key(exchange, b.symbol), { data: b, receivedAt: Date.now() });
    return true;
  }

  getOrderBook(exchange: string, symbol: string) {
    return this.books.get(key(exchange, symbol));
  }

  /** Merge closed candles; returns the candles that were new. */
  mergeCandles(exchange: string, symbol: string, tf: string, incoming: Candle[]): Candle[] {
    const k = ckey(exchange, symbol, tf);
    const cur = this.candles.get(k) ?? [];
    const byTs = new Map(cur.map((c) => [c.timestamp, c]));
    const added: Candle[] = [];
    for (const c of incoming) {
      if (!byTs.has(c.timestamp)) added.push(c);
      byTs.set(c.timestamp, c);
    }
    const merged = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-this.maxCandles);
    this.candles.set(k, merged);
    return added;
  }

  getCandles(exchange: string, symbol: string, tf: string): Candle[] {
    return this.candles.get(ckey(exchange, symbol, tf)) ?? [];
  }

  setExtras(exchange: string, symbol: string, e: { fundingRate?: number; openInterest?: number }) {
    this.extras.set(key(exchange, symbol), { ...e, updatedAt: Date.now() });
  }

  getExtras(exchange: string, symbol: string) {
    return this.extras.get(key(exchange, symbol));
  }

  /** Age in ms of the freshest ticker/book data for the symbol (Infinity if none). */
  dataAgeMs(exchange: string, symbol: string, now = Date.now()) {
    const t = this.tickers.get(key(exchange, symbol))?.receivedAt ?? -Infinity;
    const b = this.books.get(key(exchange, symbol))?.receivedAt ?? -Infinity;
    return now - Math.max(t, b);
  }

  clear() {
    this.tickers.clear();
    this.books.clear();
    this.candles.clear();
    this.extras.clear();
  }
}

export const marketDataCache = new MarketDataCache();
