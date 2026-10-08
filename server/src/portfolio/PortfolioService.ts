import { env } from '../config/env';
import { PortfolioModel } from '../models/Portfolio';
import { PortfolioSnapshot } from '../models/PortfolioSnapshot';
import { PositionModel } from '../models/Position';
import { TradeModel } from '../models/Trade';
import { marketDataCache } from '../marketData/MarketDataCache';
import { eventBus } from '../utils/eventBus';
import { computeMetrics, type PerformanceMetrics } from './metrics';
import { quoteOf, usdPer } from './fx';
import type { Direction } from '../types';

export type Mode = 'PAPER' | 'LIVE' | 'REAL';
/** Account owner: null = system strategy book; otherwise a user id (personal demo account). */
export type Owner = string | null;
const ownerQ = (owner: Owner) => (owner ? owner : null);

const startOfUtcDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfUtcWeek = (d = new Date()) => {
  const day = startOfUtcDay(d);
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - dow * 86_400_000);
};

/**
 * Portfolio accounting. PAPER and LIVE portfolios are separate documents; every query is scoped
 * by mode so paper results can never be mixed into live results.
 */
export class PortfolioService {
  async get(mode: Mode, owner: Owner = null) {
    let p = await PortfolioModel.findOne({ mode, owner: ownerQ(owner) });
    if (!p) {
      if (mode === 'LIVE' && owner) throw new Error('Personal accounts are DEMO (PAPER) or REAL, never LIVE');
      if (mode === 'REAL' && !owner) throw new Error('REAL accounts always belong to a user');
      const start = mode === 'PAPER' ? env.PAPER_STARTING_BALANCE : 0;
      p = await PortfolioModel.findOneAndUpdate(
        { mode, owner: ownerQ(owner) },
        { $setOnInsert: { mode, owner: ownerQ(owner), startingBalance: start, balance: start, equity: start, available: start, peakEquity: start, dayStartEquity: start, dayStartAt: startOfUtcDay(), weekStartEquity: start, weekStartAt: startOfUtcWeek() } },
        { upsert: true, new: true },
      );
    }
    return p!;
  }

  /** Mark open positions to market and recompute equity, exposure, drawdown, day/week anchors. */
  async revalue(mode: Mode, owner: Owner = null) {
    const p = await this.get(mode, owner);
    const positions = await PositionModel.find({ mode, status: 'OPEN', user: ownerQ(owner) });
    let unrealized = 0;
    let exposure = 0;
    let collateral = 0;
    for (const pos of positions) {
      const t = marketDataCache.getTicker(pos.exchange, pos.symbol)?.data;
      const px = t ? (pos.direction === 'LONG' ? t.bid : t.ask) || t.last : pos.currentPrice ?? pos.entryPrice;
      // Positions in non-USD quotes (e.g. USD/JPY) are valued in USD: collateral at the entry rate,
      // open P&L at the current rate.
      const entryRate = pos.quoteRate ?? 1;
      const nowRate = usdPer(quoteOf(pos.symbol)) ?? entryRate;
      const uQuote = pos.direction === 'LONG' ? (px - pos.entryPrice) * pos.amount : (pos.entryPrice - px) * pos.amount;
      const u = uQuote * nowRate;
      pos.currentPrice = px;
      pos.unrealizedPnl = u;
      pos.highWatermark = Math.max(pos.highWatermark ?? px, px);
      pos.lowWatermark = Math.min(pos.lowWatermark ?? px, px);
      await pos.save();
      unrealized += u;
      exposure += px * pos.amount * nowRate;
      collateral += pos.entryPrice * pos.amount * entryRate;
    }
    const equity = p.balance + collateral + unrealized;
    const now = new Date();
    if (!p.dayStartAt || p.dayStartAt < startOfUtcDay(now)) {
      p.dayStartAt = startOfUtcDay(now);
      p.dayStartEquity = equity;
    }
    if (!p.weekStartAt || p.weekStartAt < startOfUtcWeek(now)) {
      p.weekStartAt = startOfUtcWeek(now);
      p.weekStartEquity = equity;
    }
    p.unrealizedPnl = unrealized;
    p.exposure = exposure;
    p.equity = equity;
    p.available = p.balance;
    p.peakEquity = Math.max(p.peakEquity ?? equity, equity);
    p.drawdown = p.peakEquity > 0 ? (p.peakEquity - equity) / p.peakEquity : 0;
    await p.save();
    eventBus.publish('portfolio', this.view(p));
    return p;
  }

  view(p: Awaited<ReturnType<PortfolioService['get']>>) {
    const dayStart = p.dayStartEquity ?? p.equity;
    const weekStart = p.weekStartEquity ?? p.equity;
    return {
      mode: p.mode,
      owner: p.owner ? p.owner.toString() : null,
      baseCurrency: p.baseCurrency,
      startingBalance: p.startingBalance,
      balance: p.balance,
      equity: p.equity,
      available: p.available,
      unrealizedPnl: p.unrealizedPnl,
      realizedPnl: p.realizedPnl,
      fees: p.fees,
      exposure: p.exposure,
      exposurePct: p.equity > 0 ? p.exposure / p.equity : 0,
      drawdown: p.drawdown,
      dailyPnl: p.equity - dayStart,
      dailyPnlPct: dayStart > 0 ? (p.equity - dayStart) / dayStart : 0,
      dailyDrawdownPct: dayStart > 0 ? Math.max(0, (dayStart - p.equity) / dayStart) : 0,
      weeklyDrawdownPct: weekStart > 0 ? Math.max(0, (weekStart - p.equity) / weekStart) : 0,
      totalPnl: p.equity - p.startingBalance,
      dayStartEquity: dayStart,
      weekStartEquity: weekStart,
    };
  }

