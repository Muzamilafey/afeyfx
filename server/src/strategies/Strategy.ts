import type { Candle, Direction, MarketRegime, RiskLevel, SignalAction, Ticker } from '../types';
import { technicalAnalysis, type IndicatorName, type IndicatorRequest, type IndicatorSnapshot } from '../services/analysis/TechnicalAnalysisService';
import type { RegimeResult } from '../services/analysis/MarketRegimeService';
import { lastValid, atr } from '../services/analysis/indicators';

export interface OpenPositionView {
  direction: Direction;
  entryPrice: number;
  amount: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: number;
  barsHeld?: number;
}

export interface StrategyContext {
  symbol: string;
  timeframe: string;
  /** Closed candles only, oldest first. The last element is the most recent CLOSED candle. */
  candles: Candle[];
  regime: RegimeResult;
  position?: OpenPositionView;
  ticker?: Ticker;
}

export interface MarketAnalysis {
  indicators: IndicatorSnapshot;
  regime: MarketRegime;
  regimeAllowed: boolean;
  notes: string[];
}

export interface StrategySignal {
  action: SignalAction;
  confidence: number; // 0..1
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  reason: string;
  indicators: IndicatorSnapshot;
  regime: MarketRegime;
}

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

export interface ExitDecision {
  exit: boolean;
  reason: string;
}

export interface StrategyMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  timeframes: string[];
  symbols: string[];
  riskLevel: RiskLevel;
  allowedRegimes: MarketRegime[];
  requiredIndicators: IndicatorName[];
}

/** The base strategy contract every strategy implements. */
export interface Strategy extends StrategyMeta {
  params: Record<string, number>;
  minCandles: number;
  analyzeMarket(ctx: StrategyContext): MarketAnalysis;
  generateSignal(ctx: StrategyContext): StrategySignal;
  validateEntry(ctx: StrategyContext, signal: StrategySignal): ValidationResult;
  calculateStopLoss(ctx: StrategyContext, direction: Direction, entryPrice: number): number;
  calculateTakeProfit(ctx: StrategyContext, direction: Direction, entryPrice: number, stopLoss: number): number;
  calculatePositionSize(equity: number, entryPrice: number, stopLoss: number, riskPerTrade: number): number;
  shouldExit(ctx: StrategyContext, position: OpenPositionView): ExitDecision;
}

export abstract class BaseStrategy implements Strategy {
  abstract id: string;
  abstract name: string;
  abstract version: string;
  abstract description: string;
  timeframes: string[] = ['15m', '1h'];
  symbols: string[] = [];
  riskLevel: RiskLevel = 'MEDIUM';
  abstract allowedRegimes: MarketRegime[];
  abstract requiredIndicators: IndicatorName[];
  params: Record<string, number>;
  minCandles = 100;

  constructor(defaults: Record<string, number>, overrides: Record<string, number> = {}) {
    this.params = { atrPeriod: 14, stopAtrMult: 2, rewardRisk: 2, ...defaults, ...overrides };
  }

  protected indicatorRequest(): IndicatorRequest {
    return { indicators: this.requiredIndicators, atrPeriod: this.params.atrPeriod };
  }

  analyzeMarket(ctx: StrategyContext): MarketAnalysis {
    const indicators = technicalAnalysis.snapshot(ctx.candles, this.indicatorRequest());
    const regimeAllowed = this.allowedRegimes.includes(ctx.regime.regime);
    const notes: string[] = [];
    if (!regimeAllowed) notes.push(`Regime ${ctx.regime.regime} not in allowed set [${this.allowedRegimes.join(', ')}]`);
    return { indicators, regime: ctx.regime.regime, regimeAllowed, notes };
  }

  /** Strategy-specific entry logic. Only called when data is sufficient and regime is allowed. */
  protected abstract entryLogic(ctx: StrategyContext, a: MarketAnalysis): { action: SignalAction; confidence: number; reason: string };

