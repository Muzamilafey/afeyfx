import { randomUUID } from 'crypto';
import { PositionModel } from '../models/Position';
import { TradeModel } from '../models/Trade';
import { Fill } from '../models/Fill';
import { OrderModel } from '../models/Order';
import { marketDataCache } from '../marketData/MarketDataCache';
import { portfolioService } from '../portfolio/PortfolioService';
import type { Direction } from '../types';
import { eventBus } from '../utils/eventBus';
import { errorMessage, logger } from '../utils/logger';
import { orderExecutionService, type OrderExecutionService, type OrderPurpose } from './OrderExecutionService';
import { notificationService } from '../notifications/NotificationService';

type Mode = 'PAPER' | 'LIVE';
type OrderDoc = InstanceType<typeof OrderModel>;

export interface OpenParams {
  mode: Mode;
  exchange: string;
  symbol: string;
  direction: Direction;
  amount: number;
  stopLoss: number;
  takeProfit?: number;
  trailingPct?: number;
  strategyKey?: string;
  timeframe?: string;
  signal?: string;
  aiAnalysis?: string;
  riskEvaluation?: unknown;
  idempotencyKey: string;
  user?: string;
}

/**
 * Turns verified fills into positions and trades. Positions are created ONLY from actual filled
 * quantity and average fill price - never from requested amounts.
 */
export class PositionManager {
  constructor(private exec: OrderExecutionService = orderExecutionService) {}

  async open(p: OpenParams) {
    const order = await this.exec.submit({
      mode: p.mode,
      exchange: p.exchange,
      symbol: p.symbol,
      side: p.direction === 'LONG' ? 'buy' : 'sell',
      type: 'market',
      amount: p.amount,
      idempotencyKey: p.idempotencyKey,
      purpose: 'ENTRY',
      strategyKey: p.strategyKey,
      signal: p.signal,
      aiAnalysis: p.aiAnalysis,
      riskEvaluation: p.riskEvaluation,
      user: p.user,
    });
    if (!(order.filled > 0) || !order.averagePrice) return { order, position: null };
    const existing = await PositionModel.findOne({ entryOrder: order._id });
    if (existing) return { order, position: existing };

    const fees = order.fee ?? 0;
    const position = await PositionModel.create({
      mode: p.mode,
      user: p.user,
      exchange: p.exchange,
      symbol: p.symbol,
      direction: p.direction,
      amount: order.filled,
      entryPrice: order.averagePrice,
      currentPrice: order.averagePrice,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      trailingPct: p.trailingPct,
      highWatermark: order.averagePrice,
      lowWatermark: order.averagePrice,
      fees,
      strategyKey: p.strategyKey,
      timeframe: p.timeframe,
      signal: p.signal,
      aiAnalysis: p.aiAnalysis,
      entryOrder: order._id,
      riskAmount: Math.abs(order.averagePrice - p.stopLoss) * order.filled,
      riskEvaluation: p.riskEvaluation,
    });
    order.position = position._id;
    await order.save();
    await portfolioService.applyEntry(p.mode, order.averagePrice * order.filled, fees);

    if (p.mode === 'LIVE') await this.placeProtectiveStop(position).catch((err) => logger.error({ err: errorMessage(err) }, 'Protective stop placement failed'));
    eventBus.publish('position', position.toJSON());
    void notificationService.notify('TRADE_OPENED', `${p.mode} ${p.direction} ${p.symbol}`, `Opened ${order.filled} @ ${order.averagePrice} (SL ${p.stopLoss}${p.takeProfit ? `, TP ${p.takeProfit}` : ''}) via ${p.strategyKey ?? 'manual'}`);
    return { order, position };
  }

  /** LIVE only: exchange-side stop so a crash of this process does not leave the position naked. */
  private async placeProtectiveStop(position: InstanceType<typeof PositionModel>) {
    if (!position.stopLoss) return;
    const o = await this.exec.submit({
      mode: 'LIVE',
      exchange: position.exchange,
      symbol: position.symbol,
      side: position.direction === 'LONG' ? 'sell' : 'buy',
      type: 'stop_loss',
      amount: position.amount,
      stopPrice: position.stopLoss,
      idempotencyKey: `protect:${position._id.toString()}`,
      purpose: 'STOP_LOSS',
      reduceOnly: true,
      position: position._id,
      strategyKey: position.strategyKey ?? undefined,
    });
    position.protectiveOrder = o._id;
    await position.save();
  }

  async close(positionId: string, reason: string, purpose: OrderPurpose = 'EXIT', keySuffix = '') {
    const position = await PositionModel.findById(positionId);
    if (!position || position.status !== 'OPEN') return null;

    if (position.protectiveOrder) {
      await this.exec.cancel(position.protectiveOrder.toString()).catch((err) => logger.warn({ err: errorMessage(err) }, 'Protective stop cancel failed'));
      const prot = await OrderModel.findById(position.protectiveOrder);
      if (prot?.status === 'FILLED') return this.finalize(position, prot, 'STOP_LOSS (exchange)');
    }

    const order = await this.exec.submit({
      mode: position.mode as Mode,
      exchange: position.exchange,
      symbol: position.symbol,
      side: position.direction === 'LONG' ? 'sell' : 'buy',
      type: 'market',
      amount: position.amount,
      idempotencyKey: `exit:${position._id.toString()}:${keySuffix || randomUUID()}`,
      purpose,
      reduceOnly: true,
      position: position._id,
      strategyKey: position.strategyKey ?? undefined,
    });
    if (!(order.filled > 0) || !order.averagePrice) {
      logger.error({ position: position._id.toString(), status: order.status, reason: order.rejectReason }, 'Exit order not filled');
      return null;
    }
    return this.finalize(position, order, reason);
  }

