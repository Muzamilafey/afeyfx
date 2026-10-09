import { env, timeframesFromEnv } from '../config/env';
import { TIMEFRAME_MS, TIMEFRAMES, type Candle, type Timeframe } from '../types';
import { eventBus } from '../utils/eventBus';
import { errorMessage, logger } from '../utils/logger';
import { CandleStore } from './CandleStore';
import { marketDataCache } from './MarketDataCache';
import { validateCandles } from './candleUtils';
import { FOREX_VENUE, forexAvailable, forexInstruments, forexSessionOpen } from './instruments';
import { OandaClient } from './OandaClient';
import { SimulatedFeed } from './SimulatedFeed';

/**
 * Forex & metals market data (venue "oanda").
 *  - Real: OANDA v20 pricing polled every second (one request for all pairs) + mid candles.
 *    Quotes outside the trading session (weekends) or marked non-tradeable are not refreshed,
 *    so their data goes stale and orders are refused - we never trade on old prices.
 *  - Simulated (MARKET_DATA_SOURCE=simulated, development only): synthetic quotes.
 * This feed never touches the circuit breaker: forex staleness must not halt the crypto engine.
 */
export class ForexDataService {
  private timers: NodeJS.Timeout[] = [];
  private sim?: SimulatedFeed;
  private client?: OandaClient;
  private formingByKey = new Map<string, Candle>();
  running = false;
  lastOkAt = 0;
  lastError?: string;
  tradeable = new Map<string, boolean>();
  readonly timeframes: Timeframe[] = timeframesFromEnv().filter((t): t is Timeframe => (TIMEFRAMES as readonly string[]).includes(t));

  get simulated() {
    return env.MARKET_DATA_SOURCE === 'simulated';
  }

  get symbols() {
    return forexInstruments().map((i) => i.symbol);
  }

  async start() {
    if (this.running || !forexAvailable() || !this.symbols.length) return;
    this.running = true;
    if (this.simulated) return this.startSimulated();
    this.client = new OandaClient(env.OANDA_API_TOKEN, env.OANDA_ACCOUNT_ID, env.OANDA_ENV);
    void this.backfillAll();
    this.timers.push(setInterval(() => void this.pollPrices(), 1_000));
    this.timers.push(setInterval(() => void this.pollCandles(), 30_000));
    logger.info({ pairs: this.symbols.length, env: env.OANDA_ENV }, 'Forex market data (OANDA) started');
  }

