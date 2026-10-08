import type { Direction, TradingMode } from '../types';
import { floorTo } from '../utils/math';

export interface RiskConfig {
  maxRiskPerTrade: number;
  maxDailyLoss: number;
  maxWeeklyLoss: number;
  maxOpenPositions: number;
  maxPortfolioExposure: number;
  maxLeverage: number;
  maxSpreadPct: number;
  maxSlippagePct: number;
  maxCorrelatedPositions: number;
  correlationThreshold: number;
  minRewardRisk: number;
  minExpectedProfitPct: number;
  /** Spot accounts cannot short; shorts are rejected unless the venue supports it and this is enabled. */
  allowShort: boolean;
  /** Fraction of top-of-book depth one order may consume. */
  maxBookParticipation: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxRiskPerTrade: 0.005,
  maxDailyLoss: 0.02,
  maxWeeklyLoss: 0.05,
  maxOpenPositions: 5,
  maxPortfolioExposure: 0.2,
  maxLeverage: 1,
  maxSpreadPct: 0.002,
  maxSlippagePct: 0.003,
  maxCorrelatedPositions: 2,
  correlationThreshold: 0.8,
  minRewardRisk: 1.2,
  minExpectedProfitPct: 0.002,
  allowShort: false,
  maxBookParticipation: 0.25,
};

export interface OpenExposure {
  symbol: string;
  direction: Direction;
  notional: number;
  /** Max loss to stop, used for aggregate open risk. */
  riskAmount?: number;
}

export interface RiskInput {
  mode: TradingMode;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  stopLoss: number;
  takeProfit?: number;
  feeRate: number;
  expectedSlippagePct: number;
  leverage?: number;
  account: {
    equity: number;
    available: number;
    dayStartEquity: number;
    weekStartEquity: number;
  };
  openPositions: OpenExposure[];
  market: {
    bid: number;
    ask: number;
    /** Base-unit liquidity available on the side we take, within a reasonable price band. */
    availableLiquidity?: number;
    minAmount?: number;
    amountPrecision?: number;
    dataAgeMs: number;
    maxDataAgeMs: number;
  };
  /** Pearson correlation of returns between `symbol` and each open position's symbol. */
  correlations?: Record<string, number>;
  circuitBreaker: { open: boolean; reasons: string[] };
}

export interface RiskCheck {
  name: string;
  passed: boolean;
  critical: boolean;
  detail: string;
}

export interface RiskEvaluation {
  approved: boolean;
  reasons: string[];
  checks: RiskCheck[];
  positionSize: number;
  notional: number;
  stopDistance: number;
  stopDistancePct: number;
  maxLoss: number;
  exposureBefore: number;
  exposureAfter: number;
  exposureAfterPct: number;
  leverage: number;
  dailyDrawdownPct: number;
  weeklyDrawdownPct: number;
  rewardRisk: number;
  expectedProfitPct: number;
  spreadPct: number;
  evaluatedAt: string;
}

/**
 * Centralized risk engine. Pure and deterministic: given the same input it returns the same
 * evaluation, which makes it testable and auditable. It has final authority over every trade -
 * strategy signals and AI analysis are only inputs. Any missing/invalid input fails closed.
 */
export class RiskEngine {
  constructor(public config: RiskConfig = DEFAULT_RISK_CONFIG) {}

  updateConfig(partial: Partial<RiskConfig>) {
    this.config = { ...this.config, ...partial };
  }

  /** Fixed-fractional size including round-trip cost per unit, rounded DOWN to precision. */
  calculatePositionSize(equity: number, entry: number, stop: number, feeRate: number, slippagePct: number, riskPct = this.config.maxRiskPerTrade, precision = 8): number {
    const stopDist = Math.abs(entry - stop);
    if (!(equity > 0 && entry > 0 && stopDist > 0)) return 0;
    const costPerUnit = entry * 2 * (feeRate + slippagePct);
    const size = (equity * riskPct) / (stopDist + costPerUnit);
    return floorTo(size, precision);
  }

