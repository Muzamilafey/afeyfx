import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { BrokerConnectionModel } from '../models/BrokerConnection';
import { brokerAuth } from '../brokers/services/BrokerAuthenticationService';
import { brokerConnections } from '../brokers/services/BrokerConnectionService';
import { brokerRegistry } from '../brokers/services/BrokerRegistry';
import { DERIV_GRANULARITIES, derivMarket } from '../brokers/deriv/DerivMarketService';
import { derivFunding } from '../brokers/deriv/DerivFundingService';
import { derivAnalysis } from '../brokers/deriv/DerivAnalysisService';
import { derivAiTrade } from '../brokers/deriv/DerivAiTradeService';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';

const OAUTH_COOKIE = 'afx_broker_oauth';
const symbol = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,40}$/);

export const derivSchemas = {
  quote: z.object({
    symbol,
    product: z.enum(['multiplier', 'rise_fall']),
    side: z.enum(['buy', 'sell']),
    stake: z.number().positive().max(100_000),
    multiplier: z.number().int().positive().max(2000).optional(),
    duration: z.number().int().positive().max(365).optional(),
    durationUnit: z.enum(['t', 's', 'm', 'h', 'd']).optional(),
    stopLossAmount: z.number().positive().optional(),
    takeProfitAmount: z.number().positive().optional(),
  }),
  subscribe: z.object({ symbol }),
  analyze: z.object({ symbol, timeframe: z.enum(Object.keys(DERIV_GRANULARITIES) as [string, ...string[]]), ai: z.boolean().default(true) }),
  aiTrade: z.object({
    analysisId: z.string().regex(/^[0-9a-f]{24}$/),
    product: z.enum(['multiplier', 'rise_fall']).default('multiplier'),
    multiplier: z.number().int().positive().max(2000).optional(),
    duration: z.number().int().positive().max(365).optional(),
    durationUnit: z.enum(['t', 's', 'm', 'h', 'd']).optional(),
  }),
  engine: z.object({ connectionId: z.string().regex(/^[0-9a-f]{24}$/) }),
  transfer: z.object({ to: z.string().regex(/^[A-Za-z0-9_-]{2,40}$/), amount: z.number().positive().max(1_000_000), currency: z.string().regex(/^[A-Za-z0-9]{2,10}$/), idempotencyKey: z.string().min(8).max(100), totp: z.string().optional(), emailCode: z.string().optional() }),
};

const me = (req: Request) => req.user!.id;
async function owned(req: Request) {
  const id = String(req.params.id);
  if (!/^[0-9a-f]{24}$/.test(id)) throw new AppError(404, 'Deriv account not found');
  const c = await BrokerConnectionModel.findOne({ _id: id, user: me(req), provider: 'deriv' });
  if (!c || c.status === 'REVOKED') throw new AppError(404, 'Deriv account not found');
  return c;
}

/**
 * Personal Deriv terminal: account overview, market data, contract offerings, price quotes and
 * funding. Trading itself goes through the shared order pipeline (/api/brokers/connections/:id/orders)
 * so every order passes the server-side risk engine.
 */
