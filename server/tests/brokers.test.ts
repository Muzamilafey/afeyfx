import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { reloadEnv } from '../src/config/env';
import { brokerService } from '../src/brokers/BrokerService';
import { DerivAdapter, derivSymbol, DERIV_ALLOWED } from '../src/brokers/DerivAdapter';
import { OandaBrokerAdapter } from '../src/brokers/OandaBrokerAdapter';
import { BrokerAmbiguousError, type BrokerAdapter } from '../src/brokers/types';
import { positionManager } from '../src/execution/PositionManager';
import { BrokerConfigModel } from '../src/models/BrokerConfig';
import { PaymentConfigModel } from '../src/models/PaymentConfig';
import { PortfolioModel } from '../src/models/Portfolio';
import { PositionModel } from '../src/models/Position';
import { OrderModel } from '../src/models/Order';
import { portfolioService } from '../src/portfolio/PortfolioService';
import { marketDataCache } from '../src/marketData/MarketDataCache';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { WithdrawalForbiddenError } from '../src/utils/errors';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser } from './helpers/api';

const app = createApp();
const setBook = (bid: number, ask: number) => {
  marketDataCache.setTicker('binance', { symbol: 'BTC/USDT', timestamp: Date.now(), last: (bid + ask) / 2, bid, ask });
  marketDataCache.setOrderBook('binance', { symbol: 'BTC/USDT', timestamp: Date.now(), bids: [{ price: bid, amount: 100 }], asks: [{ price: ask, amount: 100 }] });
};

/** Mock broker adapter: tests decide each answer. */
function mockBroker(): BrokerAdapter & { [k: string]: ReturnType<typeof vi.fn> | unknown } {
  return {
    id: 'deriv',
    name: 'Deriv',
    configured: () => true,
    supports: () => true,
    open: vi.fn(async (r) => ({ status: 'FILLED', brokerRef: 'C-1', price: r.price, units: r.investmentUsd / r.price, feeUsd: 0 })),
    close: vi.fn(async () => ({ status: 'CLOSED', pnlUsd: 7.25 })),
    status: vi.fn(async () => ({ open: true })),
    lookup: vi.fn(async () => null),
    openRefs: vi.fn(async () => []),
    test: vi.fn(async () => ({ ok: true, message: 'ok', currency: 'USD' })),
  } as never;
}

async function fundedTrader(amount = 500) {
  const t = await makeUser(app, `t${Math.random()}@x.io`, 'trader');
  const me = (await request(app).get('/api/auth/me').set(t.auth)).body.user._id as string;
  await portfolioService.applyCashFlow(me, amount);
  return { ...t, id: me };
}

beforeAll(connectTestDb);
afterAll(async () => {
  brokerService.setAdapter('deriv', null);
  process.env.LIVE_TRADING_ENABLED = 'false';
  reloadEnv();
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearDb();
  marketDataCache.clear();
  tradingState.reset();
  circuitBreaker.resetAll();
  process.env.LIVE_TRADING_ENABLED = 'false';
  reloadEnv();
  brokerService.setAdapter('deriv', null);
  brokerService.invalidate();
  await PaymentConfigModel.updateOne({ key: 'mpesa' }, { $set: { realTradingEnabled: true } }, { upsert: true });
});

describe('Deriv adapter', () => {
  it('maps symbols and can never send cashier / transfer / payment-agent requests', async () => {
    expect(derivSymbol('EUR/USD')).toBe('frxEURUSD');
    expect(derivSymbol('XAU/USD')).toBe('frxXAUUSD');
    expect(derivSymbol('BTC/USDT')).toBe('cryBTCUSD');
    const sent: Record<string, unknown>[] = [];
    const a = new DerivAdapter({ appId: '1', token: 't', currency: 'USD', multipliers: { crypto: 50, forex: 50, metals: 50 } }, async (m) => (sent.push(m), {}));
    const call = (a as unknown as { call(m: Record<string, unknown>): Promise<unknown> }).call.bind(a);
    for (const bad of [{ cashier: 'withdraw' }, { transfer_between_accounts: 1 }, { paymentagent_withdraw: 1 }, { paymentagent_transfer: 1 }, { p2p_order_create: 1 }, { proposal: 1, transfer: 1 }]) await expect(call(bad)).rejects.toThrow(WithdrawalForbiddenError);
    expect(sent).toHaveLength(0);
    expect([...DERIV_ALLOWED].some((k) => /withdraw|transfer|cashier|payment/.test(k))).toBe(false);
  });

  it('opens a multiplier contract sized to the investment with broker-side SL/TP, and closes it', async () => {
    const sent: Record<string, unknown>[] = [];
    const a = new DerivAdapter({ appId: '1', token: 't', currency: 'USD', multipliers: { crypto: 50, forex: 100, metals: 50 } }, async (m) => {
      sent.push(m);
      if ('proposal' in m) return { proposal: { id: 'P1', spot: 1.085 } };
      if ('buy' in m) return { buy: { contract_id: 123, buy_price: 10 } };
      if ('proposal_open_contract' in m) return { proposal_open_contract: { is_sold: sent.some((x) => 'sell' in x) ? 1 : 0, entry_spot: 1.0851, profit: 4.2, exit_tick: 1.0896, buy_price: 10 } };
      if ('sell' in m) return { sell: { sold_for: 14.2 } };
      return {};
    });
    const f = await a.open({ symbol: 'EUR/USD', direction: 'LONG', units: 921, investmentUsd: 1000, stopLoss: 1.0851 * 0.99, takeProfit: 1.0851 * 1.02, clientRef: 'ref-1', price: 1.0851 });
    expect(f).toMatchObject({ status: 'FILLED', brokerRef: '123', price: 1.0851 });
    expect(sent[0]).toMatchObject({ proposal: 1, amount: 10, basis: 'stake', contract_type: 'MULTUP', symbol: 'frxEURUSD', multiplier: 100, limit_order: { stop_loss: 10, take_profit: 20 } });
    const c = await a.close('123');
    expect(c).toMatchObject({ status: 'CLOSED', pnlUsd: 4.2 });
  });
});

