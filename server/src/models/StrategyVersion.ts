import { Schema, model } from 'mongoose';

/** Immutable record of each strategy parameter set / proposal (including AI proposals). */
const strategyVersionSchema = new Schema(
  {
    strategyKey: { type: String, required: true, index: true },
    version: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    source: { type: String, enum: ['HUMAN', 'AI_PROPOSAL', 'SYSTEM'], default: 'HUMAN' },
    status: { type: String, enum: ['PROPOSED', 'BACKTESTED', 'PAPER', 'APPROVED', 'REJECTED'], default: 'PROPOSED' },
    rationale: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    backtestRuns: [{ type: Schema.Types.ObjectId, ref: 'BacktestRun' }],
  },
  { timestamps: true },
);
strategyVersionSchema.index({ strategyKey: 1, version: 1 }, { unique: true });

export const StrategyVersion = model('StrategyVersion', strategyVersionSchema);
