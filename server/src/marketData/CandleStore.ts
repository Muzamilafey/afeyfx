import { CandleModel } from '../models/Candle';
import type { Candle } from '../types';

/** MongoDB persistence for candles. Writes are idempotent upserts keyed by the unique index. */
export const CandleStore = {
  async upsertMany(exchange: string, symbol: string, timeframe: string, candles: Candle[], source: 'REST' | 'WS' | 'IMPORT' | 'SYNTHETIC' = 'REST') {
    if (!candles.length) return { upserted: 0, modified: 0 };
    const ops = candles.map((c) => ({
      updateOne: {
        filter: { exchange, symbol, timeframe, timestamp: c.timestamp },
        update: { $set: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, closed: true, source } },
        upsert: true,
      },
    }));
    const r = await CandleModel.bulkWrite(ops, { ordered: false });
    return { upserted: r.upsertedCount, modified: r.modifiedCount };
  },

  async range(exchange: string, symbol: string, timeframe: string, from?: number, to?: number, limit = 100_000): Promise<Candle[]> {
    const q: Record<string, unknown> = { exchange, symbol, timeframe };
    if (from !== undefined || to !== undefined) q.timestamp = { ...(from !== undefined ? { $gte: from } : {}), ...(to !== undefined ? { $lte: to } : {}) };
    const docs = await CandleModel.find(q, { _id: 0, timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }).sort({ timestamp: 1 }).limit(limit).lean();
    return docs as Candle[];
  },

  async latest(exchange: string, symbol: string, timeframe: string, limit = 500): Promise<Candle[]> {
    const docs = await CandleModel.find({ exchange, symbol, timeframe }, { _id: 0, timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }).sort({ timestamp: -1 }).limit(limit).lean();
    return (docs as Candle[]).reverse();
  },

  async lastTimestamp(exchange: string, symbol: string, timeframe: string): Promise<number | null> {
    const d = await CandleModel.findOne({ exchange, symbol, timeframe }).sort({ timestamp: -1 }).select({ timestamp: 1 }).lean();
    return d ? (d.timestamp as number) : null;
  },
};