describe('OANDA execution adapter', () => {
  it('sends FOK market orders with client ids and attached SL/TP; only order/trade/summary endpoints are reachable', async () => {
    const calls: { url: string; init: { method: string; body?: string } }[] = [];
    const a = new OandaBrokerAdapter({ token: 't', accountId: 'A1', environment: 'practice' }, async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({ orderFillTransaction: { price: '1.08510', tradeOpened: { tradeID: '77', units: '1000' } } }) };
    });
    const f = await a.open({ symbol: 'EUR/USD', direction: 'SHORT', units: 1000.7, investmentUsd: 1085, stopLoss: 1.0951, takeProfit: 1.0751, clientRef: 'real:u:abc', price: 1.085 });
    expect(f).toMatchObject({ status: 'FILLED', brokerRef: '77', price: 1.0851, units: 1000 });
    expect(calls[0].url).toBe('https://api-fxpractice.oanda.com/v3/accounts/A1/orders');
    expect(JSON.parse(calls[0].init.body!).order).toMatchObject({ type: 'MARKET', instrument: 'EUR_USD', units: '-1000', timeInForce: 'FOK', clientExtensions: { id: 'real:u:abc' }, stopLossOnFill: { price: '1.09510' }, takeProfitOnFill: { price: '1.07510' } });
    const req = (a as unknown as { req(m: string, p: string): Promise<unknown> }).req.bind(a);
    await expect(req('POST', '/v3/accounts/A1/transfers')).rejects.toThrow(WithdrawalForbiddenError);
    expect(a.supports('BTC/USDT')).toBe(false);
  });
});

