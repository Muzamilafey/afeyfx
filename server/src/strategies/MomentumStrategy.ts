import type { MarketRegime, SignalAction } from '../types';
import type { IndicatorName } from '../services/analysis/TechnicalAnalysisService';
import { BaseStrategy, clamp01, type ExitDecision, type MarketAnalysis, type OpenPositionView, type StrategyContext } from './Strategy';

/** MACD histogram zero-cross with RSI and rate-of-change confirmation. Trending regimes only. */
export class MomentumStrategy extends BaseStrategy {
  id = 'momentum';
  name = 'Momentum';
  version = '1.0.0';
  description = 'MACD histogram turns positive/negative with RSI in momentum zone and positive/negative ROC.';
  allowedRegimes: MarketRegime[] = ['TRENDING_UP', 'TRENDING_DOWN'];
  requiredIndicators: IndicatorName[] = ['macd', 'rsi', 'momentum', 'atr'];

  constructor(overrides: Record<string, number> = {}) {
    super({ rsiLongMin: 52, rsiLongMax: 72, rsiShortMin: 28, rsiShortMax: 48, rocPeriod: 10, stopAtrMult: 2, rewardRisk: 2 }, overrides);
  }

  protected indicatorRequest() {
    return { ...super.indicatorRequest(), momentumPeriod: this.params.rocPeriod };
  }

  protected entryLogic(_ctx: StrategyContext, a: MarketAnalysis): { action: SignalAction; confidence: number; reason: string } {
    const { macd, rsi, momentum } = a.indicators;
    if (!macd || rsi === undefined || momentum === undefined || [macd.histogram, macd.prevHistogram, rsi, momentum].some(Number.isNaN)) {
      return { action: 'HOLD', confidence: 0, reason: 'Indicators not ready' };
    }
    const p = this.params;
    if (macd.prevHistogram <= 0 && macd.histogram > 0 && rsi >= p.rsiLongMin && rsi <= p.rsiLongMax && momentum > 0) {
      return { action: 'LONG', confidence: clamp01(0.55 + momentum * 5), reason: `MACD hist turned positive, RSI ${rsi.toFixed(1)}, ROC ${(momentum * 100).toFixed(2)}%` };
    }
    if (macd.prevHistogram >= 0 && macd.histogram < 0 && rsi >= p.rsiShortMin && rsi <= p.rsiShortMax && momentum < 0) {
      return { action: 'SHORT', confidence: clamp01(0.55 - momentum * 5), reason: `MACD hist turned negative, RSI ${rsi.toFixed(1)}, ROC ${(momentum * 100).toFixed(2)}%` };
    }
    return { action: 'HOLD', confidence: 0, reason: 'No momentum trigger' };
  }

  protected exitLogic(ctx: StrategyContext, p: OpenPositionView): ExitDecision {
    const a = this.analyzeMarket(ctx);
    const h = a.indicators.macd?.histogram ?? 0;
    if (p.direction === 'LONG' && h < 0) return { exit: true, reason: 'Momentum faded (MACD hist < 0)' };
    if (p.direction === 'SHORT' && h > 0) return { exit: true, reason: 'Momentum faded (MACD hist > 0)' };
    return { exit: false, reason: '' };
  }
}
