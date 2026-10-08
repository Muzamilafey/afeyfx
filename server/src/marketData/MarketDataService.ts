import { env, symbolsFromEnv, timeframesFromEnv } from '../config/env';
import { exchangeRegistry } from '../exchanges/registry';
import { circuitBreaker } from '../risk/CircuitBreaker';
import { eventBus } from '../utils/eventBus';
import { logger, errorMessage } from '../utils/logger';
import { TIMEFRAME_MS, TIMEFRAMES, type Candle, type Timeframe } from '../types';
import { BinanceWsStream } from './BinanceWsStream';
import { SimulatedFeed } from './SimulatedFeed';
import { CandleStore } from './CandleStore';
import { marketDataCache } from './MarketDataCache';
import { validateCandles } from './candleUtils';
import { volatility, lastValid } from '../services/analysis/indicators';
import { Exchange } from '../models/Exchange';
import { Market } from '../models/Market';
import { cryptoSymbols } from './instruments';

export interface MarketSummary {
  exchange: string;
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  spreadPct: number;
  change24hPct?: number;
  volume24h?: number;
  volatility?: number;
  dataAgeMs: number;
  fundingRate?: number;
  openInterest?: number;
}

/**
 * Market-data engine.
 *  - Backfills closed candles over REST and persists them (idempotent upserts; no duplicates)
 *  - Streams tickers + closed klines over Binance native WebSocket (auto-reconnect, de-dup)
 *  - Polls REST as a fallback / for other exchanges; refreshes order books
 *  - Detects gaps and backfills them; rejects unclosed, misaligned or invalid candles
 *  - Tracks data freshness and exchange status, tripping the circuit breaker when stale/disconnected
 */
export class MarketDataService {
  private ws?: BinanceWsStream;
  private sim?: SimulatedFeed;
  readonly simulated = env.MARKET_DATA_SOURCE === 'simulated';
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  readonly exchange: string;
  /** Every crypto pair streamed (strategy symbols + extra pairs offered to traders). */
  readonly symbols: string[];
  /** Symbols the strategy engine trades; only these gate the circuit breaker's freshness check. */
  readonly engineSymbols: string[];
  readonly timeframes: Timeframe[];
  wsConnected = false;
  lastRestOkAt = 0;
  lastError?: string;

  constructor(exchange = env.DEFAULT_EXCHANGE, symbols = symbolsFromEnv(), timeframes = timeframesFromEnv()) {
    this.exchange = exchange;
    this.engineSymbols = symbols;
    this.symbols = [...new Set([...symbols, ...(exchange === env.DEFAULT_EXCHANGE ? cryptoSymbols() : [])])];
    this.timeframes = timeframes.filter((t): t is Timeframe => (TIMEFRAMES as readonly string[]).includes(t));
  }

  get isRunning() {
    return this.running;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    if (this.simulated) return this.startSimulated();
    await this.ensureMarkets().catch((err) => logger.warn({ err: errorMessage(err) }, 'Market registration failed'));
    for (const s of this.symbols) for (const tf of this.timeframes) await this.backfill(s, tf).catch((err) => this.onRestError(err));

    if (this.exchange === 'binance') {
      this.ws = new BinanceWsStream(this.symbols, this.timeframes, {
        onTicker: (t) => {
          // bookTicker carries bid/ask only; keep the last traded price from the trade stream.
          const cur = marketDataCache.getTicker(this.exchange, t.symbol)?.data;
          const merged = cur ? { ...cur, bid: t.bid, ask: t.ask, timestamp: t.timestamp, last: cur.last > 0 && Date.now() - cur.timestamp < 10_000 ? cur.last : t.last } : t;
          if (marketDataCache.setTicker(this.exchange, merged)) eventBus.publish('price', { exchange: this.exchange, ...merged });
        },
        onClosedCandle: (symbol, tf, c) => void this.ingestCandles(symbol, tf as Timeframe, [c], 'WS'),
        onFormingCandle: (symbol, tf, c) => eventBus.publish('candle-live', { exchange: this.exchange, symbol, timeframe: tf, ...c }),
        onTrade: (symbol, price, timestamp) => {
          const cur = marketDataCache.getTicker(this.exchange, symbol)?.data;
          if (!cur) return;
          const t = { ...cur, last: price, timestamp: Math.max(timestamp, cur.timestamp) };
          if (marketDataCache.setTicker(this.exchange, t)) eventBus.publish('price', { exchange: this.exchange, ...t });
        },
        onStatus: (connected, info) => {
          this.wsConnected = connected;
          eventBus.publish('exchange-status', { exchange: this.exchange, channel: 'ws', connected, info });
        },
      });
      this.ws.start();
    }

    this.timers.push(setInterval(() => void this.pollTickers(), 5_000));
    this.timers.push(setInterval(() => void this.pollBooks(), 3_000));
    this.timers.push(setInterval(() => void this.pollCandles(), 30_000));
    this.timers.push(setInterval(() => void this.pollExtras(), 300_000));
    this.timers.push(setInterval(() => this.checkHealth(), 5_000));
    void this.pollTickers();
    void this.pollBooks();
  }

