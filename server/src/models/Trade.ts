import { Schema, model } from 'mongoose';

/**
 * A completed round-trip trade. Every trade (including losers) is stored and never deleted;
 * every live trade links back to user, strategy, signal, AI analysis, risk evaluation, orders and fills.
 */
const tradeSchema = new Schema(
  {
    mode: { type: String, enum: ['PAPER', 'LIVE'], required: true, immutable: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    exchange: String,
    symbol: { type: String, required: true, index: true },
    direction: { type: String, enum: ['LONG', 'SHORT'], required: true },
    strategyKey: { type: String, index: true },
    timeframe: String,
    amount: Number,
    entryPrice: Number,
    exitPrice: Number,
    grossPnl: Number,
    fees: Number,
    slippage: Number,
    netPnl: Number,
    returnPct: Number,
    exitReason: String,
    position: { type: Schema.Types.ObjectId, ref: 'Position' },
    signal: { type: Schema.Types.ObjectId, ref: 'Signal' },
    aiAnalysis: { type: Schema.Types.ObjectId, ref: 'AIAnalysis' },
    riskEvaluation: Schema.Types.Mixed,
    entryOrder: { type: Schema.Types.ObjectId, ref: 'Order' },
    exitOrder: { type: Schema.Types.ObjectId, ref: 'Order' },
    openedAt: Date,
    closedAt: { type: Date, index: true },
  },
  { timestamps: true },
);

export const TradeModel = model('Trade', tradeSchema);
