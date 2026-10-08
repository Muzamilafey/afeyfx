import { Schema, model } from 'mongoose';

const portfolioSchema = new Schema(
  {
    mode: { type: String, enum: ['PAPER', 'LIVE'], required: true },
    /** null = the system (strategy) book; a user id = that user's personal demo account. */
    owner: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    baseCurrency: { type: String, default: 'USDT' },
    startingBalance: { type: Number, default: 0 },
    balance: { type: Number, default: 0 }, // cash
    equity: { type: Number, default: 0 },
    available: { type: Number, default: 0 },
    unrealizedPnl: { type: Number, default: 0 },
    realizedPnl: { type: Number, default: 0 },
    fees: { type: Number, default: 0 },
    exposure: { type: Number, default: 0 },
    peakEquity: { type: Number, default: 0 },
    drawdown: { type: Number, default: 0 },
    dayStartEquity: Number,
    dayStartAt: Date,
    weekStartEquity: Number,
    weekStartAt: Date,
    lastExchangeBalance: Number,
  },
  { timestamps: true },
);

portfolioSchema.index({ mode: 1, owner: 1 }, { unique: true });

export const PortfolioModel = model('Portfolio', portfolioSchema);
