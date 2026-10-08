import { Schema, model } from 'mongoose';

/**
 * Strategy configuration & lifecycle. A strategy must progress through
 * RESEARCH -> BACKTEST -> OUT_OF_SAMPLE -> PAPER -> APPROVED -> LIVE.
 * Only a human admin can set APPROVED/LIVE.
 */
export const STRATEGY_STAGES = ['RESEARCH', 'BACKTEST', 'OUT_OF_SAMPLE', 'PAPER', 'APPROVED', 'LIVE', 'RETIRED'] as const;

const strategySchema = new Schema(
  {
    key: { type: String, required: true, unique: true }, // registry id e.g. trend-following
    name: { type: String, required: true },
    version: { type: String, required: true },
    description: String,
    enabled: { type: Boolean, default: false },
    stage: { type: String, enum: STRATEGY_STAGES, default: 'RESEARCH' },
    symbols: { type: [String], default: [] },
    timeframes: { type: [String], default: [] },
    riskLevel: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },
    params: { type: Schema.Types.Mixed, default: {} },
    allowedRegimes: { type: [String], default: [] },
    requireAiConfirmation: { type: Boolean, default: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    disabledReason: String,
  },
  { timestamps: true },
);

export const StrategyModel = model('Strategy', strategySchema);
