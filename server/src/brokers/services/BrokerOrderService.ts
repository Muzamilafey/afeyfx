import { BrokerConnectionModel, type BrokerConnectionDoc } from '../../models/BrokerConnection';
import { Fill } from '../../models/Fill';
import { OrderModel } from '../../models/Order';
import { PositionModel } from '../../models/Position';
import { RiskEventModel } from '../../models/RiskEvent';
import { AppError } from '../../utils/errors';
import { eventBus } from '../../utils/eventBus';
import { errorMessage } from '../../utils/logger';
import { BrokerError, type BrokerOrderRequest, type BrokerOrderResult, type Side } from '../core/types';
import { brokerAccounts, brokerMarketData, brokerPositions, tripConnection } from './BrokerDataServices';
import { brokerRegistry, logBrokerEvent } from './BrokerRegistry';
import { brokerRisk, type BrokerRiskResult } from './BrokerRiskService';

/**
 * Order pipeline for user broker accounts:
 *   validation → risk approval (server-side) → idempotency → broker submission → broker
 *   confirmation → position record.
 * An order is FILLED only when the broker confirms it. Ambiguous submissions are looked up at the
 * broker before anything else; if still unresolved they stay UNKNOWN, the account is halted for
 * new orders, and reconciliation resolves them. Nothing is ever retried blindly.
 */
export interface SubmitInput {
  userId: string;
  connectionId: string;
  idempotencyKey: string;
  brokerSymbol: string;
  side: Side;
  product: BrokerOrderRequest['product'];
  type?: 'market' | 'limit' | 'stop';
  volume?: number;
  stake?: number;
  multiplier?: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  duration?: number;
  durationUnit?: BrokerOrderRequest['durationUnit'];
  source: 'manual' | 'strategy';
  strategyKey?: string;
  signalId?: string;
  aiAnalysisId?: string;
  /** Pre-computed risk result (strategy dispatch) to avoid evaluating twice. */
  risk?: BrokerRiskResult;
}

export class BrokerOrderService {
  async ownedConnection(userId: string, connectionId: string) {
    const c = await BrokerConnectionModel.findOne({ _id: connectionId, user: userId });
    if (!c) throw new AppError(404, 'Broker connection not found');
    return c;
  }

  /** Risk-evaluate (and size) an order without sending it. */
  async evaluate(conn: BrokerConnectionDoc, i: Omit<SubmitInput, 'userId' | 'connectionId' | 'idempotencyKey' | 'source'> & { userSized: boolean }) {
    const adapter = await brokerRegistry.get(conn);
    const account = await adapter.getAccount();
    await brokerAccounts.sync(conn, account).catch(() => undefined);
    const fresh = (await BrokerConnectionModel.findById(conn._id))!;
    let instrument = await brokerMarketData.instrument(conn._id.toString(), i.brokerSymbol);
    if (!instrument) {
      await brokerMarketData.syncInstruments(fresh).catch(() => undefined);
      instrument = await brokerMarketData.instrument(conn._id.toString(), i.brokerSymbol);
    }
    if (!brokerMarketData.quote(conn._id.toString(), i.brokerSymbol)) await adapter.subscribeQuotes([i.brokerSymbol]).catch(() => undefined);
    return brokerRisk.evaluate({
      conn: fresh,
      account,
      instrument,
      req: { clientOrderId: '', brokerSymbol: i.brokerSymbol, side: i.side, product: i.product, type: i.type ?? 'market', volume: i.volume, stake: i.stake, multiplier: i.multiplier, price: i.price, stopLoss: i.stopLoss, takeProfit: i.takeProfit, duration: i.duration, durationUnit: i.durationUnit, currency: account.currency },
      stopPrice: i.stopLoss,
      takeProfitPrice: i.takeProfit,
      userSized: i.userSized,
    });
  }

