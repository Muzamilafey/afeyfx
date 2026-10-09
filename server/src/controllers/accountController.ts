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
import { paymentService } from '../payments/PaymentService';
import { FOREX_VENUE, LOT_STEP, MAX_LOTS, instrumentOf } from '../marketData/instruments';
import { forexDataService } from '../marketData/ForexDataService';
import { quoteOf, usdPer } from '../portfolio/fx';

/**
 * Personal trader accounts. Every query is scoped to the caller, so one trader can never see or
 * affect another trader's account or the system strategy book.
 *  - DEMO (mode PAPER): virtual money, resettable.
 *  - REAL (mode REAL): funded by M-Pesa deposits (see payments). Orders fill internally at the real
 *    market price; they never reach an exchange. Trading it needs the admin's realTradingEnabled
 *    switch and real (non-simulated) market data.
 */
export const accountSchemas = {
  order: z.object({
    symbol: z.string().regex(/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/),
    direction: z.enum(['LONG', 'SHORT']),
    /** Size in USD (any market) ... */
    investment: z.number().min(10).max(100_000).optional(),
    /** ... or in standard lots (forex & metals): 0.01 = micro lot. Exactly one of the two. */
    lots: z.number().min(LOT_STEP).max(MAX_LOTS).refine((v) => Math.abs(Math.round(v / LOT_STEP) * LOT_STEP - v) < 1e-9, 'Lots must be a multiple of 0.01').optional(),
    stopLossPct: z.number().min(0.00005).max(0.5).default(0.02),
    takeProfitPct: z.number().min(0.00005).max(2).optional(),
    idempotencyKey: z.string().min(8).max(100).optional(),
    account: z.enum(['DEMO', 'REAL']).default('DEMO'),
  }).refine((b) => (b.investment === undefined) !== (b.lots === undefined), { message: 'Give either an investment amount or a lot size', path: ['lots'] }),
};

const owner = (req: Request) => req.user!.id;
type AccountType = 'DEMO' | 'REAL';
const modeFor = (a: unknown): 'PAPER' | 'REAL' => (a === 'REAL' ? 'REAL' : 'PAPER');
const accountOf = (req: Request): AccountType => (req.query.account === 'REAL' ? 'REAL' : 'DEMO');
const accountView = async (type: AccountType, userId: string) => ({ type, ...portfolioService.view(await portfolioService.revalue(modeFor(type), userId)) });

