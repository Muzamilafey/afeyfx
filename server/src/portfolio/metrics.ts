import { mean, stdev } from '../utils/math';

export interface TradeLike {
  netPnl: number;
  returnPct?: number;
  fees?: number;
  slippage?: number;
}

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface PerformanceMetrics {
  startingBalance: number;
  endingEquity: number;
  totalReturn: number;
  totalPnl: number;
  numberOfTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  grossProfit: number;
  grossLoss: number;
  expectancy: number;
  averageTrade: number;
  averageWin: number;
  averageLoss: number;
  maxDrawdown: number;
  sharpe: number | null;
  sortino: number | null;
  longestWinStreak: number;
  longestLossStreak: number;
  totalFees: number;
  totalSlippage: number;
}

export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) mdd = Math.max(mdd, (peak - e) / peak);
  }
  return mdd;
}

export function streaks(pnls: number[]) {
  let w = 0;
  let l = 0;
  let maxW = 0;
  let maxL = 0;
  for (const p of pnls) {
    if (p > 0) {
      w++;
      l = 0;
    } else if (p < 0) {
      l++;
      w = 0;
    } else {
      w = 0;
      l = 0;
    }
    maxW = Math.max(maxW, w);
    maxL = Math.max(maxL, l);
  }
  return { longestWinStreak: maxW, longestLossStreak: maxL };
}

/**
 * Honest performance metrics. Ratios that are undefined (e.g. profit factor with no losses,
 * Sharpe with < 2 return observations) are reported as null rather than as inflated numbers.
 */
export function computeMetrics(trades: TradeLike[], curve: EquityPoint[], startingBalance: number, periodsPerYear: number): PerformanceMetrics {
  const pnls = trades.map((t) => t.netPnl);
  const winsArr = pnls.filter((p) => p > 0);
  const lossArr = pnls.filter((p) => p < 0);
  const grossProfit = winsArr.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(lossArr.reduce((s, p) => s + p, 0));
  const endingEquity = curve.length ? curve[curve.length - 1].equity : startingBalance + pnls.reduce((s, p) => s + p, 0);
  const eq = curve.map((p) => p.equity);
  const rets = eq.slice(1).map((e, i) => (eq[i] > 0 ? e / eq[i] - 1 : 0));
  const sd = stdev(rets);
  const downside = rets.filter((r) => r < 0);
  const dd = downside.length > 1 ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / rets.length) : 0;
  const m = mean(rets);
  const winRate = trades.length ? winsArr.length / trades.length : 0;
  const avgWin = winsArr.length ? grossProfit / winsArr.length : 0;
  const avgLoss = lossArr.length ? grossLoss / lossArr.length : 0;
  return {
    startingBalance,
    endingEquity,
    totalReturn: startingBalance > 0 ? (endingEquity - startingBalance) / startingBalance : 0,
    totalPnl: endingEquity - startingBalance,
    numberOfTrades: trades.length,
    wins: winsArr.length,
    losses: lossArr.length,
    winRate,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    grossProfit,
    grossLoss,
    expectancy: winRate * avgWin - (1 - winRate) * avgLoss,
    averageTrade: trades.length ? pnls.reduce((s, p) => s + p, 0) / trades.length : 0,
    averageWin: avgWin,
    averageLoss: avgLoss,
    maxDrawdown: maxDrawdown(eq.length ? eq : [startingBalance]),
    sharpe: rets.length > 1 && sd > 0 ? (m / sd) * Math.sqrt(periodsPerYear) : null,
    sortino: rets.length > 1 && dd > 0 ? (m / dd) * Math.sqrt(periodsPerYear) : null,
    ...streaks(pnls),
    totalFees: trades.reduce((s, t) => s + (t.fees ?? 0), 0),
    totalSlippage: trades.reduce((s, t) => s + (t.slippage ?? 0), 0),
  };
}

export const periodsPerYearFor = (timeframeMs: number) => (365 * 86_400_000) / timeframeMs;
