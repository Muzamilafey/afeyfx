import type { Candle } from '../types';
import { createStrategy } from '../strategies/registry';
import { BacktestEngine, type BacktestConfig, type BacktestTrade } from './BacktestEngine';
import { computeMetrics, periodsPerYearFor, type PerformanceMetrics } from '../portfolio/metrics';
import { TIMEFRAME_MS } from '../types';

export interface WalkForwardConfig {
  trainBars: number;
  validationBars: number;
  testBars: number;
  /** Parameter grid: each key maps to candidate values. */
  paramGrid: Record<string, number[]>;
  /** Minimum trades in TRAIN for a parameter set to be considered. */
  minTrainTrades: number;
  /** How many top TRAIN candidates are re-checked on VALIDATION. */
  topK: number;
  maxCombinations: number;
}

export interface WalkForwardWindow {
  window: number;
  trainRange: [number, number];
  validationRange: [number, number];
  testRange: [number, number];
  selectedParams: Record<string, number> | null;
  train: PerformanceMetrics | null;
  validation: PerformanceMetrics | null;
  outOfSample: PerformanceMetrics | null;
  oosTrades: BacktestTrade[];
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  /** Aggregate of OUT-OF-SAMPLE segments only - the only numbers that should be used to judge the strategy. */
  outOfSampleMetrics: PerformanceMetrics;
  warnings: string[];
}

export function expandGrid(grid: Record<string, number[]>, max: number): Record<string, number>[] {
  let combos: Record<string, number>[] = [{}];
  for (const [k, vals] of Object.entries(grid)) {
    const next: Record<string, number>[] = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [k]: v });
    combos = next;
    if (combos.length > max) {
      combos = combos.slice(0, max);
    }
  }
  return combos;
}

const score = (m: PerformanceMetrics) => (m.sharpe ?? -Infinity) - m.maxDrawdown;

/**
 * Walk-forward analysis: TRAIN -> VALIDATION -> OUT-OF-SAMPLE -> ROLL FORWARD.
 * Parameters are chosen on TRAIN (and confirmed on VALIDATION) and then frozen for the OOS
 * segment, which the optimizer never sees. Each segment may use *earlier* candles as indicator
 * warm-up history, never later ones.
 */
export class WalkForwardAnalyzer {
  private engine = new BacktestEngine();

  run(strategyKey: string, candles: Candle[], wf: WalkForwardConfig, bt: Partial<BacktestConfig>): WalkForwardResult {
    const warnings: string[] = [];
    const proto = createStrategy(strategyKey);
    const warm = proto.minCandles;
    const windows: WalkForwardWindow[] = [];
    const combos = expandGrid(wf.paramGrid, wf.maxCombinations);
    if (combos.length === 0) combos.push({});
    const allOos: BacktestTrade[] = [];
    const oosCurve: { t: number; equity: number }[] = [];
    let equity = bt.startingBalance ?? 10_000;

    let w = 0;
    for (let s = warm; s + wf.trainBars + wf.validationBars + wf.testBars <= candles.length; s += wf.testBars) {
      const tr: [number, number] = [s, s + wf.trainBars - 1];
      const va: [number, number] = [tr[1] + 1, tr[1] + wf.validationBars];
      const te: [number, number] = [va[1] + 1, va[1] + wf.testBars];
      const seg = (params: Record<string, number>, r: [number, number], startingBalance = bt.startingBalance) =>
        this.engine.run(createStrategy(strategyKey, params), candles.slice(0, r[1] + 1), { ...bt, startingBalance, startIndex: r[0], endIndex: r[1] });

      const trained = combos
        .map((p) => ({ p, r: seg(p, tr) }))
        .filter((x) => x.r.metrics.numberOfTrades >= wf.minTrainTrades)
        .sort((a, b) => score(b.r.metrics) - score(a.r.metrics))
        .slice(0, wf.topK);

      const win: WalkForwardWindow = {
        window: w,
        trainRange: [candles[tr[0]].timestamp, candles[tr[1]].timestamp],
        validationRange: [candles[va[0]].timestamp, candles[va[1]].timestamp],
        testRange: [candles[te[0]].timestamp, candles[te[1]].timestamp],
        selectedParams: null,
        train: null,
        validation: null,
        outOfSample: null,
        oosTrades: [],
      };

      if (trained.length) {
        const validated = trained.map((x) => ({ ...x, v: seg(x.p, va) })).sort((a, b) => score(b.v.metrics) - score(a.v.metrics));
        const best = validated[0];
        win.selectedParams = best.p;
        win.train = best.r.metrics;
        win.validation = best.v.metrics;
        const oos = seg(best.p, te, equity);
        win.outOfSample = oos.metrics;
        win.oosTrades = oos.trades;
        allOos.push(...oos.trades);
        oosCurve.push(...oos.equityCurve);
        equity = oos.metrics.endingEquity;
      } else {
        warnings.push(`Window ${w}: no parameter set met minTrainTrades=${wf.minTrainTrades}; OOS segment not traded`);
      }
      windows.push(win);
      w++;
    }
    if (!windows.length) warnings.push('Not enough candles for a single walk-forward window');
    const tfMs = TIMEFRAME_MS[bt.timeframe ?? '1h'];
    return {
      windows,
      outOfSampleMetrics: computeMetrics(allOos, oosCurve, bt.startingBalance ?? 10_000, periodsPerYearFor(tfMs)),
      warnings,
    };
  }
}