  private async startSimulated() {
    logger.warn('MARKET_DATA_SOURCE=simulated - SYNTHETIC prices for development only; LIVE trading is disabled');
    await Exchange.updateOne({ name: this.exchange }, { $setOnInsert: { name: this.exchange, displayName: `${this.exchange} (simulated)` } }, { upsert: true }).catch(() => undefined);
    for (const s of this.symbols) {
      const [base, quote] = s.split('/');
      await Market.updateOne({ exchange: this.exchange, symbol: s }, { $set: { base, quote, type: 'spot', active: true, minAmount: 0.00001, amountPrecision: 6, pricePrecision: 2, takerFee: 0.001, makerFee: 0.001 }, $setOnInsert: { enabled: true, timeframes: this.timeframes } }, { upsert: true }).catch(() => undefined);
    }
    this.sim = new SimulatedFeed(this.symbols, this.timeframes, {
      onTicker: (t) => {
        if (marketDataCache.setTicker(this.exchange, t)) eventBus.publish('price', { exchange: this.exchange, simulated: true, ...t });
      },
      onBook: (b) => marketDataCache.setOrderBook(this.exchange, b),
      onClosedCandles: (symbol, tf, cs) => void this.ingestCandles(symbol, tf, cs, 'SYNTHETIC'),
      onFormingCandle: (symbol, tf, c) => eventBus.publish('candle-live', { exchange: this.exchange, symbol, timeframe: tf, simulated: true, ...c }),
    });
    const hist = this.sim.history(500);
    for (const [sym, byTf] of hist) {
      for (const [tf, cs] of byTf) marketDataCache.mergeCandles(this.exchange, sym, tf, cs);
      const lastMinute = byTf.get(this.timeframes[0]);
      if (lastMinute?.length) this.sim.setPrice(sym, lastMinute[lastMinute.length - 1].close);
    }
    this.wsConnected = true;
    this.sim.start(500);
    this.timers.push(
      setInterval(() => {
        this.lastRestOkAt = Date.now();
        this.checkHealth();
      }, 5_000),
    );
  }

  stop() {
    this.running = false;
    this.sim?.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.ws?.stop();
  }

  private async ensureMarkets() {
    const adapter = exchangeRegistry.public(this.exchange);
    await Exchange.updateOne({ name: this.exchange }, { $setOnInsert: { name: this.exchange, displayName: this.exchange } }, { upsert: true });
    const markets = await adapter.getMarkets();
    for (const s of this.symbols) {
      const m = markets.find((x) => x.symbol === s);
      if (!m) {
        logger.warn({ symbol: s }, 'Configured symbol not found on exchange');
        continue;
      }
      await Market.updateOne(
        { exchange: this.exchange, symbol: s },
        { $set: { base: m.base, quote: m.quote, type: m.type, active: m.active, minAmount: m.minAmount, amountPrecision: m.amountPrecision, pricePrecision: m.pricePrecision, takerFee: m.takerFee, makerFee: m.makerFee }, $setOnInsert: { enabled: true, timeframes: this.timeframes } },
        { upsert: true },
      );
    }
  }

