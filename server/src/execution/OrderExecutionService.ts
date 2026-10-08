import * as ccxt from 'ccxt';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { exchangeRegistry } from '../exchanges/registry';
import type { CcxtAdapter } from '../exchanges/CcxtAdapter';
import { OrderModel } from '../models/Order';
import { Fill } from '../models/Fill';
import { circuitBreaker } from '../risk/CircuitBreaker';
import { marketDataCache } from '../marketData/MarketDataCache';
import type { ExchangeOrder, OrderRequest, OrderStatus, OrderType, Side } from '../types';
import { eventBus } from '../utils/eventBus';
import { LiveTradingDisabledError } from '../utils/errors';
import { errorMessage, logger } from '../utils/logger';
import { sleep } from '../utils/math';
import { assertLiveOrderAllowed } from './LiveTradingGuard';
import { PaperBroker } from './PaperBroker';
import { PositionModel } from '../models/Position';
import { brokerService } from '../brokers/BrokerService';
import { BrokerAmbiguousError, type BrokerId } from '../brokers/types';
import { notificationService } from '../notifications/NotificationService';
import { quoteOf, usdPer } from '../portfolio/fx';

export type OrderPurpose = 'ENTRY' | 'EXIT' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL' | 'EMERGENCY';

export interface OrderIntent {
  /** PAPER and REAL (client real-money accounts) fill internally at market prices; only LIVE reaches an exchange. */
  mode: 'PAPER' | 'LIVE' | 'REAL';
  exchange: string;
  symbol: string;
  side: Side;
  type: OrderType;
  amount: number;
  price?: number;
  stopPrice?: number;
  trailingPct?: number;
  /** Required. Same key => same order; retries never create duplicates. */
  idempotencyKey: string;
  purpose: OrderPurpose;
  reduceOnly?: boolean;
  strategyKey?: string;
  signal?: Types.ObjectId | string;
  aiAnalysis?: Types.ObjectId | string;
  riskEvaluation?: unknown;
  position?: Types.ObjectId | string;
  user?: Types.ObjectId | string;
  /** REAL-account entries: protective levels and exposure in USD (used by external brokers). */
  stopLoss?: number;
  takeProfit?: number;
  investmentUsd?: number;
}

const TERMINAL: OrderStatus[] = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'];

export interface ExecutionConfig {
  submitTimeoutMs: number;
  maxSubmitAttempts: number;
  verifyTimeoutMs: number;
  verifyIntervalMs: number;
}

