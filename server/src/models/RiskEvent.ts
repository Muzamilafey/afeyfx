import { Schema, model } from 'mongoose';

const riskEventSchema = new Schema(
  {
    type: { type: String, required: true, index: true }, // e.g. TRADE_REJECTED, CIRCUIT_BREAKER_TRIPPED
    severity: { type: String, enum: ['INFO', 'WARNING', 'CRITICAL'], default: 'INFO' },
    mode: String,
    symbol: String,
    strategyKey: String,
    message: String,
    details: Schema.Types.Mixed,
    acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    acknowledgedAt: Date,
  },
  { timestamps: true },
);

export const RiskEventModel = model('RiskEvent', riskEventSchema);
