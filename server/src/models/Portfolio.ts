import { Schema, model } from 'mongoose';

const portfolioSchema = new Schema(
  {
    /**
     * PAPER = simulated money (system paper book, or a trader's DEMO account).
     * LIVE  = the system strategy book trading on a real exchange.
     * REAL  = a trader's real-money account, funded by M-Pesa deposits. Orders fill internally at
     *         the real market price (never sent to an exchange); always owned by a user.
     */
    mode: { type: String, enum: ['PAPER', 'LIVE', 'REAL'], required: true },
    /** null = the system (strategy) book; a user id = that user's personal account. */
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
