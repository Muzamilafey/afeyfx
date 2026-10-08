import { Schema, model } from 'mongoose';

/** A backtest definition (what to test). Each execution is a BacktestRun. */
const backtestSchema = new Schema(
  {
    name: String,
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    strategyKey: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    exchange: { type: String, default: 'binance' },
    symbol: { type: String, required: true },
    timeframe: { type: String, required: true },
    from: Number,
    to: Number,
    type: { type: String, enum: ['SIMPLE', 'WALK_FORWARD'], default: 'SIMPLE' },
    config: Schema.Types.Mixed, // fees, slippage, starting balance, walk-forward windows
  },
  { timestamps: true },
);

export const BacktestModel = model('Backtest', backtestSchema);
