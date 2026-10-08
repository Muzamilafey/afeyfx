import { Schema, model } from 'mongoose';

const signalSchema = new Schema(
  {
    mode: { type: String, enum: ['BACKTEST', 'PAPER', 'LIVE'], required: true, immutable: true, index: true },
    strategyKey: { type: String, required: true, index: true },
    strategyVersion: String,
    exchange: String,
    symbol: { type: String, required: true, index: true },
    timeframe: String,
    action: { type: String, enum: ['LONG', 'SHORT', 'EXIT', 'HOLD'], required: true },
    confidence: { type: Number, min: 0, max: 1 },
    price: Number,
    stopLoss: Number,
    takeProfit: Number,
    regime: String,
    reason: String,
    indicators: Schema.Types.Mixed,
    candleTimestamp: Number,
    aiAnalysis: { type: Schema.Types.ObjectId, ref: 'AIAnalysis' },
    riskEvaluation: Schema.Types.Mixed,
    decision: { type: String, enum: ['EXECUTE', 'REJECT', 'PENDING'], default: 'PENDING' },
    decisionReasons: [String],
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
  },
  { timestamps: true },
);
signalSchema.index({ strategyKey: 1, symbol: 1, timeframe: 1, candleTimestamp: 1, mode: 1 }, { unique: true, sparse: true });

export const SignalModel = model('Signal', signalSchema);
