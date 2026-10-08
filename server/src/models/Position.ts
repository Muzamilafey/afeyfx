import { Schema, model } from 'mongoose';

const positionSchema = new Schema(
  {
    mode: { type: String, enum: ['PAPER', 'LIVE', 'REAL'], required: true, immutable: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    exchange: { type: String, required: true },
    symbol: { type: String, required: true, index: true },
    direction: { type: String, enum: ['LONG', 'SHORT'], required: true },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true },
    amount: { type: Number, required: true },
    entryPrice: { type: Number, required: true },
    currentPrice: Number,
    stopLoss: Number,
    takeProfit: Number,
    trailingPct: Number,
    highWatermark: Number,
    lowWatermark: Number,
    unrealizedPnl: { type: Number, default: 0 },
    realizedPnl: { type: Number, default: 0 },
    fees: { type: Number, default: 0 },
    strategyKey: String,
    timeframe: String,
    signal: { type: Schema.Types.ObjectId, ref: 'Signal' },
    aiAnalysis: { type: Schema.Types.ObjectId, ref: 'AIAnalysis' },
    entryOrder: { type: Schema.Types.ObjectId, ref: 'Order' },
    exitOrder: { type: Schema.Types.ObjectId, ref: 'Order' },
    /** Exchange-side protective stop (LIVE) so the position is protected even if the engine is down. */
    protectiveOrder: { type: Schema.Types.ObjectId, ref: 'Order' },
    riskAmount: Number,
    /** USD value of one unit of the quote currency at entry (1 for USD/USDT pairs). */
    quoteRate: { type: Number, default: 1 },
    /** Where a REAL-account position is executed: internal (default) or an external broker. */
    broker: { type: String, default: 'internal' },
    /** Broker-side id (Deriv contract id, OANDA trade id). */
    brokerRef: String,
    brokerData: Schema.Types.Mixed,
    riskEvaluation: Schema.Types.Mixed,
    openedAt: { type: Date, default: Date.now },
    closedAt: Date,
    exitReason: String,
  },
  { timestamps: true },
);

export const PositionModel = model('Position', positionSchema);
