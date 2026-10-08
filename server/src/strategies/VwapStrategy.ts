import type { MarketRegime, SignalAction } from '../types';
import type { IndicatorName } from '../services/analysis/TechnicalAnalysisService';
import { ema, vwap } from '../services/analysis/indicators';
import { BaseStrategy, clamp01, type ExitDecision, type MarketAnalysis, type OpenPositionView, type StrategyContext } from './Strategy';

const DAY = 86_400_000;

/** Session-VWAP reclaim/loss with EMA trend filter. */
export class VwapStrategy extends BaseStrategy {
  id = 'vwap';
  name = 'VWAP';
  version = '1.0.0';
  description = 'Price crosses the daily (UTC) session VWAP in the direction of the EMA trend filter.';
  allowedRegimes: MarketRegime[] = ['TRENDING_UP', 'TRENDING_DOWN', 'SIDEWAYS'];
  requiredIndicators: IndicatorName[] = ['vwap', 'ema', 'atr'];
  timeframes = ['5m', '15m'];

  constructor(overrides: Record<string, number> = {}) {
    super({ trendEma: 50, stopAtrMult: 1.5, rewardRisk: 2 }, overrides);
  }

  protected indicatorRequest() {
    return { ...super.indicatorRequest(), vwapSessionMs: DAY, emaPeriods: [this.params.trendEma] };
  }

  protected entryLogic(ctx: StrategyContext, _a: MarketAnalysis): { action: SignalAction; confidence: number; reason: string } {
    const closes = ctx.candles.map((c) => c.close);
    const v = vwap(ctx.candles, DAY);
    const e = ema(closes, this.params.trendEma);
    const n = closes.length - 1;
    if (Number.isNaN(e[n])) return { action: 'HOLD', confidence: 0, reason: 'Indicators not ready' };
    const dist = Math.abs(closes[n] - v[n]) / v[n];
    const conf = clamp01(0.55 + Math.min(dist * 20, 0.2));
    if (closes[n - 1] <= v[n - 1] && closes[n] > v[n] && closes[n] > e[n]) return { action: 'LONG', confidence: conf, reason: 'Reclaimed session VWAP above trend EMA' };
    if (closes[n - 1] >= v[n - 1] && closes[n] < v[n] && closes[n] < e[n]) return { action: 'SHORT', confidence: conf, reason: 'Lost session VWAP below trend EMA' };
    return { action: 'HOLD', confidence: 0, reason: 'No VWAP cross' };
  }

  protected exitLogic(ctx: StrategyContext, p: OpenPositionView): ExitDecision {
    const v = vwap(ctx.candles, DAY);
    const n = ctx.candles.length - 1;
    const c = ctx.candles[n].close;
    if (p.direction === 'LONG' && c < v[n]) return { exit: true, reason: 'Closed back below VWAP' };
    if (p.direction === 'SHORT' && c > v[n]) return { exit: true, reason: 'Closed back above VWAP' };
    return { exit: false, reason: '' };
  }
}
