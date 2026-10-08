import { Schema, model } from 'mongoose';

const backtestRunSchema = new Schema(
  {
    backtest: { type: Schema.Types.ObjectId, ref: 'Backtest', required: true, index: true },
    strategyKey: String,
    segment: { type: String, enum: ['FULL', 'TRAIN', 'VALIDATION', 'OUT_OF_SAMPLE'], default: 'FULL' },
    window: Number,
    status: { type: String, enum: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'], default: 'QUEUED' },
    from: Number,
    to: Number,
    candles: Number,
    params: Schema.Types.Mixed,
    metrics: Schema.Types.Mixed,
    trades: { type: [Schema.Types.Mixed], default: [] },
    equityCurve: { type: [Schema.Types.Mixed], default: [] },
    warnings: [String],
    error: String,
    startedAt: Date,
    finishedAt: Date,
  },
  { timestamps: true },
);

export const BacktestRunModel = model('BacktestRun', backtestRunSchema);
