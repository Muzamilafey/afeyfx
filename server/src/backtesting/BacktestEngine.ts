import type { Candle, Direction } from '../types';
import { TIMEFRAME_MS, type Timeframe } from '../types';
import type { BaseStrategy, OpenPositionView } from '../strategies/Strategy';
import { MarketRegimeService } from '../services/analysis/MarketRegimeService';
import { DEFAULT_RISK_CONFIG, RiskEngine, type RiskConfig } from '../risk/RiskEngine';
import { computeMetrics, periodsPerYearFor, type EquityPoint, type PerformanceMetrics } from '../portfolio/metrics';

export interface BacktestConfig {
  startingBalance: number;
  feeRate: number; // per side
  slippagePct: number; // per fill, adverse
  spreadPct: number; // full spread; half paid on each fill
  timeframe: Timeframe;
  risk: Partial<RiskConfig>;
  /** Max candles of history passed to the strategy at each step. */
  lookbackWindow: number;
  /** Trades are only opened at/after this index; earlier bars are warm-up history. */
  startIndex?: number;
  endIndex?: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  startingBalance: 10_000,
  feeRate: 0.001,
  slippagePct: 0.0005,
  spreadPct: 0.0005,
  timeframe: '1h',
  risk: {},
  lookbackWindow: 300,
};

export interface BacktestTrade {
  direction: Direction;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  amount: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  returnPct: number;
  exitReason: string;
  entryReason: string;
  barsHeld: number;
}

export interface BacktestResult {
  metrics: PerformanceMetrics;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  signalsGenerated: number;
  signalsRejectedByRisk: number;
  warnings: string[];
  candles: number;
  from: number;
  to: number;
}

interface OpenPos {
  direction: Direction;
  amount: number;
  entryPrice: number;
  entryTime: number;
  entryIndex: number;
  stopLoss: number;
  takeProfit?: number;
  entryFee: number;
  entrySlippage: number;
  entryReason: string;
}

/**
 * Event-driven, bar-by-bar backtester.
 *
 * Look-ahead protection:
 *  - At bar i the strategy sees only candles[0..i] (bar i is closed).
 *  - Orders generated at the close of bar i fill at the OPEN of bar i+1 (never at bar i's close).
 *  - Stop-loss / take-profit are checked against bar i+1's high/low; if both are touched in the
 *    same bar the STOP is assumed to fill first (conservative). Gaps through a stop fill at the open.
 *  - Fees, half-spread and slippage are charged on every fill, always against the trader.
 */
export class BacktestEngine {
  private regime = new MarketRegimeService();