  /** Load recent closed candles from DB, then fetch anything newer (and fill gaps) from REST. */
  async backfill(symbol: string, tf: Timeframe, bars = 500) {
    const fromDb = await CandleStore.latest(this.exchange, symbol, tf, bars);
    marketDataCache.mergeCandles(this.exchange, symbol, tf, fromDb);
    const step = TIMEFRAME_MS[tf];
    const last = fromDb[fromDb.length - 1]?.timestamp;
    const since = last ? last + step : Date.now() - bars * step;
    await this.fetchRange(symbol, tf, since);
  }

  private async fetchRange(symbol: string, tf: Timeframe, since: number) {
    const adapter = exchangeRegistry.public(this.exchange);
    const step = TIMEFRAME_MS[tf];
    let cursor = since;
    for (let guard = 0; guard < 20 && cursor + step <= Date.now(); guard++) {
      const batch = await adapter.getCandles(symbol, tf, cursor, 1000);
      this.lastRestOkAt = Date.now();
      if (!batch.length) break;
      await this.ingestCandles(symbol, tf, batch, 'REST');
      const lastTs = batch[batch.length - 1].timestamp;
      if (lastTs < cursor) break;
      cursor = lastTs + step;
      if (batch.length < 1000) break;
    }
  }

  /** Validate, de-duplicate, persist and publish closed candles. */
  async ingestCandles(symbol: string, tf: Timeframe, candles: Candle[], source: 'REST' | 'WS' | 'SYNTHETIC') {
    const { valid, rejected, gaps } = validateCandles(candles, tf);
    for (const r of rejected) if (r.reason !== 'candle not closed yet') logger.warn({ symbol, tf, reason: r.reason, ts: r.candle.timestamp }, 'Rejected candle');
    if (!valid.length) return [];
    // Detect a gap between what we already have and the new data.
    const existing = marketDataCache.getCandles(this.exchange, symbol, tf);
    const prevTs = existing[existing.length - 1]?.timestamp;
    const added = marketDataCache.mergeCandles(this.exchange, symbol, tf, valid);
    if (added.length) {
      try {
        await CandleStore.upsertMany(this.exchange, symbol, tf, added, source);
        circuitBreaker.recover('DATABASE_UNAVAILABLE');
      } catch (err) {
        circuitBreaker.trip('DATABASE_UNAVAILABLE', `Candle persistence failed: ${errorMessage(err)}`);
      }
      for (const c of added) eventBus.publish('candle', { exchange: this.exchange, symbol, timeframe: tf, ...c });
    }
    const step = TIMEFRAME_MS[tf];
    if (gaps.length || (prevTs && valid[0].timestamp - prevTs > step)) {
      const from = prevTs ? prevTs + step : gaps[0].from;
      logger.info({ symbol, tf, from }, 'Gap detected - backfilling');
      if (source === 'WS' && !this.simulated) void this.fetchRange(symbol, tf, from).catch((err) => this.onRestError(err));
    }
    return added;
  }

  private async pollTickers() {
    const adapter = exchangeRegistry.public(this.exchange);
    for (const s of this.symbols) {
      try {
        const t = await adapter.getTicker(s);
        this.lastRestOkAt = Date.now();
        circuitBreaker.recover('EXCHANGE_DISCONNECTED');
        // WS bookTicker is fresher for bid/ask; REST ticker supplies 24h stats.
        const cur = marketDataCache.getTicker(this.exchange, s);
        const merged = cur && this.wsConnected && Date.now() - cur.receivedAt < 2000 ? { ...t, bid: cur.data.bid, ask: cur.data.ask, timestamp: Math.max(t.timestamp, cur.data.timestamp) } : t;
        if (marketDataCache.setTicker(this.exchange, merged)) eventBus.publish('price', { exchange: this.exchange, ...merged });
        await Market.updateOne({ exchange: this.exchange, symbol: s }, { $set: { lastPrice: t.last, lastUpdateAt: new Date() } }).catch(() => undefined);
      } catch (err) {
        this.onRestError(err);
      }
    }
  }

  private async pollBooks() {
    const adapter = exchangeRegistry.public(this.exchange);
    for (const s of this.symbols) {
      try {
        const ob = await adapter.getOrderBook(s, 20);
        marketDataCache.setOrderBook(this.exchange, ob);
        const bid = ob.bids[0]?.price;
        const ask = ob.asks[0]?.price;
        if (bid && ask) circuitBreaker.checkSpread((ask - bid) / ((ask + bid) / 2), env.MAX_SPREAD_PCT, s);
      } catch (err) {
        this.onRestError(err);
      }
    }
  }