export const derivController = {
  async status(req: Request, res: Response) {
    const conns = await BrokerConnectionModel.find({ user: me(req), provider: 'deriv', status: { $ne: 'REVOKED' } }).sort({ isDefault: -1, environment: 1, createdAt: 1 });
    const views = conns.map((c) => ({ ...brokerConnections.view(c), live: brokerRegistry.peek(c._id.toString())?.health() ?? null }));
    res.json({
      configured: { oauth: brokerAuth.derivOAuthConfigured(), token: env.DERIV_ALLOW_PAT && !!env.DERIV_APP_ID },
      connections: views,
      engineAccount: views.find((v) => v.isDefault)?.id ?? null,
      funding: await derivFunding.status(me(req)),
      timeframes: Object.keys(DERIV_GRANULARITIES),
    });
  },

  /** The account used by the strategy engine / bots by default. */
  async setEngineAccount(req: Request, res: Response) {
    const { connectionId } = req.body as z.infer<typeof derivSchemas.engine>;
    const v = await brokerConnections.setDefault(me(req), connectionId);
    await audit(req, { action: 'DERIV_ENGINE_ACCOUNT', resourceId: connectionId });
    res.json({ connection: v });
  },

  async symbols(req: Request, res: Response) {
    res.json({ symbols: await derivMarket.symbols(await owned(req)) });
  },
  async offerings(req: Request, res: Response) {
    res.json({ offerings: await derivMarket.offerings(await owned(req), symbol.parse(req.query.symbol)) });
  },
  async candles(req: Request, res: Response) {
    const tf = String(req.query.timeframe ?? '1m');
    res.json(await derivMarket.candles(await owned(req), symbol.parse(req.query.symbol), tf, Number(req.query.count ?? 300)));
  },
  async subscribe(req: Request, res: Response) {
    const c = await owned(req);
    const a = await derivMarket.adapter(c);
    await a.subscribeQuotes([(req.body as { symbol: string }).symbol]);
    res.json({ ok: true });
  },
  async quote(req: Request, res: Response) {
    res.json({ quote: await derivMarket.quote(await owned(req), req.body as z.infer<typeof derivSchemas.quote>) });
  },
  /** AI market analyst (plus an always-available rule-based reading). Analysis only. */
  async analyze(req: Request, res: Response) {
    const b = req.body as z.infer<typeof derivSchemas.analyze>;
    res.json(await derivAnalysis.analyze(await owned(req), b.symbol, b.timeframe, { ai: b.ai }));
  },
  /** "Trade with AI" step 1: the server-built plan (direction from AI, stop from ATR, stake from risk limits). */
  async aiTradePreview(req: Request, res: Response) {
    const { analysisId, ...opts } = req.body as z.infer<typeof derivSchemas.aiTrade>;
    res.json({ plan: await derivAiTrade.plan(await owned(req), me(req), analysisId, opts) });
  },
  /** "Trade with AI" step 2: the user's click. Re-plans on the server and sends through the risk engine. */
  async aiTradeExecute(req: Request, res: Response) {
    const c = await owned(req);
    const { analysisId, ...opts } = req.body as z.infer<typeof derivSchemas.aiTrade>;
    const r = await derivAiTrade.execute(c, me(req), analysisId, opts);
    await audit(req, { action: 'DERIV_AI_TRADE', resourceId: r.order._id.toString(), success: r.order.status !== 'REJECTED', details: { analysisId, environment: c.environment, status: r.order.status, duplicate: r.duplicate } });
    const code = r.duplicate ? 200 : r.order.status === 'FILLED' || r.order.status === 'OPEN' ? 201 : r.order.status === 'UNKNOWN' ? 202 : 422;
    res.status(code).json(r);
  },
  async profitTable(req: Request, res: Response) {
    res.json({ contracts: await derivMarket.profitTable(await owned(req), Number(req.query.limit ?? 50)) });
  },

  // ------------------------------------------------------------------ funding

  async fundingStatus(req: Request, res: Response) {
    res.json(await derivFunding.status(me(req)));
  },
  /** Start the separate payments-scope authorization (opt-in). */
  async fundingAuthorize(req: Request, res: Response) {
    const { authorizeUrl, binding } = await brokerAuth.startDerivOAuth(me(req), 'funding');
    res.cookie(OAUTH_COOKIE, binding, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/api/brokers', maxAge: 10 * 60_000 });
    await audit(req, { action: 'DERIV_FUNDING_AUTH_STARTED' });
    res.json({ authorizeUrl });
  },
  async fundingRevoke(req: Request, res: Response) {
    await derivFunding.revoke(me(req));
    await audit(req, { action: 'DERIV_FUNDING_AUTH_REMOVED' });
    res.json({ ok: true, note: 'Removed from AfeyFX. Also revoke the app in Deriv → Settings → Security.' });
  },
  async fundingAccounts(req: Request, res: Response) {
    const c = await owned(req);
    res.json({ accounts: await derivFunding.accounts(me(req), c._id.toString()) });
  },
  async transfer(req: Request, res: Response) {
    const c = await owned(req);
    const b = req.body as z.infer<typeof derivSchemas.transfer>;
    const r = await derivFunding.transfer(me(req), { connectionId: c._id.toString(), to: b.to, amount: b.amount, currency: b.currency, idempotencyKey: b.idempotencyKey });
    await audit(req, { action: 'DERIV_TRANSFER', resourceId: r.transaction._id.toString(), success: r.transaction.status !== 'FAILED', details: { from: c.accountId, to: b.to, amount: b.amount, currency: b.currency, status: r.transaction.status } });
    const code = r.duplicate ? 200 : r.transaction.status === 'COMPLETED' ? 201 : r.transaction.status === 'FAILED' ? 422 : 202;
    res.status(code).json(r);
  },
  async depositLink(req: Request, res: Response) {
    const c = await owned(req);
    const r = await derivFunding.depositLink(me(req), c._id.toString());
    await audit(req, { action: 'DERIV_CASHIER_OPENED', resourceId: c._id.toString(), details: { action: 'deposit', source: r.source } });
    res.json(r);
  },
  async withdrawLink(req: Request, res: Response) {
    await audit(req, { action: 'DERIV_CASHIER_OPENED', details: { action: 'withdraw' } });
    res.json(derivFunding.withdrawLink());
  },
  async fundingSync(req: Request, res: Response) {
    const c = await owned(req);
    res.json(await derivFunding.sync(me(req), c._id.toString()));
  },
  async fundingHistory(req: Request, res: Response) {
    const cid = typeof req.query.connectionId === 'string' && /^[0-9a-f]{24}$/.test(req.query.connectionId) ? req.query.connectionId : undefined;
    res.json({ transactions: await derivFunding.history(me(req), cid) });
  },
  async fundingVerify(req: Request, res: Response) {
    const id = String(req.params.txId);
    if (!/^[0-9a-f]{24}$/.test(id)) throw new AppError(404, 'Transaction not found');
    const t = await derivFunding.verify(me(req), id);
    if (!t) throw new AppError(404, 'Transaction not found');
    res.json({ transaction: t });
  },
};