  run(strategy: BaseStrategy, candles: Candle[], cfgIn: Partial<BacktestConfig> = {}): BacktestResult {
    const cfg = { ...DEFAULT_BACKTEST_CONFIG, ...cfgIn };
    const risk = new RiskEngine({ ...DEFAULT_RISK_CONFIG, ...cfg.risk });
    const warnings: string[] = [];
    this.validateCandles(candles, cfg.timeframe, warnings);

    const start = Math.max(cfg.startIndex ?? 0, strategy.minCandles);
    const end = Math.min(cfg.endIndex ?? candles.length - 1, candles.length - 1);
    let cash = cfg.startingBalance;
    let pos: OpenPos | null = null;
    let pendingEntry: { direction: Direction; stopLoss: number; takeProfit?: number; amount: number; reason: string } | null = null;
    let pendingExit: string | null = null;
    const trades: BacktestTrade[] = [];
    const curve: EquityPoint[] = [];
    let signals = 0;
    let rejected = 0;
    let dayKey = -1;
    let weekKey = -1;
    let dayStart = cash;
    let weekStart = cash;
    const halfSpread = cfg.spreadPct / 2;

    const fillPrice = (ref: number, side: 'buy' | 'sell') => (side === 'buy' ? ref * (1 + halfSpread + cfg.slippagePct) : ref * (1 - halfSpread - cfg.slippagePct));

    const closePosition = (p: OpenPos, ref: number, time: number, idx: number, reason: string, refIsExact = false) => {
      const side = p.direction === 'LONG' ? 'sell' : 'buy';
      const price = refIsExact ? ref : fillPrice(ref, side);
      const exitFee = price * p.amount * cfg.feeRate;
      const exitSlip = Math.abs(price - ref) * p.amount;
      const gross = p.direction === 'LONG' ? (price - p.entryPrice) * p.amount : (p.entryPrice - price) * p.amount;
      const fees = p.entryFee + exitFee;
      const net = gross - fees;
      cash += p.direction === 'LONG' ? price * p.amount - exitFee : gross - exitFee + p.entryPrice * p.amount;
      trades.push({
        direction: p.direction,
        entryTime: p.entryTime,
        exitTime: time,
        entryPrice: p.entryPrice,
        exitPrice: price,
        amount: p.amount,
        grossPnl: gross,
        fees,
        slippage: p.entrySlippage + exitSlip,
        netPnl: net,
        returnPct: net / (p.entryPrice * p.amount),
        exitReason: reason,
        entryReason: p.entryReason,
        barsHeld: idx - p.entryIndex,
      });
    };

    const markEquity = (price: number) => {
      if (!pos) return cash;
      return pos.direction === 'LONG' ? cash + pos.amount * price : cash + (pos.entryPrice - price) * pos.amount + pos.entryPrice * pos.amount;
    };

    for (let i = start; i <= end; i++) {
      const bar = candles[i];
      const dk = Math.floor(bar.timestamp / 86_400_000);
      const wk = Math.floor((bar.timestamp / 86_400_000 + 3) / 7); // weeks starting Monday
      const eqOpen = markEquity(bar.open);
      if (dk !== dayKey) {
        dayKey = dk;
        dayStart = eqOpen;
      }
      if (wk !== weekKey) {
        weekKey = wk;
        weekStart = eqOpen;
      }

      // 1) Execute orders decided at previous close, at this bar's open.
      if (pendingExit && pos) {
        closePosition(pos, bar.open, bar.timestamp, i, pendingExit);
        pos = null;
      }
      pendingExit = null;
      if (pendingEntry && !pos) {
        const side = pendingEntry.direction === 'LONG' ? 'buy' : 'sell';
        const price = fillPrice(bar.open, side);
        const gapThroughStop = pendingEntry.direction === 'LONG' ? price <= pendingEntry.stopLoss : price >= pendingEntry.stopLoss;
        if (gapThroughStop) {
          warnings.push(`Entry at ${new Date(bar.timestamp).toISOString()} skipped: opened through stop`);
        } else {
          const amount = Math.min(pendingEntry.amount, (cash * 0.999) / price);
          if (amount > 0) {
            const fee = price * amount * cfg.feeRate;
            cash -= pendingEntry.direction === 'LONG' ? price * amount + fee : price * amount + fee;
            pos = {
              direction: pendingEntry.direction,
              amount,
              entryPrice: price,
              entryTime: bar.timestamp,
              entryIndex: i,
              stopLoss: pendingEntry.stopLoss,
              takeProfit: pendingEntry.takeProfit,
              entryFee: fee,
              entrySlippage: Math.abs(price - bar.open) * amount,
              entryReason: pendingEntry.reason,
            };
          }
        }
      }
      pendingEntry = null;

      // 2) Intrabar stop-loss / take-profit (stop first if both touched).
      if (pos) {
        const p: OpenPos = pos;
        const isLong = p.direction === 'LONG';
        const stopHit = isLong ? bar.low <= p.stopLoss : bar.high >= p.stopLoss;
        const tpHit = p.takeProfit !== undefined && (isLong ? bar.high >= p.takeProfit : bar.low <= p.takeProfit);
        if (stopHit) {
          const gapped = isLong ? bar.open <= p.stopLoss : bar.open >= p.stopLoss;
          closePosition(p, gapped ? bar.open : p.stopLoss, bar.timestamp, i, 'STOP_LOSS');
          pos = null;
        } else if (tpHit) {
          const gapped = isLong ? bar.open >= p.takeProfit! : bar.open <= p.takeProfit!;
          // Take-profit is a resting limit: fills at the limit price (or better on a gap), minus fees only.
          closePosition(p, gapped ? bar.open : p.takeProfit!, bar.timestamp, i, 'TAKE_PROFIT', true);
          pos = null;
        }
      }

      const equity = markEquity(bar.close);
      curve.push({ t: bar.timestamp, equity });

      if (i === end) break; // no new decisions on the last bar (nothing to fill against)

      // 3) Decide at this bar's close using only candles[0..i].
      const visible = candles.slice(Math.max(0, i + 1 - cfg.lookbackWindow), i + 1);
      const regime = this.regime.detect(visible);
      const view: OpenPositionView | undefined = pos
        ? { direction: pos.direction, entryPrice: pos.entryPrice, amount: pos.amount, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit, openedAt: pos.entryTime, barsHeld: i - pos.entryIndex }
        : undefined;
      const sig = strategy.generateSignal({ symbol: 'BACKTEST', timeframe: cfg.timeframe, candles: visible, regime, position: view });

      if (pos && sig.action === 'EXIT') {
        pendingExit = sig.reason || 'STRATEGY_EXIT';
      } else if (!pos && (sig.action === 'LONG' || sig.action === 'SHORT')) {
        signals++;
        const v = strategy.validateEntry({ symbol: 'BACKTEST', timeframe: cfg.timeframe, candles: visible, regime }, sig);
        const evalr = risk.evaluate({
          mode: 'BACKTEST',
          symbol: 'BACKTEST',
          direction: sig.action,
          entryPrice: bar.close,
          stopLoss: sig.stopLoss!,
          takeProfit: sig.takeProfit,
          feeRate: cfg.feeRate,
          expectedSlippagePct: cfg.slippagePct,
          account: { equity, available: cash, dayStartEquity: dayStart, weekStartEquity: weekStart },
          openPositions: [],
          market: { bid: bar.close * (1 - halfSpread), ask: bar.close * (1 + halfSpread), dataAgeMs: 0, maxDataAgeMs: 1 },
          circuitBreaker: { open: false, reasons: [] },
        });
        if (v.valid && evalr.approved) {
          pendingEntry = { direction: sig.action, stopLoss: sig.stopLoss!, takeProfit: sig.takeProfit, amount: evalr.positionSize, reason: sig.reason };
        } else {
          rejected++;
        }
      }
    }

    if (pos) {
      const last = candles[end];
      closePosition(pos, last.close, last.timestamp, end, 'END_OF_DATA');
      pos = null;
      curve[curve.length - 1] = { t: last.timestamp, equity: cash };
    }

    const tfMs = TIMEFRAME_MS[cfg.timeframe] ?? 3_600_000;
    if (trades.length < 30) warnings.push(`Only ${trades.length} trades - results are not statistically meaningful`);
    return {
      metrics: computeMetrics(trades, curve, cfg.startingBalance, periodsPerYearFor(tfMs)),
      trades,
      equityCurve: curve,
      signalsGenerated: signals,
      signalsRejectedByRisk: rejected,
      warnings,
      candles: end - start + 1,
      from: candles[start]?.timestamp ?? 0,
      to: candles[end]?.timestamp ?? 0,
    };
  }

  private validateCandles(candles: Candle[], tf: Timeframe, warnings: string[]) {
    const step = TIMEFRAME_MS[tf];
    let gaps = 0;
    for (let i = 1; i < candles.length; i++) {
      const d = candles[i].timestamp - candles[i - 1].timestamp;
      if (d <= 0) throw new Error(`Candles not strictly ascending at index ${i}`);
      if (step && d !== step) gaps++;
    }
    if (gaps) warnings.push(`${gaps} gaps/irregular intervals detected in candle data`);
  }
}

export const backtestEngine = new BacktestEngine();
