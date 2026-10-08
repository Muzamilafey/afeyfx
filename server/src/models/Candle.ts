import { Schema, model } from 'mongoose';

/**
 * OHLCV candle. The unique compound index on (exchange, symbol, timeframe, timestamp)
 * prevents duplicate candles; writes are idempotent upserts.
 */
const candleSchema = new Schema(
  {
    exchange: { type: String, required: true },
    symbol: { type: String, required: true },
    timeframe: { type: String, required: true },
    timestamp: { type: Number, required: true }, // open time, epoch ms UTC
    open: { type: Number, required: true },
    high: { type: Number, required: true },
    low: { type: Number, required: true },
    close: { type: Number, required: true },
    volume: { type: Number, required: true },
    closed: { type: Boolean, default: true },
    source: { type: String, enum: ['REST', 'WS', 'IMPORT', 'SYNTHETIC'], default: 'REST' },
  },
  { versionKey: false },
);
candleSchema.index({ exchange: 1, symbol: 1, timeframe: 1, timestamp: 1 }, { unique: true });

export const CandleModel = model('Candle', candleSchema);