  async submit(i: SubmitInput) {
    const conn = await this.ownedConnection(i.userId, i.connectionId);
    const key = `bk:${conn._id.toString()}:${i.idempotencyKey}`;
    const existing = await OrderModel.findOne({ idempotencyKey: key });
    if (existing) return { order: existing, duplicate: true }; // never sent twice
    const mode = conn.environment === 'real' ? 'LIVE' : 'DEMO';

    const risk = i.risk ?? (await this.evaluate(conn, { ...i, userSized: i.volume !== undefined || i.stake !== undefined }));
    const req: BrokerOrderRequest = { ...risk.order, clientOrderId: key };
    let order;
    try {
      order = await OrderModel.create({
        mode,
        user: conn.user,
        connection: conn._id,
        broker: conn.provider,
        idempotencyKey: key,
        exchange: conn.provider,
        symbol: req.brokerSymbol,
        side: req.side,
        type: req.type === 'market' ? 'market' : req.type === 'limit' ? 'limit' : 'stop_loss',
        amount: req.volume ?? req.stake ?? 0,
        price: req.price,
        stopPrice: req.stopLoss,
        status: risk.approved ? 'PENDING' : 'REJECTED',
        rejectReason: risk.approved ? undefined : risk.reasons.join('; ').slice(0, 1000),
        purpose: i.source === 'manual' ? 'MANUAL' : 'ENTRY',
        strategyKey: i.strategyKey,
        signal: i.signalId as never,
        aiAnalysis: i.aiAnalysisId as never,
        riskEvaluation: { product: req.product, multiplier: req.multiplier, approved: risk.approved, checks: risk.checks, maxLoss: risk.maxLoss, exposure: risk.exposure, leverage: risk.leverage, quote: risk.quote },
        closedAt: risk.approved ? undefined : new Date(),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return { order: (await OrderModel.findOne({ idempotencyKey: key }))!, duplicate: true };
      throw err;
    }
    if (!risk.approved) {
      await RiskEventModel.create({ type: 'TRADE_REJECTED', severity: 'INFO', mode, symbol: req.brokerSymbol, strategyKey: i.strategyKey, message: `[${conn.provider} ${conn.environment}] ${risk.reasons.join('; ')}`.slice(0, 1000) }).catch(() => undefined);
      await logBrokerEvent(conn, 'ORDER_REJECTED_RISK', risk.reasons.join('; '), { idempotencyKey: i.idempotencyKey }, 'warn');
      eventBus.publish('order', order.toJSON());
      return { order, duplicate: false };
    }

    const adapter = await brokerRegistry.get(conn);
    order.status = 'SUBMITTED';
    order.submittedAt = new Date();
    order.attempts = 1;
    await order.save();
    const startedAt = Date.now();
    let result: BrokerOrderResult;
    try {
      result = await adapter.submitOrder(req);
    } catch (err) {
      const be = err instanceof BrokerError ? err : new BrokerError('ambiguous', errorMessage(err));
      order.exchangeResponses.push({ at: new Date(), kind: 'submit-error', error: be.message, kind2: be.kind });
      if (be.definite) result = { status: 'REJECTED', rejectReason: be.message, verified: true };
      else {
        // Ambiguous: ask the broker what happened BEFORE doing anything else.
        const found = await adapter.lookupOrder(key, { brokerSymbol: req.brokerSymbol, since: startedAt, side: req.side }).catch(() => null);
        result = found ?? { status: 'UNKNOWN', rejectReason: `Execution not confirmed: ${be.message}`, verified: false };
      }
    }
    return { order: await this.applyResult(conn, order, req, result, i), duplicate: false };
  }

  /** Persist a broker result: order status, execution record, position, failure streaks. */
  async applyResult(conn: BrokerConnectionDoc, order: InstanceType<typeof OrderModel>, req: BrokerOrderRequest, result: BrokerOrderResult, ctx: Partial<SubmitInput> = {}) {
    order.status = result.status;
    order.brokerOrderId = result.brokerOrderId;
    order.brokerRef = result.brokerPositionId;
    order.exchangeOrderId = result.brokerOrderId ?? result.brokerPositionId;
    order.filled = result.filledVolume ?? (result.status === 'FILLED' ? (req.volume ?? req.stake ?? 0) : 0);
    order.averagePrice = result.averagePrice;
    order.fee = result.fee ?? 0;
    order.rejectReason = result.rejectReason;
    order.lastCheckedAt = new Date();
    order.exchangeResponses.push({ at: new Date(), kind: 'broker-result', status: result.status, verified: result.verified, raw: result.raw });
    if (['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(result.status)) order.closedAt = new Date();
    await order.save();
    eventBus.publish('order', order.toJSON());

    if (result.status === 'FILLED' && result.brokerPositionId) {
      await Fill.create({ mode: order.mode, order: order._id, connection: conn._id, exchange: conn.provider, exchangeTradeId: `${conn._id.toString()}:${result.brokerOrderId ?? result.brokerPositionId}`, symbol: req.brokerSymbol, side: req.side, price: result.averagePrice ?? req.referencePrice ?? 0, amount: result.filledVolume ?? req.volume ?? req.stake ?? 0, fee: result.fee ?? 0, timestamp: new Date() }).catch(() => undefined);
      const exposure = req.product === 'multiplier' ? (req.stake ?? 0) * (req.multiplier ?? 1) : req.product === 'rise_fall' ? (req.stake ?? 0) : 0;
      try {
        const pos = await PositionModel.create({
          mode: order.mode,
          user: conn.user,
          connection: conn._id,
          broker: conn.provider,
          brokerRef: result.brokerPositionId,
          brokerOrderId: result.brokerOrderId,
          exchange: conn.provider,
          symbol: req.brokerSymbol,
          direction: req.side === 'buy' ? 'LONG' : 'SHORT',
          amount: result.filledVolume ?? req.volume ?? req.stake ?? 0,
          entryPrice: result.averagePrice ?? req.referencePrice ?? 0,
          currentPrice: result.averagePrice ?? req.referencePrice,
          stopLoss: req.stopLoss,
          takeProfit: req.takeProfit,
          strategyKey: ctx.strategyKey ?? (ctx.source === 'manual' ? 'manual' : undefined),
          signal: ctx.signalId as never,
          aiAnalysis: ctx.aiAnalysisId as never,
          entryOrder: order._id,
          riskAmount: (order.riskEvaluation as { maxLoss?: number } | undefined)?.maxLoss,
          brokerData: { product: req.product, cost: result.cost, multiplier: req.multiplier, exposure: exposure || (order.riskEvaluation as { exposure?: number } | undefined)?.exposure, stopLossAmount: req.stopLossAmount, takeProfitAmount: req.takeProfitAmount },
        });
        eventBus.publish('position', pos.toJSON());
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err; // already recorded by reconciliation
      }
      await BrokerConnectionModel.updateOne({ _id: conn._id }, { $set: { consecutiveFailures: 0 } });
      await logBrokerEvent(conn, 'ORDER_FILLED', `${req.side.toUpperCase()} ${req.brokerSymbol} confirmed by ${conn.provider}`, { order: order._id.toString(), brokerRef: result.brokerPositionId });
    } else if (result.status === 'OPEN') {
      await logBrokerEvent(conn, 'ORDER_PLACED', `Pending ${req.side} ${req.brokerSymbol} accepted`, { brokerOrderId: result.brokerOrderId });
    } else {
      const failures = (await BrokerConnectionModel.findOneAndUpdate({ _id: conn._id }, { $inc: { consecutiveFailures: 1 } }, { returnDocument: 'after' }))?.consecutiveFailures ?? 0;
      await logBrokerEvent(conn, result.status === 'UNKNOWN' ? 'ORDER_UNKNOWN' : 'ORDER_REJECTED', result.rejectReason ?? result.status, { order: order._id.toString() }, result.status === 'UNKNOWN' ? 'error' : 'warn');
      if (result.status === 'UNKNOWN') await tripConnection(conn, `Order ${order._id.toString()} could not be verified with the broker; reconciliation required before new orders.`);
      else if (failures >= (conn.riskLimits?.maxConsecutiveFailures ?? 3)) await tripConnection(conn, `${failures} consecutive execution failures`);
    }
    return order;
  }

  /** Close a position at the broker. Success is reported only after the broker confirms it. */
  async closePosition(userId: string, connectionId: string, positionId: string) {
    const conn = await this.ownedConnection(userId, connectionId);
    const pos = await PositionModel.findOne({ _id: positionId, connection: conn._id, user: userId });
    if (!pos) throw new AppError(404, 'Position not found');
    if (pos.status !== 'OPEN') return { confirmed: true, status: 'ALREADY_CLOSED' };
    const adapter = await brokerRegistry.get(conn);
    const r = await adapter.closePosition(pos.brokerRef!, { clientOrderId: `close:${pos._id.toString()}` });
    await logBrokerEvent(conn, 'CLOSE_REQUESTED', `Close ${pos.symbol}: ${r.closed ? 'confirmed' : 'awaiting broker confirmation'}`, { brokerRef: pos.brokerRef });
    if (r.closed) {
      const trade = await brokerPositions.onClosed(conn._id.toString(), r);
      return { confirmed: true, status: 'CLOSED', trade };
    }
    return { confirmed: false, status: 'REQUESTED', message: r.reason ?? 'Close requested; waiting for the broker to confirm' };
  }

  async cancelOrder(userId: string, connectionId: string, orderId: string) {
    const conn = await this.ownedConnection(userId, connectionId);
    const o = await OrderModel.findOne({ _id: orderId, connection: conn._id, user: userId });
    if (!o?.brokerOrderId) throw new AppError(404, 'Order not found');
    const r = await (await brokerRegistry.get(conn)).cancelOrder(o.brokerOrderId);
    if (r.status === 'FILLED' || r.status === 'CANCELLED') {
      o.status = 'CANCELLED';
      o.closedAt = new Date();
      await o.save();
    }
    return { confirmed: r.status === 'FILLED' || r.status === 'CANCELLED', result: r };
  }

  // ------------------------------------------------------------ emergency controls

  async disableTrading(userId: string, connectionId: string, reason: string) {
    const conn = await this.ownedConnection(userId, connectionId);
    conn.tradingEnabled = false;
    conn.liveEnabled = false;
    await conn.save();
    await logBrokerEvent(conn, 'TRADING_DISABLED', reason, undefined, 'warn');
    return conn;
  }

  /** Cancel pending orders where the broker supports it; reports per-order outcome. */
  async cancelAll(userId: string, connectionId: string) {
    const conn = await this.ownedConnection(userId, connectionId);
    const adapter = await brokerRegistry.get(conn);
    if (!adapter.capabilities.has('cancelOrder')) return { supported: false, results: [] as unknown[] };
    const results = [];
    for (const o of await adapter.getOpenOrders()) {
      try {
        const r = await adapter.cancelOrder(o.brokerOrderId);
        results.push({ brokerOrderId: o.brokerOrderId, confirmed: r.status === 'FILLED' || r.status === 'CANCELLED', status: r.status });
      } catch (err) {
        results.push({ brokerOrderId: o.brokerOrderId, confirmed: false, error: errorMessage(err) });
      }
    }
    await logBrokerEvent(conn, 'EMERGENCY_CANCEL', `${results.filter((r) => r.confirmed).length}/${results.length} pending orders cancelled`, { results });
    return { supported: true, results };
  }

  /**
   * Request closure of every open position. Closing can fail (market closed, liquidity, network,
   * broker restrictions); each result says whether the BROKER confirmed it.
   */
  async closeAll(userId: string, connectionId: string) {
    const conn = await this.ownedConnection(userId, connectionId);
    const adapter = await brokerRegistry.get(conn);
    const results = [];
    for (const p of await adapter.getPositions()) {
      try {
        const r = await adapter.closePosition(p.brokerPositionId);
        if (r.closed) await brokerPositions.onClosed(conn._id.toString(), r);
        results.push({ brokerPositionId: p.brokerPositionId, symbol: p.symbol, confirmed: r.closed, message: r.closed ? 'Closed' : (r.reason ?? 'Awaiting confirmation') });
      } catch (err) {
        results.push({ brokerPositionId: p.brokerPositionId, symbol: p.symbol, confirmed: false, message: errorMessage(err) });
      }
    }
    await logBrokerEvent(conn, 'EMERGENCY_CLOSE', `${results.filter((r) => r.confirmed).length}/${results.length} positions confirmed closed`, { results }, results.every((r) => r.confirmed) ? 'info' : 'error');
    return { results };
  }
}

export const brokerOrders = new BrokerOrderService();
