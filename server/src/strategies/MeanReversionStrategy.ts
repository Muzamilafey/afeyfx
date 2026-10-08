import type { MarketRegime, SignalAction, Direction } from '../types';
import type { IndicatorName } from '../services/analysis/TechnicalAnalysisService';
import { BaseStrategy, clamp01, type ExitDecision, type MarketAnalysis, type OpenPositionView, type StrategyContext } from './Strategy';

/** Fade Bollinger Band extremes confirmed by RSI. Only in sideways / low-volatility regimes. */
export class MeanReversionStrategy extends BaseStrategy {
  id = 'mean-reversion';
  name = 'Mean Reversion';
  version = '1.0.0';
  description = 'Buy below lower Bollinger Band with RSI oversold (sell above upper with RSI overbought); exit at middle band.';
  allowedRegimes: MarketRegime[] = ['SIDEWAYS', 'LOW_VOLATILITY'];
  requiredIndicators: IndicatorName[] = ['bollinger', 'rsi', 'atr'];

  constructor(overrides: Record<string, number> = {}) {
    super({ bbPeriod: 20, bbMult: 2, rsiLow: 30, rsiHigh: 70, stopAtrMult: 1.5, rewardRisk: 1.5 }, overrides);
  }

  protected indicatorRequest() {
    return { ...super.indicatorRequest(), bbPeriod: this.params.bbPeriod, bbMult: this.params.bbMult };
  }

  protected entryLogic(_ctx: StrategyContext, a: MarketAnalysis): { action: SignalAction; confidence: number; reason: string } {
    const bb = a.indicators.bollinger;
    const rsi = a.indicators.rsi;
    if (!bb || rsi === undefined || Number.isNaN(bb.percentB) || Number.isNaN(rsi)) return { action: 'HOLD', confidence: 0, reason: 'Indicators not ready' };
    if (bb.percentB < 0 && rsi < this.params.rsiLow) {
      return { action: 'LONG', confidence: clamp01(0.5 + (this.params.rsiLow - rsi) / 40), reason: `Below lower band (%B ${bb.percentB.toFixed(2)}), RSI ${rsi.toFixed(1)}` };
    }
    if (bb.percentB > 1 && rsi > this.params.rsiHigh) {
      return { action: 'SHORT', confidence: clamp01(0.5 + (rsi - this.params.rsiHigh) / 40), reason: `Above upper band (%B ${bb.percentB.toFixed(2)}), RSI ${rsi.toFixed(1)}` };
    }
    return { action: 'HOLD', confidence: 0, reason: 'Within bands' };
  }

  calculateTakeProfit(ctx: StrategyContext, direction: Direction, entry: number, stop: number): number {
    const mid = this.analyzeMarket(ctx).indicators.bollinger?.middle;
    const rTarget = super.calculateTakeProfit(ctx, direction, entry, stop);
    if (!mid || Number.isNaN(mid)) return rTarget;
    // Target the mean, but never beyond the R-multiple target.
    return direction === 'LONG' ? Math.min(Math.max(mid, entry * 1.001), rTarget) : Math.max(Math.min(mid, entry * 0.999), rTarget);
  }

  protected exitLogic(ctx: StrategyContext, p: OpenPositionView): ExitDecision {
    const bb = this.analyzeMarket(ctx).indicators.bollinger;
    const price = ctx.candles[ctx.candles.length - 1].close;
    if (!bb) return { exit: false, reason: '' };
    if (p.direction === 'LONG' && price >= bb.middle) return { exit: true, reason: 'Reverted to mean' };
    if (p.direction === 'SHORT' && price <= bb.middle) return { exit: true, reason: 'Reverted to mean' };
    if (ctx.regime.regime === 'TRENDING_UP' || ctx.regime.regime === 'TRENDING_DOWN') return { exit: true, reason: 'Regime changed to trending' };
    return { exit: false, reason: '' };
  }
}