export const accountController = {
  async get(req: Request, res: Response) {
    const [user, demo, real] = await Promise.all([User.findById(owner(req)), accountView('DEMO', owner(req)), accountView('REAL', owner(req))]);
    res.json({ user: user?.toJSON(), account: accountOf(req) === 'REAL' ? real : demo, accounts: { DEMO: demo, REAL: real } });
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
    const mode = modeFor(b.account);
    if (tradingState.get().emergencyShutdown) throw new AppError(423, 'Trading is temporarily halted', 'TRADING_HALTED');
    if (mode === 'REAL') {
      const cfg = await paymentService.config();
      if (!cfg.realTradingEnabled) throw new AppError(403, 'Real-account trading is not enabled yet', 'REAL_TRADING_DISABLED');
      // Real money is never traded on synthetic prices.
      if (env.MARKET_DATA_SOURCE === 'simulated') throw new AppError(409, 'Real-account trading is unavailable while simulated market data is active', 'SIMULATED_DATA');
      if (!tradingState.get().tradingEnabled) throw new AppError(423, 'New trades are temporarily stopped', 'TRADING_STOPPED');
    }
    // Only catalogue instruments; each trades on its own venue's live quotes.
    const inst = instrumentOf(b.symbol);
    if (!inst) throw new AppError(400, 'This market is not available', 'UNKNOWN_SYMBOL');
    const exchange = inst.venue;
    if (inst.venue === FOREX_VENUE && !forexDataService.isTradeable(b.symbol)) throw new AppError(409, 'This market is closed right now (forex trades Sunday 21:00 to Friday 21:00 UTC)', 'MARKET_CLOSED');
    const t = marketDataCache.getTicker(exchange, b.symbol)?.data;
    const book = marketDataCache.getOrderBook(exchange, b.symbol)?.data;
    if (!t || !book || marketDataCache.dataAgeMs(exchange, b.symbol) > env.MARKET_DATA_STALE_MS) throw new AppError(409, 'Market data unavailable or stale for this symbol', 'NO_MARKET_DATA');
    // Investment is in USD; pairs quoted in another currency (USD/JPY, EUR/GBP...) are converted.
    const quoteRate = usdPer(quoteOf(b.symbol));
    if (!quoteRate) throw new AppError(409, `No ${quoteOf(b.symbol)}/USD rate available to value this trade`, 'NO_FX_RATE');
    const p = portfolioService.view(await portfolioService.revalue(mode, owner(req)));
    // Fees are charged on top of the investment; REAL accounts also keep a small buffer for
    // book-walking slippage so cash can never go negative.
    const buffer = mode === 'REAL' ? env.PAPER_FEE_RATE + 0.005 : 0;
    const entry = b.direction === 'LONG' ? t.ask : t.bid;
    let amount: number;
    let investment: number;
    if (b.lots !== undefined) {
      // Lots: units = lots x contract size; the position is fully funded (1:1), so its USD notional is the cost.
      if (!inst.contractSize) throw new AppError(400, 'Lot sizing is available for forex and metals only', 'LOTS_UNSUPPORTED');
      amount = Math.round(b.lots * inst.contractSize * 100) / 100;
      investment = amount * entry * quoteRate;
    } else {
      investment = b.investment!;
      amount = floorTo(investment / quoteRate / entry, inst.amountPrecision);
    }
    if (investment * (1 + buffer) > p.available + 1e-9) throw new AppError(400, `Insufficient ${mode === 'REAL' ? '' : 'demo '}balance: this trade needs $${investment.toFixed(2)} (available $${p.available.toFixed(2)})`, 'INSUFFICIENT_BALANCE');
    if (!(amount > 0)) throw new AppError(400, 'Order size too small', 'TOO_SMALL');
    const sl = b.direction === 'LONG' ? entry * (1 - b.stopLossPct) : entry * (1 + b.stopLossPct);
    const tp = b.takeProfitPct ? (b.direction === 'LONG' ? entry * (1 + b.takeProfitPct) : entry * (1 - b.takeProfitPct)) : undefined;
    const r = await positionManager.open({
      mode,
      exchange,
      symbol: b.symbol,
      direction: b.direction,
      amount,
      stopLoss: sl,
      takeProfit: tp,
      strategyKey: 'manual',
      idempotencyKey: `${mode === 'REAL' ? 'real' : 'demo'}:${owner(req)}:${b.idempotencyKey ?? randomUUID()}`,
      user: owner(req),
      quoteRate,
      investmentUsd: investment,
      contractSize: b.lots !== undefined ? inst.contractSize : undefined,
    });
    if (!r.position) throw new AppError(422, `Order not filled: ${r.order.rejectReason ?? r.order.status}`, 'ORDER_NOT_FILLED');
    res.status(201).json({ order: r.order, position: r.position });
  },

  async positions(req: Request, res: Response) {
    const status = req.query.status === 'CLOSED' ? 'CLOSED' : 'OPEN';
    res.json({ positions: await PositionModel.find({ user: owner(req), mode: modeFor(accountOf(req)), status }).sort({ openedAt: -1 }).limit(200).lean() });
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
    res.json({ trades: await TradeModel.find({ user: owner(req), mode: modeFor(accountOf(req)) }).sort({ closedAt: -1 }).limit(limit).lean() });
  },

  async performance(req: Request, res: Response) {
    res.json(await portfolioService.performance(modeFor(accountOf(req)), 'symbol', owner(req)));
  },
};
