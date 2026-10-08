import { SettingsModel } from '../models/Settings';
import { tradingState, type TradingStateShape } from './TradingState';
import type { RiskConfig } from '../risk/RiskEngine';
import { AppError } from '../utils/errors';

const clamp = (v: unknown, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new AppError(400, `Invalid number: ${String(v)}`, 'VALIDATION_ERROR');
  if (n < min || n > max) throw new AppError(400, `Value ${n} outside allowed range [${min}, ${max}]`, 'VALIDATION_ERROR');
  return n;
};

/** Hard upper bounds that cannot be exceeded from the admin UI. */
export const RISK_BOUNDS: Record<keyof Omit<RiskConfig, 'allowShort'>, [number, number]> = {
  maxRiskPerTrade: [0.0001, 0.02],
  maxDailyLoss: [0.001, 0.1],
  maxWeeklyLoss: [0.001, 0.2],
  maxOpenPositions: [1, 50],
  maxPortfolioExposure: [0.01, 1],
  maxLeverage: [1, 3],
  maxSpreadPct: [0.00001, 0.02],
  maxSlippagePct: [0.00001, 0.02],
  maxCorrelatedPositions: [1, 20],
  correlationThreshold: [0.3, 1],
  minRewardRisk: [0.5, 10],
  minExpectedProfitPct: [0, 0.1],
  maxBookParticipation: [0.01, 1],
};

export const SettingsService = {
  async load() {
    const doc = await SettingsModel.findOneAndUpdate({ key: 'global' }, { $setOnInsert: { key: 'global' } }, { upsert: true, new: true });
    const s = tradingState.get();
    const risk = { ...s.risk };
    for (const [k, v] of Object.entries(doc.risk ?? {})) if (v !== undefined && v !== null && k in risk) (risk as Record<string, unknown>)[k] = v;
    const ai = { ...s.ai };
    for (const [k, v] of Object.entries(doc.ai ?? {})) if (v !== undefined && v !== null && k in ai) (ai as Record<string, unknown>)[k] = v;
    // SAFETY: always boot in PAPER with live inactive; persisted live state is cleared.
    if (doc.tradingMode === 'LIVE' || doc.liveModeActive) {
      doc.tradingMode = 'PAPER';
      doc.liveModeActive = false;
      await doc.save();
    }
    tradingState.update({
      mode: 'PAPER',
      liveModeActive: false,
      tradingEnabled: doc.tradingEnabled !== false,
      emergencyShutdown: doc.emergencyShutdown === true,
      emergencyReason: doc.emergencyReason ?? undefined,
      risk,
      ai,
      arbitrageMinNetProfitPct: doc.arbitrage?.minNetProfitPct ?? s.arbitrageMinNetProfitPct,
    });
    return tradingState.get();
  },

  async updateRisk(partial: Partial<RiskConfig>) {
    const clean: Partial<RiskConfig> = {};
    for (const [k, v] of Object.entries(partial)) {
      if (k === 'allowShort') {
        clean.allowShort = v === true;
        continue;
      }
      const bounds = RISK_BOUNDS[k as keyof typeof RISK_BOUNDS];
      if (!bounds) throw new AppError(400, `Unknown risk setting: ${k}`, 'VALIDATION_ERROR');
      (clean as Record<string, number>)[k] = clamp(v, bounds[0], bounds[1]);
    }
    const merged = { ...tradingState.get().risk, ...clean };
    if (merged.maxWeeklyLoss < merged.maxDailyLoss) throw new AppError(400, 'maxWeeklyLoss must be >= maxDailyLoss', 'VALIDATION_ERROR');
    const $set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(clean)) $set[`risk.${k}`] = v;
    await SettingsModel.updateOne({ key: 'global' }, { $set }, { upsert: true });
    tradingState.updateRisk(clean);
    return tradingState.get().risk;
  },

  async updateAi(partial: Partial<TradingStateShape['ai']>) {
    const clean: Partial<TradingStateShape['ai']> = {};
    if (partial.enabled !== undefined) clean.enabled = partial.enabled === true;
    if (partial.model !== undefined) {
      if (!/^claude-[a-z0-9-]+$/.test(String(partial.model))) throw new AppError(400, 'Invalid model id', 'VALIDATION_ERROR');
      clean.model = String(partial.model);
    }
    if (partial.minConfidence !== undefined) clean.minConfidence = clamp(partial.minConfidence, 0.5, 1);
    if (partial.requireAgreement !== undefined) clean.requireAgreement = partial.requireAgreement !== false;
    const $set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(clean)) $set[`ai.${k}`] = v;
    await SettingsModel.updateOne({ key: 'global' }, { $set }, { upsert: true });
    tradingState.update({ ai: { ...tradingState.get().ai, ...clean } });
    return tradingState.get().ai;
  },

  async persistFlags(flags: Partial<{ tradingEnabled: boolean; emergencyShutdown: boolean; emergencyReason: string | null; tradingMode: 'PAPER' | 'LIVE'; liveModeActive: boolean; liveModeActivatedBy: unknown; liveModeActivatedAt: Date; lastPreflight: unknown }>) {
    await SettingsModel.updateOne({ key: 'global' }, { $set: flags }, { upsert: true });
  },
};
