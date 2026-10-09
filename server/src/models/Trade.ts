import { Schema, model } from 'mongoose';

/**
 * A completed round-trip trade. Every trade (including losers) is stored and never deleted;
 * every live trade links back to user, strategy, signal, AI analysis, risk evaluation, orders and fills.
 */
const tradeSchema = new Schema(
  {
    mode: { type: String, enum: ['PAPER', 'LIVE', 'REAL', 'DEMO'], required: true, immutable: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    exchange: String,
    symbol: { type: String, required: true, index: true },
    direction: { type: String, enum: ['LONG', 'SHORT'], required: true },
    strategyKey: { type: String, index: true },
    timeframe: String,
    amount: Number,
    lots: Number,
    contractSize: Number,
    entryPrice: Number,
    exitPrice: Number,
    grossPnl: Number,
    fees: Number,
    slippage: Number,
    netPnl: Number,
    returnPct: Number,
    exitReason: String,
    /** USD per quote unit at entry and exit; P&L and fees above are in USD. */
    quoteRate: Number,
    exitQuoteRate: Number,
    broker: String,
    brokerRef: String,
    /** Broker account (user-connected) this record belongs to; null for the system book and internal accounts. */
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', index: true },
    /** Broker-side order / deal / contract identifiers (verified with the broker). */
    brokerOrderId: String,
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

// A broker position/contract is recorded once per connection (broker reference is authoritative).
tradeSchema.index({ connection: 1, brokerRef: 1 }, { unique: true, partialFilterExpression: { connection: { $type: 'objectId' }, brokerRef: { $type: 'string' } } });

export const TradeModel = model('Trade', tradeSchema);