  stop() {
    this.running = false;
    this.sim?.stop();
    this.sim = undefined;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async restart() {
    this.stop();
    await this.start();
  }

  private startSimulated() {
    const syms = this.symbols;
    this.sim = new SimulatedFeed(syms, this.timeframes, {
      onTicker: (t) => {
        if (marketDataCache.setTicker(FOREX_VENUE, t)) eventBus.publish('price', { exchange: FOREX_VENUE, simulated: true, ...t });
      },
      onBook: (b) => marketDataCache.setOrderBook(FOREX_VENUE, b),
      onClosedCandles: (symbol, tf, cs) => void this.ingest(symbol, tf, cs),
      onFormingCandle: (symbol, tf, c) => eventBus.publish('candle-live', { exchange: FOREX_VENUE, symbol, timeframe: tf, simulated: true, ...c }),
    });
    const hist = this.sim.history(500);
    for (const [sym, byTf] of hist) {
      for (const [tf, cs] of byTf) marketDataCache.mergeCandles(FOREX_VENUE, sym, tf, cs);
      const m1 = byTf.get(this.timeframes[0]);
      if (m1?.length) this.sim.setPrice(sym, m1[m1.length - 1].close);
      this.tradeable.set(sym, true);
    }
    this.sim.start(500);
    this.lastOkAt = Date.now();
    this.timers.push(setInterval(() => (this.lastOkAt = Date.now()), 5_000));
  }

  /** Long-timeframe chart candles straight from OANDA (null when OANDA is not in use). */
  async chartCandles(symbol: string, granularity: 'H4' | 'D' | 'W' | 'M', count: number) {
    if (!this.client) return null;
    return this.client.chartCandles(this.instrument(symbol), granularity, count);
  }

  private instrument(symbol: string) {
    return symbol.replace('/', '_');
  }

  private async backfillAll() {
    for (const s of this.symbols) {
      for (const tf of this.timeframes) {
        try {
          const fromDb = await CandleStore.latest(FOREX_VENUE, s, tf, 500);
          marketDataCache.mergeCandles(FOREX_VENUE, s, tf, fromDb);
          await this.ingest(s, tf, await this.client!.candles(this.instrument(s), tf, 500));
        } catch (err) {
          this.onError(err);
        }
      }
    }
  }

  private async pollCandles() {
    for (const s of this.symbols) {
      for (const tf of this.timeframes) {
        const have = marketDataCache.getCandles(FOREX_VENUE, s, tf);
        const last = have[have.length - 1]?.timestamp;
        if (last && Date.now() - last < 2 * TIMEFRAME_MS[tf]) continue;
        try {
          await this.ingest(s, tf, await this.client!.candles(this.instrument(s), tf, 50));
        } catch (err) {
          this.onError(err);
        }
      }
    }
  }

  private async pollPrices() {
    if (!this.client) return;
    try {
      const prices = await this.client.pricing(this.symbols.map((s) => this.instrument(s)));
      this.lastOkAt = Date.now();
      const open = forexSessionOpen();
      for (const p of prices) {
        const symbol = p.instrument.replace('_', '/');
        this.tradeable.set(symbol, p.tradeable && open);
        if (!p.tradeable || !open) continue; // closed market: let the data age (orders refused)
        const now = Date.now();
        const mid = (p.bid + p.ask) / 2;
        if (marketDataCache.setTicker(FOREX_VENUE, { symbol, timestamp: Math.max(p.time, now - 1), bid: p.bid, ask: p.ask, last: mid })) eventBus.publish('price', { exchange: FOREX_VENUE, symbol, timestamp: now, bid: p.bid, ask: p.ask, last: mid });
        // Book from OANDA's quoted liquidity bands.
        marketDataCache.setOrderBook(FOREX_VENUE, { symbol, timestamp: now, bids: p.bids.map((b) => ({ price: b.price, amount: b.liquidity })), asks: p.asks.map((a) => ({ price: a.price, amount: a.liquidity })) });
        this.updateForming(symbol, mid, now);
      }
    } catch (err) {
      this.onError(err);
    }
  }

  /** OANDA has no candle stream: build the forming candle from quotes so charts move tick by tick. */
  private updateForming(symbol: string, price: number, now: number) {
    for (const tf of this.timeframes) {
      const step = TIMEFRAME_MS[tf];
      const bucket = Math.floor(now / step) * step;
      const key = `${symbol}:${tf}`;
      let c = this.formingByKey.get(key);
      if (!c || c.timestamp !== bucket) {
        const prev = marketDataCache.getCandles(FOREX_VENUE, symbol, tf).at(-1);
        const open = c?.close ?? prev?.close ?? price;
        c = { timestamp: bucket, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: 0 };
      } else c = { ...c, high: Math.max(c.high, price), low: Math.min(c.low, price), close: price, volume: c.volume + 1 };
      this.formingByKey.set(key, c);
      eventBus.publish('candle-live', { exchange: FOREX_VENUE, symbol, timeframe: tf, ...c });
    }
  }

  private async ingest(symbol: string, tf: Timeframe, candles: Candle[]) {
    const { valid } = validateCandles(candles, tf);
    if (!valid.length) return;
    const added = marketDataCache.mergeCandles(FOREX_VENUE, symbol, tf, valid);
    if (!added.length) return;
    await CandleStore.upsertMany(FOREX_VENUE, symbol, tf, added, this.simulated ? 'SYNTHETIC' : 'REST').catch((err) => this.onError(err));
    for (const c of added) eventBus.publish('candle', { exchange: FOREX_VENUE, symbol, timeframe: tf, ...c });
  }

  private onError(err: unknown) {
    this.lastError = errorMessage(err);
    logger.warn({ component: 'forex-data', err: this.lastError }, 'Forex market data error');
  }

  /** Whether a pair can be traded right now (session open, venue says tradeable, fresh quote). */
  isTradeable(symbol: string) {
    return (this.tradeable.get(symbol) ?? false) && marketDataCache.dataAgeMs(FOREX_VENUE, symbol) < env.MARKET_DATA_STALE_MS;
  }
}

export const forexDataService = new ForexDataService();
