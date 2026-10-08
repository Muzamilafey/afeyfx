import type { MarketRegime, SignalAction } from '../types';
import type { IndicatorName } from '../services/analysis/TechnicalAnalysisService';
import { ema } from '../services/analysis/indicators';
import { BaseStrategy, clamp01, type ExitDecision, type MarketAnalysis, type OpenPositionView, type StrategyContext } from './Strategy';

/** EMA crossover confirmed by ADX trend strength. Trades only in trending regimes. */
export class TrendFollowingStrategy extends BaseStrategy {
  id = 'trend-following';
  name = 'Trend Following';
  version = '1.0.0';
  description = 'EMA fast/slow crossover confirmed by ADX >= threshold and DI direction. ATR stop, 2R target.';
  allowedRegimes: MarketRegime[] = ['TRENDING_UP', 'TRENDING_DOWN'];
  requiredIndicators: IndicatorName[] = ['ema', 'adx', 'atr'];

  constructor(overrides: Record<string, number> = {}) {
    super({ fast: 20, slow: 50, adxMin: 25, stopAtrMult: 2.5, rewardRisk: 2.5 }, overrides);
  }

  protected indicatorRequest() {
    return { ...super.indicatorRequest(), emaPeriods: [this.params.fast, this.params.slow] };
  }

  protected entryLogic(ctx: StrategyContext, a: MarketAnalysis): { action: SignalAction; confidence: number; reason: string } {
    const closes = ctx.candles.map((c) => c.close);
    const f = ema(closes, this.params.fast);
    const s = ema(closes, this.params.slow);
    const n = closes.length - 1;
    const adx = a.indicators.adx!;
    if (!(adx.adx >= this.params.adxMin)) return { action: 'HOLD', confidence: 0, reason: `ADX ${adx.adx.toFixed(1)} < ${this.params.adxMin}` };
    const crossedUp = f[n - 1] <= s[n - 1] && f[n] > s[n];
    const crossedDown = f[n - 1] >= s[n - 1] && f[n] < s[n];
    const conf = clamp01(0.5 + (adx.adx - this.params.adxMin) / 50);
    if (crossedUp && adx.plusDI > adx.minusDI) return { action: 'LONG', confidence: conf, reason: `EMA${this.params.fast} crossed above EMA${this.params.slow}, ADX ${adx.adx.toFixed(1)}` };
    if (crossedDown && adx.minusDI > adx.plusDI) return { action: 'SHORT', confidence: conf, reason: `EMA${this.params.fast} crossed below EMA${this.params.slow}, ADX ${adx.adx.toFixed(1)}` };
    return { action: 'HOLD', confidence: 0, reason: 'No crossover' };
  }

  protected exitLogic(ctx: StrategyContext, p: OpenPositionView): ExitDecision {
    const closes = ctx.candles.map((c) => c.close);
    const f = ema(closes, this.params.fast);
    const s = ema(closes, this.params.slow);
    const n = closes.length - 1;
    if (p.direction === 'LONG' && f[n] < s[n]) return { exit: true, reason: 'Trend reversal (EMA cross down)' };
    if (p.direction === 'SHORT' && f[n] > s[n]) return { exit: true, reason: 'Trend reversal (EMA cross up)' };
    return { exit: false, reason: '' };
  }
}
