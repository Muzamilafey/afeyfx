import type { Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { PositionModel } from '../models/Position';
import { TradeModel } from '../models/Trade';
import { User } from '../models/User';
import { portfolioService, resetDemoAccount } from '../portfolio/PortfolioService';
import { positionManager } from '../execution/PositionManager';
import { marketDataCache } from '../marketData/MarketDataCache';
import { tradingState } from '../services/TradingState';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';
import { floorTo } from '../utils/math';

/**
 * Personal demo (PAPER) accounts for trader users. Every query is scoped to the caller, so one
 * trader can never see or affect another trader's account or the system strategy book.
 * Demo accounts are always PAPER: there are no deposits, withdrawals or real-money orders here.
 */
export const accountSchemas = {
  order: z.object({
    symbol: z.string().regex(/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/),
    direction: z.enum(['LONG', 'SHORT']),
    investment: z.number().min(10).max(100_000),
    stopLossPct: z.number().min(0.001).max(0.5).default(0.02),
    takeProfitPct: z.number().min(0.001).max(2).optional(),
    idempotencyKey: z.string().min(8).max(100).optional(),
  }),
};

const owner = (req: Request) => req.user!.id;

export const accountController = {
  async get(req: Request, res: Response) {
    const [user, p] = await Promise.all([User.findById(owner(req)), portfolioService.revalue('PAPER', owner(req))]);
    res.json({ user: user?.toJSON(), account: { type: 'DEMO', ...portfolioService.view(p) } });
  },

  async resetDemo(req: Request, res: Response) {
    try {
      const p = await resetDemoAccount(owner(req));
      await audit(req, { action: 'DEMO_ACCOUNT_RESET' });
      res.json({ account: { type: 'DEMO', ...portfolioService.view(p) } });
    } catch (err) {
      throw new AppError(409, (err as Error).message, 'POSITIONS_OPEN');
    }
  },

  async placeOrder(req: Request, res: Response) {
    const b = req.body as z.infer<typeof accountSchemas.order>;
    if (tradingState.get().emergencyShutdown) throw new AppError(423, 'Trading is temporarily halted', 'TRADING_HALTED');
    const exchange = env.DEFAULT_EXCHANGE;
    const t = marketDataCache.getTicker(exchange, b.symbol)?.data;
    const book = marketDataCache.getOrderBook(exchange, b.symbol)?.data;
    if (!t || !book || marketDataCache.dataAgeMs(exchange, b.symbol) > env.MARKET_DATA_STALE_MS) throw new AppError(409, 'Market data unavailable or stale for this symbol', 'NO_MARKET_DATA');
    const p = portfolioService.view(await portfolioService.revalue('PAPER', owner(req)));
    if (b.investment > p.available + 1e-9) throw new AppError(400, `Insufficient demo balance (available ${p.available.toFixed(2)})`, 'INSUFFICIENT_BALANCE');
    const entry = b.direction === 'LONG' ? t.ask : t.bid;
    const amount = floorTo(b.investment / entry, 6);
    if (!(amount > 0)) throw new AppError(400, 'Order size too small', 'TOO_SMALL');
    const sl = b.direction === 'LONG' ? entry * (1 - b.stopLossPct) : entry * (1 + b.stopLossPct);
    const tp = b.takeProfitPct ? (b.direction === 'LONG' ? entry * (1 + b.takeProfitPct) : entry * (1 - b.takeProfitPct)) : undefined;
    const r = await positionManager.open({
      mode: 'PAPER',
      exchange,
      symbol: b.symbol,
      direction: b.direction,
      amount,
      stopLoss: sl,
      takeProfit: tp,
      strategyKey: 'manual',
      idempotencyKey: `demo:${owner(req)}:${b.idempotencyKey ?? randomUUID()}`,
      user: owner(req),
    });
    if (!r.position) throw new AppError(422, `Order not filled: ${r.order.rejectReason ?? r.order.status}`, 'ORDER_NOT_FILLED');
    res.status(201).json({ order: r.order, position: r.position });
  },

  async positions(req: Request, res: Response) {
    const status = req.query.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
    res.json({ positions: await PositionModel.find({ user: owner(req), mode: 'PAPER', status }).sort({ openedAt: -1 }).limit(200).lean() });
  },

  async closePosition(req: Request, res: Response) {
    const pos = await PositionModel.findOne({ _id: req.params.id, user: owner(req) });
    if (!pos) throw new AppError(404, 'Position not found');
    const r = await positionManager.close(pos._id.toString(), 'Closed by trader', 'MANUAL', `manual:${Date.now()}`);
    if (!r) throw new AppError(502, 'Exit order was not filled; position remains open');
    res.json({ trade: r.trade });
  },

  async history(req: Request, res: Response) {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    res.json({ trades: await TradeModel.find({ user: owner(req), mode: 'PAPER' }).sort({ closedAt: -1 }).limit(limit).lean() });
  },

  async performance(req: Request, res: Response) {
    res.json(await portfolioService.performance('PAPER', 'symbol', owner(req)));
  },
};
