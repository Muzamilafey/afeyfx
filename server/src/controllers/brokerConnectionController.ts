import type { Request, Response } from 'express';
import { z } from 'zod';
import { env, isLiveTradingEnabledByEnv } from '../config/env';
import { EVALUATED_PROVIDERS, PROVIDERS } from '../brokers/core/capabilities';
import { mt5Bridge } from '../brokers/mt5/Mt5Bridge';
import { appUrl, brokerAuth, derivRedirectUri } from '../brokers/services/BrokerAuthenticationService';
import { brokerConnections, LIVE_CONFIRM_PHRASE } from '../brokers/services/BrokerConnectionService';
import { brokerOrders } from '../brokers/services/BrokerOrderService';
import { brokerRegistry, logBrokerEvent } from '../brokers/services/BrokerRegistry';
import { brokerMarketData } from '../brokers/services/BrokerDataServices';
import { BrokerCapabilityModel } from '../models/BrokerRecords';
import { BrokerConnectionModel } from '../models/BrokerConnection';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';
import { errorMessage } from '../utils/logger';

const OAUTH_COOKIE = 'afx_broker_oauth';
const symbol = z.string().trim().regex(/^[A-Za-z0-9._#/-]{1,40}$/);
const num = z.number().finite();
const limitKeys = ['maxRiskPerTrade', 'maxDailyLoss', 'maxWeeklyLoss', 'maxLeverage', 'maxOpenPositions', 'maxExposurePct', 'maxSpreadPct', 'maxSlippagePct', 'maxQuoteAgeMs', 'maxConsecutiveFailures', 'balanceChangeTolerancePct'] as const;

export const brokerSchemas = {
  connect: z.discriminatedUnion('method', [
    z.object({ method: z.literal('oauth') }),
    z.object({ method: z.literal('token'), token: z.string().trim().min(8).max(500), appId: z.string().regex(/^\d{1,10}$/).optional() }),
    z.object({ method: z.literal('terminal'), environment: z.enum(['demo', 'real']), label: z.string().max(60).optional() }),
  ]),
  order: z.object({
    idempotencyKey: z.string().min(8).max(100),
    brokerSymbol: symbol,
    side: z.enum(['buy', 'sell']),
    product: z.enum(['cfd', 'multiplier', 'rise_fall']),
    type: z.enum(['market', 'limit', 'stop']).default('market'),
    volume: num.positive().max(1000).optional(),
    stake: num.positive().max(100_000).optional(),
    multiplier: z.number().int().positive().max(2000).optional(),
    price: num.positive().optional(),
    stopLoss: num.positive().optional(),
    takeProfit: num.positive().optional(),
    duration: z.number().int().positive().max(365).optional(),
    durationUnit: z.enum(['t', 's', 'm', 'h', 'd']).optional(),
  }),
  limits: z.object(Object.fromEntries(limitKeys.map((k) => [k, z.number().optional()])) as Record<(typeof limitKeys)[number], z.ZodOptional<z.ZodNumber>>),
  live: z.object({ password: z.string().max(200).optional(), confirm: z.string().max(60), totp: z.string().optional(), emailCode: z.string().optional() }),
  confirm: z.object({ confirm: z.literal(true) }),
  assignment: z.object({ connectionId: z.string().regex(/^[0-9a-f]{24}$/), strategyKey: z.string().min(1).max(60), symbolMap: z.record(z.string().max(30), symbol), product: z.enum(['cfd', 'multiplier', 'rise_fall']), multiplier: z.number().int().positive().max(2000).optional(), enabled: z.boolean() }),
};

const me = (req: Request) => req.user!.id;
const id = (req: Request) => {
  const v = String(req.params.id);
  if (!/^[0-9a-f]{24}$/.test(v)) throw new AppError(404, 'Broker connection not found');
  return v;
};

export const brokerConnectionController = {
  /** Providers, what each implements, what was verified, and what the server has configured. */
  async providers(_req: Request, res: Response) {
    const verified = await BrokerCapabilityModel.find().lean();
    res.json({
      providers: Object.values(PROVIDERS).map((p) => ({ ...p, verified: verified.filter((v) => v.provider === p.provider).map((v) => ({ capability: v.capability, verifiedOn: v.verifiedOn, at: v.at })), configured: p.provider === 'deriv' ? { oauth: brokerAuth.derivOAuthConfigured(), token: env.DERIV_ALLOW_PAT } : { bridge: env.MT5_BRIDGE_ENABLED } })),
      evaluated: EVALUATED_PROVIDERS,
      live: { envSwitch: isLiveTradingEnabledByEnv(), userLiveAllowed: env.BROKER_USER_LIVE_ALLOWED, confirmPhrase: LIVE_CONFIRM_PHRASE },
      derivRedirectUri: derivRedirectUri(),
    });
  },

  async capabilities(_req: Request, res: Response) {
    res.json({ providers: PROVIDERS, verified: await BrokerCapabilityModel.find().lean() });
  },

  async connect(req: Request, res: Response) {
    const provider = String(req.params.provider);
    const b = req.body as z.infer<typeof brokerSchemas.connect>;
    if (provider === 'deriv' && b.method === 'oauth') {
      const { authorizeUrl, binding } = await brokerAuth.startDerivOAuth(me(req));
      res.cookie(OAUTH_COOKIE, binding, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/api/brokers', maxAge: 10 * 60_000 });
      await audit(req, { action: 'BROKER_CONNECT_STARTED', resource: 'deriv' });
      return res.json({ authorizeUrl });
    }
    if (provider === 'deriv' && b.method === 'token') {
      const conns = await brokerAuth.connectDerivWithToken(me(req), b.token, b.appId);
      await audit(req, { action: 'BROKER_CONNECTED', resource: 'deriv', details: { method: 'token', accounts: conns.length } });
      return res.status(201).json({ connections: conns.map((c) => brokerConnections.view(c)) });
    }
    if (provider === 'mt5' && b.method === 'terminal') {
      const r = await brokerConnections.createMt5(me(req), b.environment, b.label);
      await audit(req, { action: 'BROKER_CONNECTED', resource: 'mt5', resourceId: r.connection.id, details: { environment: b.environment } });
      return res.status(201).json(r);
    }
    throw new AppError(400, 'Unsupported provider or connection method', 'VALIDATION_ERROR');
  },

  /** Public OAuth callback from Deriv (no bearer token on a redirect; bound by state + cookie). */
  async derivCallback(req: Request, res: Response) {
    const back = (q: string) => res.redirect(302, `${appUrl()}/brokers${q}`);
    if (req.query.error) return back(`#error=${encodeURIComponent(String(req.query.error).slice(0, 60))}`);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    res.clearCookie(OAUTH_COOKIE, { path: '/api/brokers' });
    if (!code || !state) return back('#error=missing_code');
    try {
      const { userId, tokens } = await brokerAuth.completeDerivOAuth(state, code, req.cookies?.[OAUTH_COOKIE]);
      const conns = await brokerAuth.upsertDerivConnections(userId, { ...tokens, tokenType: 'oauth' });
      await audit({ ...req, user: { id: userId } } as never, { action: 'BROKER_CONNECTED', resource: 'deriv', details: { method: 'oauth', accounts: conns.length } });
      return back(`?connected=deriv&accounts=${conns.length}`);
    } catch (err) {
      return back(`#error=${encodeURIComponent(err instanceof AppError ? (err.code ?? 'failed') : 'failed')}`);
    }
  },

  async list(req: Request, res: Response) {
    res.json({ connections: await brokerConnections.list(me(req)) });
  },
  async get(req: Request, res: Response) {
    res.json({ connection: brokerConnections.view(await brokerConnections.owned(me(req), id(req))) });
  },
  async test(req: Request, res: Response) {
    const r = await brokerConnections.test(me(req), id(req));
    await audit(req, { action: 'BROKER_TESTED', resourceId: id(req), success: r.ok });
    res.json(r);
  },
  async sync(req: Request, res: Response) {
    res.json(await brokerConnections.sync(me(req), id(req)));
  },
  async disconnect(req: Request, res: Response) {
    const r = await brokerConnections.disconnect(me(req), id(req));
    await audit(req, { action: 'BROKER_DISCONNECTED', resourceId: id(req) });
    res.json(r);
  },
  async reauthorize(req: Request, res: Response) {
    const c = await brokerConnections.owned(me(req), id(req));
    await audit(req, { action: 'BROKER_REAUTHORIZE', resourceId: id(req) });
    if (c.provider === 'mt5') return res.json(await brokerConnections.rotateTerminalSecret(me(req), id(req)));
    const { authorizeUrl, binding } = await brokerAuth.startDerivOAuth(me(req));
    res.cookie(OAUTH_COOKIE, binding, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/api/brokers', maxAge: 10 * 60_000 });
    return res.json({ authorizeUrl });
  },
  async account(req: Request, res: Response) {
    res.json({ account: await brokerConnections.account(me(req), id(req)) });
  },
  async instruments(req: Request, res: Response) {
    res.json({ instruments: await brokerConnections.instruments(me(req), id(req)) });
  },
  async positions(req: Request, res: Response) {
    res.json({ positions: await brokerConnections.positions(me(req), id(req), req.query.status === 'CLOSED' ? 'CLOSED' : 'OPEN') });
  },
  async orders(req: Request, res: Response) {
    res.json({ orders: await brokerConnections.orders(me(req), id(req)) });
  },
  async trades(req: Request, res: Response) {
    res.json({ trades: await brokerConnections.trades(me(req), id(req)) });
  },
  async health(req: Request, res: Response) {
    res.json(await brokerConnections.health(me(req), id(req)));
  },
  async logs(req: Request, res: Response) {
    res.json(await brokerConnections.logs(me(req), id(req), Number(req.query.limit ?? 100)));
  },
  async quote(req: Request, res: Response) {
    const c = await brokerConnections.owned(me(req), id(req));
    const s = symbol.parse(req.query.symbol);
    const adapter = await brokerRegistry.get(c);
    await adapter.subscribeQuotes([s]).catch(() => undefined);
    res.json({ quote: brokerMarketData.quote(c._id.toString(), s) });
  },
  /** Risk preview: sizing and every check, without sending anything. */
  async preview(req: Request, res: Response) {
    const b = req.body as z.infer<typeof brokerSchemas.order>;
    const c = await brokerConnections.owned(me(req), id(req));
    const r = await brokerOrders.evaluate(c, { ...b, userSized: b.volume !== undefined || b.stake !== undefined });
    res.json({ approved: r.approved, checks: r.checks, order: { ...r.order, clientOrderId: undefined }, maxLoss: r.maxLoss, exposure: r.exposure, leverage: r.leverage, quote: r.quote });
  },
  async placeOrder(req: Request, res: Response) {
    const b = req.body as z.infer<typeof brokerSchemas.order>;
    const r = await brokerOrders.submit({ ...b, userId: me(req), connectionId: id(req), source: 'manual' });
    await audit(req, { action: 'BROKER_ORDER', resourceId: r.order._id.toString(), success: r.order.status !== 'REJECTED', details: { connection: id(req), symbol: b.brokerSymbol, side: b.side, status: r.order.status, duplicate: r.duplicate } });
    const code = r.duplicate ? 200 : r.order.status === 'FILLED' || r.order.status === 'OPEN' ? 201 : r.order.status === 'UNKNOWN' ? 202 : 422;
    res.status(code).json({ order: r.order, duplicate: r.duplicate, pending: r.order.status === 'UNKNOWN' ? 'Execution could not be verified yet; the broker will be queried before anything is retried.' : undefined });
  },
  async closePosition(req: Request, res: Response) {
    const r = await brokerOrders.closePosition(me(req), id(req), String(req.params.positionId));
    await audit(req, { action: 'BROKER_CLOSE_POSITION', resourceId: String(req.params.positionId), details: { confirmed: r.confirmed } });
    res.status(r.confirmed ? 200 : 202).json(r);
  },
  async cancelOrder(req: Request, res: Response) {
    const r = await brokerOrders.cancelOrder(me(req), id(req), String(req.params.orderId));
    await audit(req, { action: 'BROKER_CANCEL_ORDER', resourceId: String(req.params.orderId), details: { confirmed: r.confirmed } });
    res.status(r.confirmed ? 200 : 202).json(r);
  },
  async disableTrading(req: Request, res: Response) {
    const c = await brokerOrders.disableTrading(me(req), id(req), 'Disabled by the user');
    await audit(req, { action: 'BROKER_TRADING_DISABLED', resourceId: id(req) });
    res.json({ connection: brokerConnections.view(c) });
  },
  async enableTrading(req: Request, res: Response) {
    const v = await brokerConnections.setTrading(me(req), id(req), true);
    await audit(req, { action: 'BROKER_TRADING_ENABLED', resourceId: id(req) });
    res.json({ connection: v });
  },
  async enableLive(req: Request, res: Response) {
    const b = req.body as z.infer<typeof brokerSchemas.live>;
    try {
      const v = await brokerConnections.enableLive(me(req), id(req), b);
      await audit(req, { action: 'BROKER_LIVE_ENABLED', resourceId: id(req) });
      res.json({ connection: v });
    } catch (err) {
      await audit(req, { action: 'BROKER_LIVE_ENABLE_FAILED', resourceId: id(req), success: false, details: { reason: errorMessage(err) } });
      throw err;
    }
  },
  async setDefault(req: Request, res: Response) {
    res.json({ connection: await brokerConnections.setDefault(me(req), id(req)) });
  },
  async updateLimits(req: Request, res: Response) {
    const v = await brokerConnections.updateLimits(me(req), id(req), Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined)) as Record<string, number>);
    await audit(req, { action: 'BROKER_LIMITS_UPDATED', resourceId: id(req), details: req.body });
    res.json({ connection: v });
  },
  async resetBreaker(req: Request, res: Response) {
    const v = await brokerConnections.resetBreaker(me(req), id(req));
    await audit(req, { action: 'BROKER_BREAKER_RESET', resourceId: id(req) });
    res.json({ connection: v });
  },
  async emergencyCancel(req: Request, res: Response) {
    const r = await brokerOrders.cancelAll(me(req), id(req));
    await audit(req, { action: 'BROKER_EMERGENCY_CANCEL', resourceId: id(req), details: r });
    res.json(r);
  },
  async emergencyClose(req: Request, res: Response) {
    await brokerOrders.disableTrading(me(req), id(req), 'Emergency close requested');
    const r = await brokerOrders.closeAll(me(req), id(req));
    await audit(req, { action: 'BROKER_EMERGENCY_CLOSE', resourceId: id(req), details: r });
    res.json({ ...r, note: 'Positions are closed only when the broker confirms. Unconfirmed closes may fail because of market hours, liquidity, network problems or broker restrictions — check the broker platform.' });
  },
  async assignments(req: Request, res: Response) {
    res.json({ assignments: await brokerConnections.assignments(me(req)) });
  },
  async assign(req: Request, res: Response) {
    const a = await brokerConnections.assign(me(req), req.body);
    await audit(req, { action: 'BROKER_ASSIGNMENT', details: { connection: req.body.connectionId, strategy: req.body.strategyKey, enabled: req.body.enabled } });
    res.json({ assignment: a });
  },
  async unassign(req: Request, res: Response) {
    await brokerConnections.unassign(me(req), String(req.params.assignmentId));
    res.json({ ok: true });
  },

  /** Admin emergency: disable trading on EVERY user broker account (protected action). */
  async adminDisableAll(req: Request, res: Response) {
    const conns = await BrokerConnectionModel.find({ tradingEnabled: true });
    for (const c of conns) {
      c.tradingEnabled = false;
      c.liveEnabled = false;
      await c.save();
      await logBrokerEvent(c, 'TRADING_DISABLED', 'Disabled by an administrator (emergency)', undefined, 'warn');
    }
    await audit(req, { action: 'BROKER_EMERGENCY_DISABLE_ALL', details: { count: conns.length } });
    res.json({ disabled: conns.length });
  },
};

/** Signed MT5 terminal endpoints (public; authenticated by HMAC signature). */
export function mt5BridgeHandler(kind: 'hello' | 'heartbeat' | 'symbols' | 'quotes' | 'reports' | 'poll') {
  return async (req: Request, res: Response) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const conn = await mt5Bridge.authenticate(req.headers, 'POST', req.originalUrl.split('?')[0], raw);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (kind === 'hello') return res.json(await mt5Bridge.hello(conn, body));
    if (kind === 'heartbeat') return res.type('text/plain').send(await mt5Bridge.heartbeat(conn, body));
    if (kind === 'poll') return res.type('text/plain').send(await mt5Bridge.pendingCommands(conn._id.toString()));
    if (kind === 'symbols') return res.json(await mt5Bridge.symbols(conn, body));
    if (kind === 'quotes') return res.json(mt5Bridge.quotes(conn, body));
    return res.json(await mt5Bridge.reports(conn, body));
  };
}