const DEFAULT_EXEC: ExecutionConfig = { submitTimeoutMs: 10_000, maxSubmitAttempts: 3, verifyTimeoutMs: 30_000, verifyIntervalMs: 1_000 };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ccxt.RequestTimeout(`Timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const isNetworkError = (err: unknown) => err instanceof ccxt.NetworkError;

/**
 * Exit price that makes our ledger's P&L equal the broker's reported realized P&L (USD), so the
 * trader's balance always matches what the broker actually paid.
 */
export function brokerExitPrice(pos: { direction?: string | null; entryPrice: number; amount: number; quoteRate?: number | null; symbol: string }, pnlUsd: number | undefined, fallback: number | undefined) {
  if (pnlUsd === undefined || !Number.isFinite(pnlUsd)) return fallback ?? pos.entryPrice;
  const rate = usdPer(quoteOf(pos.symbol)) ?? pos.quoteRate ?? 1;
  const grossQuote = pnlUsd / rate;
  return pos.direction === 'LONG' ? pos.entryPrice + grossQuote / pos.amount : pos.entryPrice - grossQuote / pos.amount;
}

/**
 * Order execution. Paper orders go to the PaperBroker; live orders go through LiveTradingGuard
 * and then the exchange adapter. Guarantees:
 *  - every order has an idempotency key (also sent as the exchange clientOrderId)
 *  - duplicate submissions with the same key return the existing order
 *  - after timeouts/network errors the exchange is queried by clientOrderId BEFORE any retry
 *  - an order is never assumed filled because the create call succeeded; status and fills are
 *    always re-read from the exchange
 */
export class OrderExecutionService {
  paperBroker: PaperBroker;
  /**
   * Internal fills for traders' REAL accounts: same book-walking price model as paper (real spread
   * and depth from the live order book) but no simulated random rejections or artificial latency.
   */
  clientBroker: PaperBroker;

  constructor(
    public cfg: ExecutionConfig = DEFAULT_EXEC,
    paperBroker?: PaperBroker,
  ) {
    const snapshot = (exchange: string, symbol: string) => ({ book: marketDataCache.getOrderBook(exchange, symbol)?.data ?? null, ticker: marketDataCache.getTicker(exchange, symbol)?.data ?? null });
    this.clientBroker = new PaperBroker({ feeRate: env.PAPER_FEE_RATE, slippagePct: 0, latencyMs: 0, latencyJitter: 0, rejectRate: 0, maxBookAgeMs: 15_000 }, snapshot);
    this.paperBroker =
      paperBroker ??
      new PaperBroker(
        { feeRate: env.PAPER_FEE_RATE, slippagePct: env.PAPER_SLIPPAGE_PCT, latencyMs: env.PAPER_LATENCY_MS, latencyJitter: 0.5, rejectRate: env.PAPER_REJECT_RATE, maxBookAgeMs: 15_000 },
        (exchange, symbol) => ({ book: marketDataCache.getOrderBook(exchange, symbol)?.data ?? null, ticker: marketDataCache.getTicker(exchange, symbol)?.data ?? null }),
      );
  }

  async submit(intent: OrderIntent) {
    if (!intent.idempotencyKey) throw new Error('idempotencyKey is required');
    const existing = await OrderModel.findOne({ idempotencyKey: intent.idempotencyKey });
    if (existing) return existing;

    let order;
    try {
      order = await OrderModel.create({
        mode: intent.mode,
        user: intent.user,
        idempotencyKey: intent.idempotencyKey,
        exchange: intent.exchange,
        symbol: intent.symbol,
        side: intent.side,
        type: intent.type,
        amount: intent.amount,
        price: intent.price,
        stopPrice: intent.stopPrice,
        trailingPct: intent.trailingPct,
        reduceOnly: !!intent.reduceOnly,
        status: 'PENDING',
        strategyKey: intent.strategyKey,
        signal: intent.signal,
        aiAnalysis: intent.aiAnalysis,
        riskEvaluation: intent.riskEvaluation,
        position: intent.position,
        purpose: intent.purpose,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return (await OrderModel.findOne({ idempotencyKey: intent.idempotencyKey }))!;
      throw err;
    }

    const req: OrderRequest = {
      symbol: intent.symbol,
      side: intent.side,
      type: intent.type,
      amount: intent.amount,
      price: intent.price,
      stopPrice: intent.stopPrice,
      trailingPct: intent.trailingPct,
      clientOrderId: intent.idempotencyKey,
      reduceOnly: intent.reduceOnly,
    };

    if (intent.mode === 'PAPER') await this.executePaper(order, req, this.paperBroker);
    else if (intent.mode === 'REAL') {
      // Exits go wherever the position lives; entries follow the admin's routing for the asset class.
      const pos = intent.position ? await PositionModel.findById(intent.position) : null;
      const route = pos ? (pos.broker ?? 'internal') : await brokerService.routeFor(intent.symbol);
      if (route === 'internal') {
        order.broker = 'internal';
        await this.executePaper(order, req, this.clientBroker);
      } else await this.executeBroker(order, intent, route as BrokerId, pos);
    }
    else await this.executeLive(order, req);

    eventBus.publish('order', order.toJSON());
    return order;
  }

  private async executePaper(order: InstanceType<typeof OrderModel>, req: OrderRequest, broker: PaperBroker) {
    order.status = 'SUBMITTED';
    order.submittedAt = new Date();
    order.attempts = 1;
    const r = await broker.execute(req, order.exchange);
    order.exchangeOrderId = `${order.mode === 'REAL' ? 'client' : 'paper'}-${order._id.toString()}`;
    order.exchangeResponses.push({ simulated: true, status: r.status, latencyMs: r.latencyMs, rejectReason: r.rejectReason });
    order.status = r.status;
    order.filled = r.filled;
    order.averagePrice = r.averagePrice;
    order.fee = r.fee;
    order.rejectReason = r.rejectReason;
    order.lastCheckedAt = new Date();
    if (TERMINAL.includes(r.status)) order.closedAt = new Date();
    await order.save();
    let i = 0;
    for (const f of r.fills) {
      await Fill.create({ mode: order.mode, order: order._id, exchange: order.exchange, exchangeTradeId: `${order.exchangeOrderId}-${i++}`, symbol: order.symbol, side: order.side, price: f.price, amount: f.amount, fee: f.fee, slippage: f.slippage, timestamp: new Date() });
    }
  }

  /**
   * REAL-account order at an external broker. Guarded (kill switch, routing, real data); after an
   * ambiguous failure the broker is asked whether the position exists BEFORE anything else happens,
   * and an unresolved outcome is left UNKNOWN for reconciliation - never retried blindly.
   */
  private async executeBroker(order: InstanceType<typeof OrderModel>, intent: OrderIntent, route: BrokerId, pos: InstanceType<typeof PositionModel> | null) {
    order.broker = route;
    order.status = 'SUBMITTED';
    order.submittedAt = new Date();
    order.attempts = 1;
    const reject = async (reason: string) => {
      order.status = 'REJECTED';
      order.rejectReason = reason;
      order.closedAt = new Date();
      await order.save();
    };
    try {
      brokerService.assertAllowed(pos ? 'REDUCE' : 'OPEN');
    } catch (err) {
      await reject(errorMessage(err));
      throw err;
    }
    const adapter = await brokerService.adapter(route);
    if (!adapter.configured()) return reject(`${adapter.name} is not configured`);
    await order.save();
    const started = Date.now();

    if (!pos) {
      const t = marketDataCache.getTicker(order.exchange, order.symbol)?.data;
      const price = t ? (order.side === 'buy' ? t.ask : t.bid) : 0;
      if (!price) return reject('No current price');
      const req = { symbol: order.symbol, direction: (order.side === 'buy' ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT', units: order.amount, investmentUsd: intent.investmentUsd ?? order.amount * price, stopLoss: intent.stopLoss, takeProfit: intent.takeProfit, clientRef: order.idempotencyKey, price };
      let fill;
      try {
        fill = await adapter.open(req);
      } catch (err) {
        order.exchangeResponses.push({ at: new Date(), kind: 'broker-open-error', error: errorMessage(err) });
        if (!(err instanceof BrokerAmbiguousError)) return reject(errorMessage(err));
        fill = await adapter.lookup(order.idempotencyKey, req, started).catch(() => undefined);
        if (fill === undefined) {
          order.status = 'UNKNOWN';
          order.rejectReason = 'Broker did not confirm; pending reconciliation';
          await order.save();
          void notificationService.notify('RECONCILIATION', `${adapter.name}: unconfirmed order`, `${order.symbol} ${order.side} ${order.idempotencyKey}`);
          return;
        }
        if (!fill) return reject('Broker did not open the position');
      }
      order.exchangeResponses.push({ at: new Date(), kind: 'broker-open', response: sanitize(fill.raw ?? fill) });
      if (fill.status !== 'FILLED' || !fill.price || !fill.units) return reject(fill.rejectReason ?? 'Rejected by broker');
      order.status = 'FILLED';
      order.filled = fill.units;
      order.averagePrice = fill.price;
      order.fee = 0;
      order.brokerRef = fill.brokerRef;
      order.exchangeOrderId = `${route}-${fill.brokerRef}`;
      order.closedAt = new Date();
      await order.save();
      return;
    }

    // Exit: close at the broker and book exactly the broker's realized P&L.
    let r;
    try {
      r = await adapter.close(pos.brokerRef!, { symbol: pos.symbol, clientRef: order.idempotencyKey });
    } catch (err) {
      order.exchangeResponses.push({ at: new Date(), kind: 'broker-close-error', error: errorMessage(err) });
      order.status = 'UNKNOWN';
      order.rejectReason = `Close not confirmed: ${errorMessage(err)}`;
      await order.save();
      return;
    }
    order.exchangeResponses.push({ at: new Date(), kind: 'broker-close', response: sanitize(r.raw ?? r) });
    if (r.status !== 'CLOSED') return reject(r.rejectReason ?? 'Close rejected by broker');
    order.status = 'FILLED';
    order.filled = pos.amount;
    order.averagePrice = brokerExitPrice(pos, r.pnlUsd, r.price);
    order.fee = 0;
    order.brokerRef = pos.brokerRef ?? undefined;
    order.closedAt = new Date();
    await order.save();
  }

  private async executeLive(order: InstanceType<typeof OrderModel>, req: OrderRequest) {
    // Guard first - nothing below runs unless live trading is fully authorized.
    try {
      assertLiveOrderAllowed(req.reduceOnly ? 'REDUCE' : 'OPEN');
    } catch (err) {
      order.status = 'REJECTED';
      order.rejectReason = errorMessage(err);
      order.closedAt = new Date();
      await order.save();
      throw err;
    }
    const adapter = exchangeRegistry.private(order.exchange) as CcxtAdapter;
    let exOrder: ExchangeOrder | null = null;
    order.status = 'SUBMITTED';
    order.submittedAt = new Date();
    await order.save();

    for (let attempt = 1; attempt <= this.cfg.maxSubmitAttempts && !exOrder; attempt++) {
      order.attempts = attempt;
      try {
        exOrder = await withTimeout(adapter.createOrder(req), this.cfg.submitTimeoutMs);
        order.exchangeResponses.push({ at: new Date(), kind: 'create', response: sanitize(exOrder) });
      } catch (err) {
        const msg = errorMessage(err);
        order.exchangeResponses.push({ at: new Date(), kind: 'create-error', error: msg });
        if (err instanceof LiveTradingDisabledError) {
          order.status = 'REJECTED';
          order.rejectReason = msg;
          break;
        }
        circuitBreaker.recordApiError(msg);
        if (isNetworkError(err)) {
          // The request may have reached the exchange. Look it up before retrying.
          await sleep(500 * attempt);
          const found = typeof adapter.findOrderByClientId === 'function' ? await adapter.findOrderByClientId(req.symbol, req.clientOrderId).catch(() => null) : null;
          if (found) {
            exOrder = found;
            order.exchangeResponses.push({ at: new Date(), kind: 'recovered-by-client-id', response: sanitize(found) });
          }
          continue;
        }
        // Definitive exchange rejection (invalid order, insufficient funds, ...): do not retry.
        order.status = 'REJECTED';
        order.rejectReason = msg;
        break;
      }
    }

    if (!exOrder) {
      if (order.status !== 'REJECTED') {
        order.status = 'UNKNOWN';
        order.rejectReason = 'Submission outcome unknown after retries; reconciliation will resolve';
        circuitBreaker.trip('EXCHANGE_API_ERRORS', `Order ${order.idempotencyKey} outcome unknown`);
      }
      order.closedAt = order.status === 'REJECTED' ? new Date() : undefined;
      await order.save();
      return;
    }

    order.exchangeOrderId = exOrder.id;
    await order.save();
    await this.verify(order);
  }

  /** Poll the exchange until the order reaches a terminal state or the verify timeout elapses. */
  async verify(order: InstanceType<typeof OrderModel>) {
    const adapter = exchangeRegistry.private(order.exchange);
    const deadline = Date.now() + this.cfg.verifyTimeoutMs;
    while (true) {
      try {
        const o = await adapter.getOrder(order.exchangeOrderId!, order.symbol, order.idempotencyKey);
        order.status = o.status;
        order.filled = o.filled;
        order.averagePrice = o.average ?? order.averagePrice;
        order.fee = o.fee ?? order.fee;
        order.feeCurrency = o.feeCurrency ?? order.feeCurrency;
        order.lastCheckedAt = new Date();
        if (TERMINAL.includes(o.status)) {
          order.closedAt = new Date();
          break;
        }
      } catch (err) {
        circuitBreaker.recordApiError(errorMessage(err));
      }
      // Limit orders may legitimately rest; stop polling and let the stale-order job continue.
      if (Date.now() > deadline || order.type !== 'market') break;
      await sleep(this.cfg.verifyIntervalMs);
    }
    await order.save();
    await this.syncFills(order);
  }

  /** Record actual exchange fills for the order (idempotent via unique exchangeTradeId). */
  async syncFills(order: InstanceType<typeof OrderModel>) {
    if (order.mode !== 'LIVE' || !(order.filled > 0) || !order.exchangeOrderId) return;
    try {
      const adapter = exchangeRegistry.private(order.exchange);
      const since = (order.submittedAt?.getTime() ?? Date.now()) - 60_000;
      const trades = (await adapter.getTrades(order.symbol, since, 200)).filter((t) => t.orderId === order.exchangeOrderId);
      for (const t of trades) {
        await Fill.updateOne(
          { exchange: order.exchange, exchangeTradeId: t.id, mode: 'LIVE' },
          { $setOnInsert: { mode: 'LIVE', order: order._id, exchange: order.exchange, exchangeTradeId: t.id, symbol: t.symbol, side: t.side, price: t.price, amount: t.amount, fee: t.fee, feeCurrency: t.feeCurrency, timestamp: new Date(t.timestamp) } },
          { upsert: true },
        );
      }
      if (trades.length && order.averagePrice) {
        const ref = marketDataCache.getTicker(order.exchange, order.symbol)?.data;
        if (ref && order.type === 'market') {
          const expected = order.side === 'buy' ? ref.ask : ref.bid;
          if (expected > 0) circuitBreaker.checkSlippage(Math.abs(order.averagePrice - expected) / expected, env.MAX_SLIPPAGE_PCT, order.symbol);
        }
      }
    } catch (err) {
      logger.warn({ err: errorMessage(err), order: order.idempotencyKey }, 'Fill sync failed');
    }
  }

  async cancel(orderId: string) {
    const order = await OrderModel.findById(orderId);
    if (!order) throw new Error('Order not found');
    if (TERMINAL.includes(order.status as OrderStatus)) return order;
    if (order.mode !== 'LIVE') {
      order.status = 'CANCELLED';
      order.closedAt = new Date();
    } else if (order.exchangeOrderId) {
      const o = await exchangeRegistry.private(order.exchange).cancelOrder(order.exchangeOrderId, order.symbol);
      order.exchangeResponses.push({ at: new Date(), kind: 'cancel', response: sanitize(o) });
      // Re-read state: a cancel can race with a fill.
      await this.verify(order);
    }
    await order.save();
    eventBus.publish('order', order.toJSON());
    return order;
  }

  /** Cancel every open order for a mode. Returns counts; errors are collected, not thrown. */
  /** Cancel every open order of the system book (personal demo accounts are not touched). */
  async cancelAllOpen(mode: 'PAPER' | 'LIVE') {
    const open = await OrderModel.find({ mode, user: null, status: { $in: ['PENDING', 'SUBMITTED', 'OPEN', 'PARTIALLY_FILLED'] } });
    const errors: string[] = [];
    let cancelled = 0;
    for (const o of open) {
      try {
        await this.cancel(o._id.toString());
        cancelled++;
      } catch (err) {
        errors.push(`${o.idempotencyKey}: ${errorMessage(err)}`);
      }
    }
    return { cancelled, errors };
  }
}

function sanitize(o: unknown) {
  if (!o || typeof o !== 'object') return o;
  const { raw: _raw, ...rest } = o as Record<string, unknown>;
  return rest;
}

export const orderExecutionService = new OrderExecutionService();
