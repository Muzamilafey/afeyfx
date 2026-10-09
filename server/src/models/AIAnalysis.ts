import { Schema, model } from 'mongoose';

const aiAnalysisSchema = new Schema(
  {
    kind: { type: String, enum: ['MARKET', 'STRATEGY_REVIEW', 'TRADE_REVIEW', 'DERIV_ANALYSIS'], default: 'MARKET' },
    symbol: { type: String, index: true },
    timeframe: String,
    model: String,
    signal: { type: String, enum: ['LONG', 'SHORT', 'HOLD', 'EXIT', null] },
    confidence: Number,
    marketRegime: String,
    riskLevel: String,
    newsSentiment: String,
    newsCount: Number,
    reason: String,
    output: Schema.Types.Mixed,
    inputSummary: Schema.Types.Mixed,
    status: { type: String, enum: ['OK', 'ERROR', 'REFUSED', 'DISABLED'], default: 'OK' },
    error: String,
    latencyMs: Number,
    usage: Schema.Types.Mixed,
  },
  { timestamps: true },
);

export const AIAnalysisModel = model('AIAnalysis', aiAnalysisSchema);
