import { Schema, model } from 'mongoose';

/**
 * Singleton runtime settings document (key = 'global'): risk limits, AI config,
 * trading state, emergency flags. Admin-editable. Env LIVE_TRADING_ENABLED still overrides.
 */
const settingsSchema = new Schema(
  {
    key: { type: String, default: 'global', unique: true },
    tradingMode: { type: String, enum: ['PAPER', 'LIVE'], default: 'PAPER' },
    liveModeActive: { type: Boolean, default: false },
    liveModeActivatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    liveModeActivatedAt: Date,
    lastPreflight: Schema.Types.Mixed,
    tradingEnabled: { type: Boolean, default: true }, // "STOP NEW TRADES" sets false
    emergencyShutdown: { type: Boolean, default: false },
    emergencyReason: String,
    risk: {
      maxRiskPerTrade: Number,
      maxDailyLoss: Number,
      maxWeeklyLoss: Number,
      maxOpenPositions: Number,
      maxPortfolioExposure: Number,
      maxLeverage: Number,
      maxSpreadPct: Number,
      maxSlippagePct: Number,
      maxCorrelatedPositions: Number,
      minRewardRisk: Number,
      minExpectedProfitPct: Number,
    },
    ai: {
      enabled: Boolean,
      model: String,
      minConfidence: Number,
      requireAgreement: Boolean,
    },
    arbitrage: {
      minNetProfitPct: Number,
    },
  },
  { timestamps: true },
);

export const SettingsModel = model('Settings', settingsSchema);