  evaluate(input: RiskInput): RiskEvaluation {
    const c = this.config;
    const checks: RiskCheck[] = [];
    const add = (name: string, passed: boolean, detail: string, critical = true) => checks.push({ name, passed, critical, detail });

    const { entryPrice: entry, stopLoss: stop, takeProfit: tp, account, market } = input;
    const leverage = input.leverage ?? 1;
    const validNumbers = [entry, stop, account.equity, account.available, market.bid, market.ask].every((v) => Number.isFinite(v) && v > 0);
    add('inputs-valid', validNumbers, validNumbers ? 'All inputs valid' : 'Missing or invalid numeric input');

    add('circuit-breaker', !input.circuitBreaker.open, input.circuitBreaker.open ? `Open: ${input.circuitBreaker.reasons.join('; ')}` : 'Closed');
    add('data-fresh', market.dataAgeMs >= 0 && market.dataAgeMs <= market.maxDataAgeMs, `Market data age ${market.dataAgeMs}ms (max ${market.maxDataAgeMs}ms)`);
    add('short-allowed', input.direction === 'LONG' || c.allowShort, input.direction === 'SHORT' && !c.allowShort ? 'Short selling disabled' : 'OK');

    const stopDistance = Math.abs(entry - stop);
    const stopValid = input.direction === 'LONG' ? stop < entry : stop > entry;
    add('stop-loss-valid', validNumbers && stopValid && stopDistance > 0, stopValid ? `Stop distance ${stopDistance}` : 'Stop loss on wrong side of entry');

    const mid = (market.bid + market.ask) / 2;
    const spreadPct = mid > 0 ? (market.ask - market.bid) / mid : Infinity;
    add('spread', spreadPct >= 0 && spreadPct <= c.maxSpreadPct, `Spread ${(spreadPct * 100).toFixed(4)}% (max ${(c.maxSpreadPct * 100).toFixed(3)}%)`);
    add('slippage', input.expectedSlippagePct <= c.maxSlippagePct, `Expected slippage ${(input.expectedSlippagePct * 100).toFixed(3)}%`);

    add('leverage', leverage <= c.maxLeverage, `Leverage ${leverage}x (max ${c.maxLeverage}x)`);

    const dailyDrawdownPct = account.dayStartEquity > 0 ? Math.max(0, (account.dayStartEquity - account.equity) / account.dayStartEquity) : 0;
    const weeklyDrawdownPct = account.weekStartEquity > 0 ? Math.max(0, (account.weekStartEquity - account.equity) / account.weekStartEquity) : 0;
    add('daily-loss', dailyDrawdownPct < c.maxDailyLoss, `Daily drawdown ${(dailyDrawdownPct * 100).toFixed(2)}% (limit ${(c.maxDailyLoss * 100).toFixed(2)}%)`);
    add('weekly-loss', weeklyDrawdownPct < c.maxWeeklyLoss, `Weekly drawdown ${(weeklyDrawdownPct * 100).toFixed(2)}% (limit ${(c.maxWeeklyLoss * 100).toFixed(2)}%)`);

    add('max-open-positions', input.openPositions.length < c.maxOpenPositions, `${input.openPositions.length} open (max ${c.maxOpenPositions})`);
    const dup = input.openPositions.some((p) => p.symbol === input.symbol);
    add('no-duplicate-position', !dup, dup ? `Already have a position in ${input.symbol}` : 'OK');

    const correlated = input.openPositions.filter((p) => {
      const r = input.correlations?.[p.symbol];
      return r !== undefined && Math.abs(r) >= c.correlationThreshold && (r > 0 ? p.direction === input.direction : p.direction !== input.direction);
    });
    add('correlation', correlated.length < c.maxCorrelatedPositions, `${correlated.length} highly correlated same-direction positions (max ${c.maxCorrelatedPositions - 1})`);

    // Sizing
    const precision = market.amountPrecision ?? 8;
    let size = this.calculatePositionSize(account.equity, entry, stop, input.feeRate, input.expectedSlippagePct, c.maxRiskPerTrade, precision);
    const exposureBefore = input.openPositions.reduce((s, p) => s + Math.abs(p.notional), 0);
    const maxNotionalByExposure = Math.max(0, c.maxPortfolioExposure * account.equity * leverage - exposureBefore);
    const maxNotionalByCash = account.available * leverage;
    const maxNotionalByLeverage = Math.max(0, account.equity * c.maxLeverage - exposureBefore);
    const notionalCap = Math.min(maxNotionalByExposure, maxNotionalByCash, maxNotionalByLeverage);
    if (validNumbers && size * entry > notionalCap) size = floorTo(notionalCap / entry, precision);
    if (market.availableLiquidity !== undefined) {
      const liqCap = market.availableLiquidity * c.maxBookParticipation;
      add('liquidity', liqCap > 0, `Book liquidity ${market.availableLiquidity} (usable ${liqCap})`);
      if (size > liqCap) size = floorTo(liqCap, precision);
    }
    const notional = size * entry;
    const minAmount = market.minAmount ?? 0;
    add('position-size', size > 0 && size >= minAmount, size > 0 ? `Size ${size} (min ${minAmount})` : 'Computed size is zero (exposure/cash/liquidity exhausted)');

    const exposureAfter = exposureBefore + notional;
    const exposureAfterPct = account.equity > 0 ? exposureAfter / account.equity : Infinity;
    add('portfolio-exposure', exposureAfterPct <= c.maxPortfolioExposure * leverage + 1e-9, `Exposure after ${(exposureAfterPct * 100).toFixed(2)}% (max ${(c.maxPortfolioExposure * 100).toFixed(0)}%)`);

    const roundTripCost = notional * 2 * (input.feeRate + input.expectedSlippagePct);
    const maxLoss = size * stopDistance + roundTripCost;
    add('max-loss', account.equity > 0 && maxLoss <= account.equity * c.maxRiskPerTrade * 1.0001, `Max loss ${maxLoss.toFixed(2)} (limit ${(account.equity * c.maxRiskPerTrade).toFixed(2)})`);

    const rewardDistance = tp !== undefined ? Math.abs(tp - entry) : 0;
    const rewardRisk = stopDistance > 0 ? rewardDistance / stopDistance : 0;
    const expectedProfitPct = entry > 0 ? rewardDistance / entry - 2 * (input.feeRate + input.expectedSlippagePct) : 0;
    add('reward-risk', tp !== undefined && rewardRisk >= c.minRewardRisk, `Reward:risk ${rewardRisk.toFixed(2)} (min ${c.minRewardRisk})`);
    add('expected-profit', expectedProfitPct > c.minExpectedProfitPct, `Expected net profit at target ${(expectedProfitPct * 100).toFixed(3)}% (min ${(c.minExpectedProfitPct * 100).toFixed(3)}%)`);

    const failed = checks.filter((x) => !x.passed && x.critical);
    return {
      approved: failed.length === 0,
      reasons: failed.map((f) => `${f.name}: ${f.detail}`),
      checks,
      positionSize: failed.length === 0 ? size : 0,
      notional,
      stopDistance,
      stopDistancePct: entry > 0 ? stopDistance / entry : 0,
      maxLoss,
      exposureBefore,
      exposureAfter,
      exposureAfterPct,
      leverage,
      dailyDrawdownPct,
      weeklyDrawdownPct,
      rewardRisk,
      expectedProfitPct,
      spreadPct,
      evaluatedAt: new Date().toISOString(),
    };
  }
}

/** Pearson correlation of two equally-sized series. */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

export const returns = (closes: number[]) => closes.slice(1).map((c, i) => (closes[i] > 0 ? c / closes[i] - 1 : 0));
