import { Schema, model } from 'mongoose';

const marketSchema = new Schema(
  {
    exchange: { type: String, required: true },
    symbol: { type: String, required: true },
    base: String,
    quote: String,
    type: { type: String, default: 'spot' },
    active: { type: Boolean, default: true },
    enabled: { type: Boolean, default: false }, // enabled for trading/monitoring by admin
    timeframes: { type: [String], default: ['1m', '5m', '15m', '1h'] },
    minAmount: Number,
    amountPrecision: Number,
    pricePrecision: Number,
    takerFee: Number,
    makerFee: Number,
    lastPrice: Number,
    lastUpdateAt: Date,
    fundingRate: Number,
    openInterest: Number,
  },
  { timestamps: true },
);
marketSchema.index({ exchange: 1, symbol: 1 }, { unique: true });

export const Market = model('Market', marketSchema);
