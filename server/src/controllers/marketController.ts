import type { Request, Response } from 'express';
import { z } from 'zod';
import { Market } from '../models/Market';
import { getMarketDataService } from '../marketData/MarketDataService';
import { marketDataCache } from '../marketData/MarketDataCache';
import { CandleStore } from '../marketData/CandleStore';
import { marketRegimeService } from '../services/analysis/MarketRegimeService';
import { technicalAnalysis } from '../services/analysis/TechnicalAnalysisService';
import { TIMEFRAMES, type Timeframe } from '../types';
import { AppError } from '../utils/errors';
import { audit } from '../services/AuditService';
import { FOREX_VENUE, instruments, precisionFor, venueOf } from '../marketData/instruments';
import { forexDataService } from '../marketData/ForexDataService';

export const marketSchemas = {
  update: z.object({ enabled: z.boolean().optional(), timeframes: z.array(z.enum(TIMEFRAMES)).optional() }),
};

const tfParam = (v: unknown): Timeframe => {
  const tf = String(v ?? '1h');
  if (!(TIMEFRAMES as readonly string[]).includes(tf)) throw new AppError(400, 'Invalid timeframe');
  return tf as Timeframe;
};
const symParam = (v: unknown) => {
  const s = String(v ?? '');
  if (!/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/.test(s)) throw new AppError(400, 'Invalid symbol');
  return s;
};

export const marketController = {
  async list(_req: Request, res: Response) {
    res.json({ markets: await Market.find().sort({ symbol: 1 }).lean() });
  },
  async update(req: Request, res: Response) {
    const m = await Market.findByIdAndUpdate(req.params.id, { $set: req.body }, { returnDocument: 'after' });
    if (!m) throw new AppError(404, 'Market not found');
    await audit(req, { action: 'MARKET_UPDATED', resource: 'market', resourceId: m._id.toString(), details: req.body });
    res.json({ market: m });
  },
};

export const marketDataController = {
  /** Every tradable instrument (crypto, forex, metals) with its latest quote and metadata. */
  summary(_req: Request, res: Response) {
    const md = getMarketDataService();
    const markets = instruments().map((i) => {
      const s = md.summary(i.symbol, i.venue);
      const open = i.venue === FOREX_VENUE ? forexDataService.isTradeable(i.symbol) : true;
      const meta = { category: i.category, name: i.name, base: i.base, quote: i.quote, pricePrecision: i.category === 'crypto' ? precisionFor(i.symbol, s?.price) : i.pricePrecision, marketOpen: open };
      return s ? { ...s, ...meta } : { symbol: i.symbol, exchange: i.venue, unavailable: true, ...meta };
    });
    res.json({ simulated: md.simulated, exchange: md.exchange, running: md.isRunning, wsConnected: md.wsConnected, categories: [...new Set(markets.map((m) => m.category))], markets });
  },

  async candles(req: Request, res: Response) {
    const symbol = symParam(req.query.symbol);
    const tf = tfParam(req.query.timeframe);
    const limit = Math.min(Number(req.query.limit ?? 300), 2000);
    const venue = venueOf(symbol);
    let candles = marketDataCache.getCandles(venue, symbol, tf).slice(-limit);
    if (candles.length < limit) {
      const stored = await CandleStore.latest(venue, symbol, tf, limit);
      if (stored.length > candles.length) candles = stored;
    }
    res.json({ symbol, timeframe: tf, candles });
  },

  orderbook(req: Request, res: Response) {
    const symbol = symParam(req.query.symbol);
    const ob = marketDataCache.getOrderBook(venueOf(symbol), symbol);
    if (!ob) throw new AppError(404, 'No order book data');
    res.json({ ...ob.data, ageMs: Date.now() - ob.receivedAt });
  },

  analysis(req: Request, res: Response) {
    const symbol = symParam(req.query.symbol);
    const tf = tfParam(req.query.timeframe);
    const candles = marketDataCache.getCandles(venueOf(symbol), symbol, tf);
    if (candles.length < 60) throw new AppError(409, 'Not enough candle data yet');
    const regime = marketRegimeService.detect(candles);
    const indicators = technicalAnalysis.snapshot(candles, { indicators: ['sma', 'ema', 'rsi', 'macd', 'bollinger', 'atr', 'adx', 'stochastic', 'vwap', 'obv', 'volume', 'supportResistance', 'volatility', 'momentum'], vwapSessionMs: 86_400_000 });
    res.json({ symbol, timeframe: tf, regime, indicators, lastCandle: candles[candles.length - 1] });
  },
};
