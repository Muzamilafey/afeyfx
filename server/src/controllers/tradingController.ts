import type { Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { SignalModel } from '../models/Signal';
import { OrderModel } from '../models/Order';
import { PositionModel } from '../models/Position';
import { TradeModel } from '../models/Trade';
import { Fill } from '../models/Fill';
import { orderExecutionService } from '../execution/OrderExecutionService';
import { positionManager } from '../execution/PositionManager';
import { tradingState } from '../services/TradingState';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';
import { env } from '../config/env';

const modeOf = (q: unknown) => (q === 'LIVE' ? 'LIVE' : q === 'PAPER' ? 'PAPER' : q === 'REAL' ? 'REAL' : tradingState.get().mode);
/** System book by default; admins may pass owner=all or owner=<userId> to inspect personal demo accounts. */
const ownerQ = (req: Request): Record<string, unknown> => {
  const o = String(req.query.owner ?? '');
  if (o === 'all') return {};
  if (/^[a-f0-9]{24}$/i.test(o)) return { user: o };
  return { user: null };
};
const page = (req: Request) => ({ limit: Math.min(Number(req.query.limit ?? 50), 500), skip: Math.max(0, Number(req.query.skip ?? 0)) });

export const tradingSchemas = {
  manualOrder: z.object({
    symbol: z.string().regex(/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/),
    side: z.enum(['buy', 'sell']),
    type: z.enum(['market', 'limit']),
    amount: z.number().positive(),
    price: z.number().positive().optional(),
    idempotencyKey: z.string().min(8).max(100).optional(),
  }),
};

export const tradingController = {
  async signals(req: Request, res: Response) {
    const q: Record<string, unknown> = { mode: modeOf(req.query.mode), ...ownerQ(req) };
    if (req.query.strategy) q.strategyKey = String(req.query.strategy);
    if (req.query.symbol) q.symbol = String(req.query.symbol);
    const { limit, skip } = page(req);
    res.json({ signals: await SignalModel.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean() });
  },

  async orders(req: Request, res: Response) {
    const q: Record<string, unknown> = { mode: modeOf(req.query.mode), ...ownerQ(req) };
    if (req.query.status) q.status = String(req.query.status);
    const { limit, skip } = page(req);
    res.json({ orders: await OrderModel.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean() });
  },

  async order(req: Request, res: Response) {
    const o = await OrderModel.findById(req.params.id).lean();
    if (!o) throw new AppError(404, 'Order not found');
    res.json({ order: o, fills: await Fill.find({ order: o._id }).lean() });
  },

  /** Manual orders are PAPER-only. Live order entry is done exclusively by the engine through risk checks. */
  async manualOrder(req: Request, res: Response) {
    if (tradingState.get().mode !== 'PAPER') throw new AppError(403, 'Manual orders are only allowed in PAPER mode', 'PAPER_ONLY');
    const b = req.body as z.infer<typeof tradingSchemas.manualOrder>;
    if (b.type === 'limit' && !b.price) throw new AppError(400, 'Limit orders need a price');
    const order = await orderExecutionService.submit({ mode: 'PAPER', exchange: env.DEFAULT_EXCHANGE, symbol: b.symbol, side: b.side, type: b.type, amount: b.amount, price: b.price, idempotencyKey: b.idempotencyKey ?? `manual:${randomUUID()}`, purpose: 'MANUAL', user: req.user!.id });
    await audit(req, { action: 'MANUAL_PAPER_ORDER', resource: 'order', resourceId: order._id.toString(), details: { symbol: b.symbol, side: b.side, amount: b.amount } });
    res.status(201).json({ order });
  },

  async cancelOrder(req: Request, res: Response) {
    const o = await OrderModel.findById(req.params.id);
    if (!o) throw new AppError(404, 'Order not found');
    if (o.mode === 'LIVE' && req.user!.role !== 'admin') throw new AppError(403, 'Only admins can cancel live orders');
    const r = await orderExecutionService.cancel(String(req.params.id));
    await audit(req, { action: 'ORDER_CANCELLED', resource: 'order', resourceId: String(req.params.id), details: { mode: o.mode } });
    res.json({ order: r });
  },

  async positions(req: Request, res: Response) {
    const q: Record<string, unknown> = { mode: modeOf(req.query.mode), ...ownerQ(req) };
    q.status = req.query.status === 'CLOSED' ? 'CLOSED' : req.query.status === 'ALL' ? { $in: ['OPEN', 'CLOSED'] } : 'OPEN';
    const { limit, skip } = page(req);
    res.json({ positions: await PositionModel.find(q).sort({ openedAt: -1 }).skip(skip).limit(limit).lean() });
  },

  async closePosition(req: Request, res: Response) {
    const p = await PositionModel.findById(req.params.id);
    if (!p) throw new AppError(404, 'Position not found');
    if (p.mode === 'LIVE' && req.user!.role !== 'admin') throw new AppError(403, 'Only admins can close live positions');
    const r = await positionManager.close(p._id.toString(), `Manual close by ${req.user!.email}`, 'MANUAL', `manual:${Date.now()}`);
    await audit(req, { action: 'POSITION_CLOSED_MANUAL', resource: 'position', resourceId: p._id.toString(), details: { mode: p.mode, ok: !!r } });
    if (!r) throw new AppError(502, 'Exit order was not filled; position remains open');
    res.json(r);
  },

  async trades(req: Request, res: Response) {
    const q: Record<string, unknown> = { mode: modeOf(req.query.mode), ...ownerQ(req) };
    if (req.query.strategy) q.strategyKey = String(req.query.strategy);
    if (req.query.symbol) q.symbol = String(req.query.symbol);
    const { limit, skip } = page(req);
    const [trades, total] = await Promise.all([TradeModel.find(q).sort({ closedAt: -1 }).skip(skip).limit(limit).lean(), TradeModel.countDocuments(q)]);
    res.json({ trades, total });
  },

  /** Full audit trail of a trade: user, strategy, signal, AI analysis, risk evaluation, orders, exchange responses, fills, P&L. */
  async tradeTrace(req: Request, res: Response) {
    const t = await TradeModel.findById(req.params.id).populate('signal').populate('aiAnalysis').populate('entryOrder').populate('exitOrder').populate('user', 'email name role').lean();
    if (!t) throw new AppError(404, 'Trade not found');
    const orderIds = [t.entryOrder, t.exitOrder].filter(Boolean).map((o) => (o as { _id: unknown })._id);
    res.json({ trade: t, fills: await Fill.find({ order: { $in: orderIds as never } }).lean() });
  },
};