  generateSignal(ctx: StrategyContext): StrategySignal {
    const price = ctx.candles[ctx.candles.length - 1]?.close ?? NaN;
    const hold = (reason: string, indicators: IndicatorSnapshot = { price }): StrategySignal => ({
      action: 'HOLD',
      confidence: 0,
      price,
      reason,
      indicators,
      regime: ctx.regime.regime,
    });
    if (ctx.candles.length < this.minCandles) return hold(`Insufficient candles (${ctx.candles.length}/${this.minCandles})`);
    const a = this.analyzeMarket(ctx);

    if (ctx.position) {
      const ex = this.shouldExit(ctx, ctx.position);
      if (ex.exit) return { action: 'EXIT', confidence: 1, price, reason: ex.reason, indicators: a.indicators, regime: a.regime };
      return hold('Position open; no exit condition', a.indicators);
    }
    if (!a.regimeAllowed) return hold(a.notes.join('; '), a.indicators);

    const e = this.entryLogic(ctx, a);
    if (e.action !== 'LONG' && e.action !== 'SHORT') return hold(e.reason, a.indicators);
    const stopLoss = this.calculateStopLoss(ctx, e.action, price);
    const takeProfit = this.calculateTakeProfit(ctx, e.action, price, stopLoss);
    return { action: e.action, confidence: e.confidence, price, stopLoss, takeProfit, reason: e.reason, indicators: a.indicators, regime: a.regime };
  }

  validateEntry(ctx: StrategyContext, s: StrategySignal): ValidationResult {
    const reasons: string[] = [];
    if (s.action !== 'LONG' && s.action !== 'SHORT') reasons.push('Not an entry signal');
    if (!this.allowedRegimes.includes(ctx.regime.regime)) reasons.push(`Regime ${ctx.regime.regime} not allowed`);
    if (!(s.price > 0)) reasons.push('Invalid price');
    if (!(s.stopLoss && s.stopLoss > 0)) reasons.push('Missing stop loss');
    if (s.stopLoss && s.action === 'LONG' && s.stopLoss >= s.price) reasons.push('Stop loss must be below entry for LONG');
    if (s.stopLoss && s.action === 'SHORT' && s.stopLoss <= s.price) reasons.push('Stop loss must be above entry for SHORT');
    if (s.takeProfit && s.action === 'LONG' && s.takeProfit <= s.price) reasons.push('Take profit must be above entry for LONG');
    if (s.takeProfit && s.action === 'SHORT' && s.takeProfit >= s.price) reasons.push('Take profit must be below entry for SHORT');
    if (!(s.confidence > 0 && s.confidence <= 1)) reasons.push('Confidence out of range');
    return { valid: reasons.length === 0, reasons };
  }

  calculateStopLoss(ctx: StrategyContext, direction: Direction, entryPrice: number): number {
    const a = lastValid(atr(ctx.candles, this.params.atrPeriod));
    const dist = (Number.isNaN(a) ? entryPrice * 0.01 : a) * this.params.stopAtrMult;
    return direction === 'LONG' ? entryPrice - dist : entryPrice + dist;
  }

  calculateTakeProfit(_ctx: StrategyContext, direction: Direction, entryPrice: number, stopLoss: number): number {
    const r = Math.abs(entryPrice - stopLoss) * this.params.rewardRisk;
    return direction === 'LONG' ? entryPrice + r : entryPrice - r;
  }

  /** Fixed-fractional sizing. The RiskEngine re-computes and caps this; it has final authority. */
  calculatePositionSize(equity: number, entryPrice: number, stopLoss: number, riskPerTrade: number): number {
    const dist = Math.abs(entryPrice - stopLoss);
    if (!(dist > 0) || !(equity > 0)) return 0;
    return (equity * riskPerTrade) / dist;
  }

  shouldExit(ctx: StrategyContext, p: OpenPositionView): ExitDecision {
    const c = ctx.candles[ctx.candles.length - 1];
    if (p.stopLoss !== undefined) {
      if (p.direction === 'LONG' && c.close <= p.stopLoss) return { exit: true, reason: 'Stop loss' };
      if (p.direction === 'SHORT' && c.close >= p.stopLoss) return { exit: true, reason: 'Stop loss' };
    }
    if (p.takeProfit !== undefined) {
      if (p.direction === 'LONG' && c.close >= p.takeProfit) return { exit: true, reason: 'Take profit' };
      if (p.direction === 'SHORT' && c.close <= p.takeProfit) return { exit: true, reason: 'Take profit' };
    }
    if (ctx.regime.regime === 'ABNORMAL') return { exit: true, reason: 'Abnormal market regime' };
    return this.exitLogic(ctx, p);
  }

  protected exitLogic(_ctx: StrategyContext, _p: OpenPositionView): ExitDecision {
    return { exit: false, reason: '' };
  }

  meta(): StrategyMeta & { params: Record<string, number> } {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      timeframes: this.timeframes,
      symbols: this.symbols,
      riskLevel: this.riskLevel,
      allowedRegimes: this.allowedRegimes,
      requiredIndicators: this.requiredIndicators,
      params: this.params,
    };
  }
}

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