  /** Apply a filled entry: debit cash (long: notional+fee; short: collateral+fee). */
  async applyEntry(mode: Mode, notional: number, fee: number, owner: Owner = null) {
    await this.get(mode, owner);
    await PortfolioModel.updateOne({ mode, owner: ownerQ(owner) }, { $inc: { balance: -(notional + fee), fees: fee } });
  }

  /**
   * Apply a filled exit and realize P&L: the entry collateral comes back (at the entry rate) plus
   * the P&L converted at the exit rate. `fee` is in quote currency. Returns gross P&L in USD.
   * With rates of 1 (USD/USDT pairs) this is exactly exit proceeds (long) or collateral + P&L (short).
   */
  async applyExit(mode: Mode, direction: Direction, entryPrice: number, exitPrice: number, amount: number, fee: number, owner: Owner = null, entryRate = 1, exitRate = 1) {
    const grossQuote = direction === 'LONG' ? (exitPrice - entryPrice) * amount : (entryPrice - exitPrice) * amount;
    const gross = grossQuote * exitRate;
    const feeUsd = fee * exitRate;
    const credit = entryPrice * amount * entryRate + gross - feeUsd;
    await PortfolioModel.updateOne({ mode, owner: ownerQ(owner) }, { $inc: { balance: credit, fees: feeUsd, realizedPnl: gross - feeUsd } });
    return gross;
  }

  /**
   * Apply a cash flow (deposit credit, payout hold or refund) to a REAL account. The P&L anchors
   * (starting balance, peak, day/week start) move by the same amount, so money moving in or out
   * is never reported as trading profit or loss.
   * With `requireFunds`, the debit only happens if the cash balance covers it (atomic).
   */
  async applyCashFlow(owner: string, amount: number, requireFunds = false) {
    await this.get('REAL', owner);
    const filter: Record<string, unknown> = { mode: 'REAL', owner };
    if (requireFunds && amount < 0) filter.balance = { $gte: -amount - 1e-9 };
    const r = await PortfolioModel.updateOne(filter, { $inc: { balance: amount, startingBalance: amount, peakEquity: amount, dayStartEquity: amount, weekStartEquity: amount } });
    if (r.modifiedCount !== 1) return false;
    await this.revalue('REAL', owner).catch(() => undefined);
    return true;
  }

  async snapshot(mode: Mode, owner: Owner = null) {
    const p = await this.revalue(mode, owner);
    const open = await PositionModel.countDocuments({ mode, status: 'OPEN', user: ownerQ(owner) });
    await PortfolioSnapshot.create({ mode, owner: ownerQ(owner), timestamp: new Date(), balance: p.balance, equity: p.equity, unrealizedPnl: p.unrealizedPnl, realizedPnl: p.realizedPnl, fees: p.fees, exposure: p.exposure, drawdown: p.drawdown, openPositions: open });
  }

  /** Performance broken down by strategy / symbol / timeframe for one mode. Losing trades are included. */
  async performance(mode: Mode, groupBy?: 'strategyKey' | 'symbol' | 'timeframe', owner: Owner = null): Promise<{ overall: PerformanceMetrics; groups: Record<string, PerformanceMetrics> }> {
    const p = await this.get(mode, owner);
    const trades = await TradeModel.find({ mode, user: ownerQ(owner) }).sort({ closedAt: 1 }).lean();
    const snaps = await PortfolioSnapshot.find({ mode, owner: ownerQ(owner) }).sort({ timestamp: 1 }).lean();
    const curve = snaps.map((s) => ({ t: new Date(s.timestamp).getTime(), equity: s.equity ?? 0 }));
    const periodsPerYear = 365 * 24 * 12; // snapshots every 5 minutes
    const toLike = (t: (typeof trades)[number]) => ({ netPnl: t.netPnl ?? 0, fees: t.fees ?? 0, slippage: t.slippage ?? 0 });
    const overall = computeMetrics(trades.map(toLike), curve, p.startingBalance, periodsPerYear);
    const groups: Record<string, PerformanceMetrics> = {};
    if (groupBy) {
      const buckets = new Map<string, typeof trades>();
      for (const t of trades) {
        const k = String((t as Record<string, unknown>)[groupBy] ?? 'unknown');
        buckets.set(k, [...(buckets.get(k) ?? []), t]);
      }
      for (const [k, ts] of buckets) {
        // Per-group equity curve built from cumulative P&L (no allocation assumptions).
        let eq = p.startingBalance;
        const c = ts.map((t) => ({ t: new Date(t.closedAt ?? 0).getTime(), equity: (eq += t.netPnl ?? 0) }));
        groups[k] = computeMetrics(ts.map(toLike), [{ t: 0, equity: p.startingBalance }, ...c], p.startingBalance, 365);
      }
    }
    return { overall, groups };
  }
}

export const portfolioService = new PortfolioService();

/** Reset a personal demo account to the starting balance (only when flat). */
export async function resetDemoAccount(owner: string) {
  const open = await PositionModel.countDocuments({ mode: 'PAPER', status: 'OPEN', user: owner });
  if (open) throw new Error('Close all open positions before resetting the demo account');
  const start = env.PAPER_STARTING_BALANCE;
  await PortfolioModel.updateOne(
    { mode: 'PAPER', owner },
    { $set: { startingBalance: start, balance: start, equity: start, available: start, unrealizedPnl: 0, realizedPnl: 0, fees: 0, exposure: 0, peakEquity: start, drawdown: 0, dayStartEquity: start, weekStartEquity: start } },
    { upsert: true },
  );
  await PortfolioSnapshot.deleteMany({ mode: 'PAPER', owner });
  return portfolioService.revalue('PAPER', owner);
}
