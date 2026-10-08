import type { MarketRegime, SignalAction } from '../types';
import type { IndicatorName } from '../services/analysis/TechnicalAnalysisService';
import { highest, lowest } from '../services/analysis/indicators';
import { BaseStrategy, clamp01, type MarketAnalysis, type StrategyContext } from './Strategy';

/** Donchian-channel breakout with volume confirmation. Excludes the current bar from the channel. */
export class BreakoutStrategy extends BaseStrategy {
  id = 'breakout';
  name = 'Breakout';
  version = '1.0.0';
  description = 'Close breaks the prior N-bar high/low with relative volume above threshold.';
  allowedRegimes: MarketRegime[] = ['SIDEWAYS', 'LOW_VOLATILITY', 'TRENDING_UP', 'TRENDING_DOWN'];
  requiredIndicators: IndicatorName[] = ['volume', 'atr'];

  constructor(overrides: Record<string, number> = {}) {
    super({ lookback: 20, minRelVolume: 1.5, stopAtrMult: 2, rewardRisk: 2 }, overrides);
  }

  protected entryLogic(ctx: StrategyContext, a: MarketAnalysis): { action: SignalAction; confidence: number; reason: string } {
    const prior = ctx.candles.slice(0, -1);
    const n = this.params.lookback;
    const hh = highest(prior.map((c) => c.high), n);
    const ll = lowest(prior.map((c) => c.low), n);
    const upper = hh[hh.length - 1];
    const lower = ll[ll.length - 1];
    const close = ctx.candles[ctx.candles.length - 1].close;
    const rv = a.indicators.volume?.relative ?? NaN;
    if (Number.isNaN(upper) || Number.isNaN(rv)) return { action: 'HOLD', confidence: 0, reason: 'Indicators not ready' };
    if (rv < this.params.minRelVolume) return { action: 'HOLD', confidence: 0, reason: `Relative volume ${rv.toFixed(2)} too low` };
    const conf = clamp01(0.5 + (rv - this.params.minRelVolume) / 6);
    if (close > upper) return { action: 'LONG', confidence: conf, reason: `Close ${close} broke ${n}-bar high ${upper}, rel vol ${rv.toFixed(2)}` };
    if (close < lower) return { action: 'SHORT', confidence: conf, reason: `Close ${close} broke ${n}-bar low ${lower}, rel vol ${rv.toFixed(2)}` };
    return { action: 'HOLD', confidence: 0, reason: 'Inside channel' };
  }
}