describe('REAL-account routing to an external broker', () => {
  it('is impossible while LIVE_TRADING_ENABLED is not true: the order is rejected and nothing reaches the broker', async () => {
    const broker = mockBroker();
    brokerService.setAdapter('deriv', broker);
    await BrokerConfigModel.updateOne({ key: 'brokers' }, { $set: { 'routes.crypto': 'deriv' } }, { upsert: true });
    const t = await fundedTrader();
    setBook(99.9, 100.1);
    const r = await request(app).post('/api/account/orders').set(t.auth).send({ account: 'REAL', symbol: 'BTC/USDT', direction: 'LONG', investment: 100, stopLossPct: 0.05 });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/LIVE_TRADING_ENABLED/);
    expect(broker.open).not.toHaveBeenCalled();
    expect(await PositionModel.countDocuments()).toBe(0);
    expect((await PortfolioModel.findOne({ mode: 'REAL', owner: t.id }))!.balance).toBe(500);
  });

  it('routing needs a 2FA admin, the kill switch on and a passing connection test', async () => {
    const broker = mockBroker();
    brokerService.setAdapter('deriv', broker);
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    expect((await request(app).put('/api/admin/brokers/routes').set(a.auth).send({ category: 'crypto', route: 'deriv' })).status).toBe(401);
    expect((await request(app).put('/api/admin/brokers/routes').set(a.auth).send({ category: 'crypto', route: 'deriv', totp: a.code() })).status).toBe(403);
    process.env.LIVE_TRADING_ENABLED = 'true';
    reloadEnv();
    (broker.test as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, message: 'InvalidToken' });
    expect((await request(app).put('/api/admin/brokers/routes').set(a.auth).send({ category: 'crypto', route: 'deriv', totp: a.code() })).body.error.code).toBe('BROKER_TEST_FAILED');
    const ok = await request(app).put('/api/admin/brokers/routes').set(a.auth).send({ category: 'crypto', route: 'deriv', totp: a.code() });
    expect(ok.status).toBe(200);
    expect(ok.body.routes.crypto).toBe('deriv');
    const t = await makeUser(app, 't@x.io', 'trader');
    expect((await request(app).get('/api/admin/brokers').set(t.auth)).status).toBe(403);
  });

  it('opens at the broker, closes at the broker, and books exactly the broker-reported P&L', async () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    reloadEnv();
    const broker = mockBroker();
    brokerService.setAdapter('deriv', broker);
    await BrokerConfigModel.updateOne({ key: 'brokers' }, { $set: { 'routes.crypto': 'deriv' } }, { upsert: true });
    const t = await fundedTrader();
    setBook(99.9, 100.1);
    const o = await request(app).post('/api/account/orders').set(t.auth).send({ account: 'REAL', symbol: 'BTC/USDT', direction: 'LONG', investment: 100, stopLossPct: 0.05, takeProfitPct: 0.1 });
    expect(o.status).toBe(201);
    expect(broker.open).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC/USDT', direction: 'LONG', investmentUsd: 100, stopLoss: expect.any(Number), takeProfit: expect.any(Number) }));
    expect(o.body.position).toMatchObject({ broker: 'deriv', brokerRef: 'C-1', mode: 'REAL' });
    expect((await PortfolioModel.findOne({ mode: 'REAL', owner: t.id }))!.balance).toBeCloseTo(400, 6);
    // Local stop monitoring is skipped: the stop lives at the broker.
    setBook(50, 50.2);
    await positionManager.monitor('REAL');
    expect(broker.close).not.toHaveBeenCalled();
    const c = await request(app).post(`/api/account/positions/${o.body.position._id}/close`).set(t.auth);
    expect(c.status).toBe(200);
    expect(broker.close).toHaveBeenCalledWith('C-1', expect.anything());
    expect(c.body.trade.netPnl).toBeCloseTo(7.25, 6);
    expect((await PortfolioModel.findOne({ mode: 'REAL', owner: t.id }))!.balance).toBeCloseTo(507.25, 6);
  });

  it('positions closed broker-side (stop loss) are synced with the broker result; ambiguous opens are looked up, not retried', async () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    reloadEnv();
    const broker = mockBroker();
    brokerService.setAdapter('deriv', broker);
    await BrokerConfigModel.updateOne({ key: 'brokers' }, { $set: { 'routes.crypto': 'deriv' } }, { upsert: true });
    const t = await fundedTrader();
    setBook(99.9, 100.1);
    const o = await request(app).post('/api/account/orders').set(t.auth).send({ account: 'REAL', symbol: 'BTC/USDT', direction: 'LONG', investment: 100, stopLossPct: 0.05 });
    (broker.status as ReturnType<typeof vi.fn>).mockResolvedValue({ open: false, pnlUsd: -5, closePrice: 95 });
    await brokerService.sync((id, pnl, px, reason) => positionManager.closeFromBroker(id, pnl, px, reason));
    await brokerService.sync((id, pnl, px, reason) => positionManager.closeFromBroker(id, pnl, px, reason)); // idempotent
    const pos = await PositionModel.findById(o.body.position._id);
    expect(pos!.status).toBe('CLOSED');
    expect((await PortfolioModel.findOne({ mode: 'REAL', owner: t.id }))!.balance).toBeCloseTo(495, 6);

    (broker.open as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new BrokerAmbiguousError('timeout'));
    (broker.lookup as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'FILLED', brokerRef: 'C-2', price: 100.1, units: 0.999, feeUsd: 0 });
    const o2 = await request(app).post('/api/account/orders').set(t.auth).send({ account: 'REAL', symbol: 'BTC/USDT', direction: 'LONG', investment: 100, stopLossPct: 0.05 });
    expect(o2.status).toBe(201);
    expect(o2.body.position.brokerRef).toBe('C-2');
    expect(broker.open).toHaveBeenCalledTimes(2);

    (broker.open as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new BrokerAmbiguousError('timeout'));
    (broker.lookup as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'));
    const o3 = await request(app).post('/api/account/orders').set(t.auth).send({ account: 'REAL', symbol: 'BTC/USDT', direction: 'LONG', investment: 100, stopLossPct: 0.05 });
    expect(o3.status).toBe(422);
    expect(await OrderModel.countDocuments({ status: 'UNKNOWN' })).toBe(1); // left for reconciliation
  });

  it('never routes on simulated market data', async () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    process.env.MARKET_DATA_SOURCE = 'simulated';
    reloadEnv();
    expect(() => brokerService.assertAllowed('OPEN')).toThrow(/Simulated/);
    delete process.env.MARKET_DATA_SOURCE;
    reloadEnv();
    expect(() => brokerService.assertAllowed('OPEN')).not.toThrow();
    tradingState.update({ emergencyShutdown: true });
    expect(() => brokerService.assertAllowed('OPEN')).toThrow(/Emergency/);
    expect(() => brokerService.assertAllowed('REDUCE')).not.toThrow();
  });
});