  private async pollCandles() {
    for (const s of this.symbols) {
      for (const tf of this.timeframes) {
        const have = marketDataCache.getCandles(this.exchange, s, tf);
        const last = have[have.length - 1]?.timestamp;
        const step = TIMEFRAME_MS[tf];
        if (last && Date.now() - last < 2 * step) continue; // up to date
        await this.fetchRange(s, tf, last ? last + step : Date.now() - 500 * step).catch((err) => this.onRestError(err));
      }
    }
  }

  private async pollExtras() {
    const adapter = exchangeRegistry.public(this.exchange);
    for (const s of this.symbols) {
      try {
        const [fundingRate, openInterest] = await Promise.all([adapter.getFundingRate?.(s).catch(() => undefined), adapter.getOpenInterest?.(s).catch(() => undefined)]);
        marketDataCache.setExtras(this.exchange, s, { fundingRate, openInterest });
      } catch {
        /* optional data */
      }
    }
  }

  private onRestError(err: unknown) {
    this.lastError = errorMessage(err);
    circuitBreaker.recordApiError(this.lastError);
    logger.warn({ component: 'market-data', err: this.lastError }, 'Market data REST error');
  }

  checkHealth() {
    const maxAge = env.MARKET_DATA_STALE_MS;
    let worst = 0;
    for (const s of this.engineSymbols) worst = Math.max(worst, marketDataCache.dataAgeMs(this.exchange, s));
    circuitBreaker.checkDataFreshness(worst, maxAge, `(${this.exchange})`);
    if (this.lastRestOkAt && Date.now() - this.lastRestOkAt > maxAge * 2 && !this.wsConnected) {
      circuitBreaker.trip('EXCHANGE_DISCONNECTED', `${this.exchange} unreachable (REST and WS)`);
      void Exchange.updateOne({ name: this.exchange }, { $set: { status: 'DISCONNECTED', lastError: this.lastError } }).catch(() => undefined);
    } else if (this.lastRestOkAt) {
      void Exchange.updateOne({ name: this.exchange }, { $set: { status: this.wsConnected || this.exchange !== 'binance' ? 'CONNECTED' : 'DEGRADED', lastHeartbeatAt: new Date() } }).catch(() => undefined);
    }
    return { worstDataAgeMs: worst, wsConnected: this.wsConnected, lastRestOkAt: this.lastRestOkAt };
  }

  summary(symbol: string, venue = this.exchange): MarketSummary | null {
    const t = marketDataCache.getTicker(venue, symbol);
    if (!t) return null;
    const candles = marketDataCache.getCandles(venue, symbol, this.timeframes.includes('1h') ? '1h' : this.timeframes[0]);
    const vol = candles.length > 30 ? lastValid(volatility(candles.map((c) => c.close), 20)) : undefined;
    const mid = (t.data.bid + t.data.ask) / 2;
    const extras = marketDataCache.getExtras(venue, symbol);
    const day = marketDataCache.getCandles(venue, symbol, this.timeframes.includes('1h') ? '1h' : this.timeframes[this.timeframes.length - 1]).slice(-24);
    const change24hPct = t.data.change24hPct ?? (day.length ? t.data.last / day[0].open - 1 : undefined);
    const volume24h = t.data.quoteVolume ?? (day.length ? day.reduce((sum, c) => sum + c.volume * c.close, 0) : undefined);
    return {
      exchange: venue,
      symbol,
      price: t.data.last,
      bid: t.data.bid,
      ask: t.data.ask,
      spreadPct: mid > 0 ? (t.data.ask - t.data.bid) / mid : NaN,
      change24hPct,
      volume24h,
      volatility: vol,
      dataAgeMs: marketDataCache.dataAgeMs(venue, symbol),
      fundingRate: extras?.fundingRate,
      openInterest: extras?.openInterest,
    };
  }
}

let instance: MarketDataService | null = null;
export const getMarketDataService = () => (instance ??= new MarketDataService());
export const setMarketDataService = (s: MarketDataService | null) => {
  instance = s;
};
