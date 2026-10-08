import { Schema, model } from 'mongoose';

const portfolioSnapshotSchema = new Schema(
  {
    mode: { type: String, enum: ['PAPER', 'LIVE'], required: true, index: true },
    timestamp: { type: Date, required: true, index: true },
    balance: Number,
    equity: Number,
    unrealizedPnl: Number,
    realizedPnl: Number,
    fees: Number,
    exposure: Number,
    drawdown: Number,
    openPositions: Number,
  },
  { versionKey: false },
);

export const PortfolioSnapshot = model('PortfolioSnapshot', portfolioSnapshotSchema);