  private async finalize(position: InstanceType<typeof PositionModel>, order: OrderDoc, reason: string) {
    const mode = position.mode as Mode;
    const amount = Math.min(order.filled, position.amount);
    const exitPrice = order.averagePrice!;
    const exitFee = (order.fee ?? 0) * (amount / order.filled);
    const entryFeeShare = (position.fees ?? 0) * (amount / position.amount);
    const gross = await portfolioService.applyExit(mode, position.direction as Direction, position.entryPrice, exitPrice, amount, exitFee);
    const slippage = (await Fill.find({ order: { $in: [position.entryOrder, order._id].filter(Boolean) as never } }).lean()).reduce((s, f) => s + (f.slippage ?? 0), 0);
    const net = gross - entryFeeShare - exitFee;

    const trade = await TradeModel.create({
      mode,
      user: position.user,
      exchange: position.exchange,
      symbol: position.symbol,
      direction: position.direction,
      strategyKey: position.strategyKey,
      timeframe: position.timeframe,
      amount,
      entryPrice: position.entryPrice,
      exitPrice,
      grossPnl: gross,
      fees: entryFeeShare + exitFee,
      slippage,
      netPnl: net,
      returnPct: net / (position.entryPrice * amount),
      exitReason: reason,
      position: position._id,
      signal: position.signal,
      aiAnalysis: position.aiAnalysis,
      riskEvaluation: position.riskEvaluation,
      entryOrder: position.entryOrder,
      exitOrder: order._id,
      openedAt: position.openedAt,
      closedAt: new Date(),
    });

    const remaining = position.amount - amount;
    if (remaining > 1e-12) {
      position.amount = remaining;
      position.fees = (position.fees ?? 0) - entryFeeShare;
      position.realizedPnl = (position.realizedPnl ?? 0) + net;
    } else {
      position.status = 'CLOSED';
      position.closedAt = new Date();
      position.exitOrder = order._id;
      position.exitReason = reason;
      position.realizedPnl = (position.realizedPnl ?? 0) + net;
      position.unrealizedPnl = 0;
      position.currentPrice = exitPrice;
    }
    await position.save();
    await portfolioService.revalue(mode).catch(() => undefined);
    eventBus.publish('position', position.toJSON());
    eventBus.publish('trade', trade.toJSON());

    const kind = /stop/i.test(reason) ? 'STOP_LOSS' : /take profit/i.test(reason) ? 'TAKE_PROFIT' : 'TRADE_CLOSED';
    void notificationService.notify(kind, `${mode} ${position.direction} ${position.symbol} closed`, `${reason}: exit ${exitPrice}, net P&L ${net.toFixed(2)} (fees ${(entryFeeShare + exitFee).toFixed(2)})`);
    return { order, trade, position };
  }

  /**
   * Check open positions against stop-loss, take-profit and trailing stops using live bid/ask.
   * Exits are risk-reducing and are allowed even while the circuit breaker is open.
   */
  async monitor(mode: Mode) {
    const open = await PositionModel.find({ mode, status: 'OPEN' });
    for (const p of open) {
      const t = marketDataCache.getTicker(p.exchange, p.symbol)?.data;
      if (!t || !(t.bid > 0 && t.ask > 0)) continue;
      const px = p.direction === 'LONG' ? t.bid : t.ask;
      if (p.trailingPct && p.trailingPct > 0) {
        if (p.direction === 'LONG') {
          p.highWatermark = Math.max(p.highWatermark ?? px, px);
          const trail = p.highWatermark * (1 - p.trailingPct);
          if (!p.stopLoss || trail > p.stopLoss) p.stopLoss = trail;
        } else {
          p.lowWatermark = Math.min(p.lowWatermark ?? px, px);
          const trail = p.lowWatermark * (1 + p.trailingPct);
          if (!p.stopLoss || trail < p.stopLoss) p.stopLoss = trail;
        }
        await p.save();
      }
      const isLong = p.direction === 'LONG';
      const key = `${Math.floor(Date.now() / 60_000)}`;
      if (p.stopLoss && (isLong ? px <= p.stopLoss : px >= p.stopLoss)) {
        await this.close(p._id.toString(), 'Stop loss', 'STOP_LOSS', `sl:${key}`).catch((err) => logger.error({ err: errorMessage(err) }, 'Stop-loss exit failed'));
      } else if (p.takeProfit && (isLong ? px >= p.takeProfit : px <= p.takeProfit)) {
        await this.close(p._id.toString(), 'Take profit', 'TAKE_PROFIT', `tp:${key}`).catch((err) => logger.error({ err: errorMessage(err) }, 'Take-profit exit failed'));
      }
    }
  }

  async closeAll(mode: Mode, reason: string) {
    const open = await PositionModel.find({ mode, status: 'OPEN' });
    const results = { closed: 0, failed: [] as string[] };
    for (const p of open) {
      try {
        const r = await this.close(p._id.toString(), reason, 'EMERGENCY', `closeall:${Date.now()}`);
        if (r) results.closed++;
        else results.failed.push(`${p.symbol}: exit not filled`);
      } catch (err) {
        results.failed.push(`${p.symbol}: ${errorMessage(err)}`);
      }
    }
    return results;
  }
}

export const positionManager = new PositionManager();
