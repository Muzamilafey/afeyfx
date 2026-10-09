import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { EventEmitter } from 'events';
import '../src/models';
import { createApp } from '../src/app';
import { reloadEnv } from '../src/config/env';
import { BrokerConnectionModel } from '../src/models/BrokerConnection';
import { BrokerOAuthStateModel, Mt5CommandModel, StrategyAccountAssignmentModel } from '../src/models/BrokerRecords';
import { OrderModel } from '../src/models/Order';
import { PositionModel } from '../src/models/Position';
import { TradeModel } from '../src/models/Trade';
import { StrategyModel } from '../src/models/Strategy';
import { signMt5, mt5Bridge } from '../src/brokers/mt5/Mt5Bridge';
import { DerivSocket, setDerivFetch, setDerivWsFactory, type WsLike } from '../src/brokers/deriv/DerivApi';
import { DerivConnectionAdapter } from '../src/brokers/deriv/DerivConnectionAdapter';
import { BrokerError } from '../src/brokers/core/types';
import { brokerRegistry } from '../src/brokers/services/BrokerRegistry';
import { brokerMarketData } from '../src/brokers/services/BrokerDataServices';
import { brokerReconciliation } from '../src/brokers/services/BrokerReconciliationService';
import { dispatchSignalToAccounts } from '../src/brokers/services/BrokerStrategyDispatcher';
import { setBrokerAuthFetch } from '../src/brokers/services/BrokerAuthenticationService';
import { route } from '../src/websocket/socket';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { decrypt } from '../src/utils/crypto';
import { WithdrawalForbiddenError } from '../src/utils/errors';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser } from './helpers/api';

const app = createApp();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BRIDGE = '/api/bridge/mt5';

/** Simulated MT5 terminal speaking the signed bridge protocol (what the EA does). */
function terminal(terminalId: string, secret: string) {
  const post = (endpoint: string, body: unknown, opts: { ts?: number; nonce?: string; badSig?: boolean } = {}) => {
    const raw = JSON.stringify(body);
    const ts = String(opts.ts ?? Date.now());
    const nonce = opts.nonce ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const path = `${BRIDGE}/${endpoint}`;
    const sig = opts.badSig ? 'f'.repeat(64) : signMt5(secret, ts, nonce, 'POST', path, raw);
    return request(app).post(path).set({ 'Content-Type': 'application/json', 'X-AFX-Terminal': terminalId, 'X-AFX-Timestamp': ts, 'X-AFX-Nonce': nonce, 'X-AFX-Signature': sig }).send(raw);
  };
  const state = { positions: [] as Record<string, unknown>[], deals: [] as Record<string, unknown>[], balance: 10_000 };
  return {
    post,
    state,
    hello: (tradeMode = 'demo', login = '5550001') => post('hello', { login, server: 'Exness-MT5Trial', company: 'Exness', currency: 'USD', tradeMode, leverage: 100, eaVersion: '1.00' }),
    symbols: () => post('symbols', { symbols: [{ name: 'EURUSDm', description: 'Euro vs US Dollar', digits: 5, contractSize: 100000, tickSize: 0.00001, tickValue: 1, volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01, tradeMode: 'full', currencyProfit: 'USD', path: 'Forex\\Majors' }] }),
    quote: (bid = 1.085, ask = 1.08502) => post('quotes', { quotes: [{ s: 'EURUSDm', b: bid, a: ask, t: Date.now() }] }),
    heartbeat: () => post('heartbeat', { balance: state.balance, equity: state.balance, margin: 0, freeMargin: state.balance, positions: state.positions, orders: [], deals: state.deals }),
    poll: () => post('poll', {}),
  };
}

async function mt5Connection(t: { auth: Record<string, string> }, environment: 'demo' | 'real' = 'demo') {
  const r = await request(app).post('/api/brokers/mt5/connect').set(t.auth).send({ method: 'terminal', environment });
  expect(r.status).toBe(201);
  return { id: r.body.connection.id as string, term: terminal(r.body.terminalId, r.body.terminalSecret), body: r.body };
}

/** Terminal loop: answer every queued command with `respond`. */
async function serveCommands(term: ReturnType<typeof terminal>, respond: (fields: string[]) => Record<string, unknown> | null) {
  const lines = (await term.poll()).text.split('\n').filter(Boolean);
  const reports = [];
  for (const l of lines) {
    const f = l.split('|');
    const r = respond(f);
    if (r) reports.push({ commandId: f[1], ...r });
  }
  if (reports.length) await term.post('reports', { reports });
  return lines;
}

async function readyMt5(t: { auth: Record<string, string> }) {
  const c = await mt5Connection(t);
  expect((await c.term.hello()).status).toBe(200);
  await c.term.symbols();
  await c.term.heartbeat();
  await c.term.quote();
  expect((await request(app).post(`/api/brokers/connections/${c.id}/test`).set(t.auth)).body.ok).toBe(true);
  await request(app).post(`/api/brokers/connections/${c.id}/sync`).set(t.auth);
  expect((await request(app).post(`/api/brokers/connections/${c.id}/trading/enable`).set(t.auth).send({ confirm: true })).status).toBe(200);
  return c;
}

beforeAll(connectTestDb);
afterAll(async () => {
  setDerivFetch(null);
  setDerivWsFactory(null);
  setBrokerAuthFetch(null);
  await brokerRegistry.dropAll();
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearDb();
  await brokerRegistry.dropAll();
  mt5Bridge.reset();
  brokerMarketData.clear();
  brokerRegistry.setFactory('deriv', null);
  tradingState.reset();
  circuitBreaker.resetAll();
  delete process.env.LIVE_TRADING_ENABLED;
  process.env.LIVE_TRADING_ENABLED = 'false';
  reloadEnv();
});

// ======================================================================= MT5 bridge
describe('MT5 bridge protocol', () => {
  it('rejects bad signatures, replays and clock skew; binds the MT5 login on first hello', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await mt5Connection(t);
    expect((await c.term.post('hello', {}, { badSig: true })).status).toBe(401);
    expect((await c.term.post('hello', { login: '1', tradeMode: 'demo' }, { ts: Date.now() - 10 * 60_000 })).body.error.code).toBe('BRIDGE_CLOCK');
    const nonce = 'fixed-nonce-123456';
    expect((await c.term.post('hello', { login: '5550001', tradeMode: 'demo', currency: 'USD' }, { nonce })).status).toBe(200);
    expect((await c.term.post('hello', { login: '5550001', tradeMode: 'demo', currency: 'USD' }, { nonce })).body.error.code).toBe('BRIDGE_REPLAY');
    // Same terminal later logged in to another account: refused, trading disabled.
    expect((await c.term.hello('demo', '9999999')).body.error.code).toBe('ACCOUNT_MISMATCH');
    const doc = (await BrokerConnectionModel.findById(c.id))!;
    expect(doc.status).toBe('ERROR');
    expect(doc.tradingEnabled).toBe(false);
  });

  it('a demo connection never becomes a real one (and the terminal secret is never returned again)', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await mt5Connection(t, 'demo');
    expect((await c.term.hello('real')).body.error.code).toBe('ENVIRONMENT_MISMATCH');
    const list = JSON.stringify((await request(app).get('/api/brokers/connections').set(t.auth)).body);
    expect(list).not.toContain(c.body.terminalSecret);
    const doc = (await BrokerConnectionModel.findById(c.id))!;
    expect(doc.terminalSecretEnc).not.toContain(c.body.terminalSecret);
    expect(decrypt(doc.terminalSecretEnc!)).toBe(c.body.terminalSecret);
  });

  it('places an order end to end: risk-sized, queued, executed by the terminal, confirmed, idempotent', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await readyMt5(t);
    const order = { idempotencyKey: 'ord-000001', brokerSymbol: 'EURUSDm', side: 'buy', product: 'cfd', stopLoss: 1.080 };
    const pending = request(app).post(`/api/brokers/connections/${c.id}/orders`).set(t.auth).send(order);
    const p = pending.then((r) => r);
    let lines: string[] = [];
    for (let i = 0; i < 40 && !lines.length; i++) {
      await wait(50);
      lines = await serveCommands(c.term, (f) => ({ status: 'filled', retcode: 10009, order: '9001', deal: '7001', position: '9001', price: 1.08503, volume: Number(f[6]) }));
    }
    const r = await p;
    expect(r.status).toBe(201);
    expect(r.body.order.status).toBe('FILLED');
    const f = lines[0].split('|');
    expect(f.slice(2, 6)).toEqual(['order.place', 'EURUSDm', 'buy', 'market']);
    // 0.5% of 10,000 = $50 risk; stop 0.00502 away at $1/pip-tick → 50 / 502 = 0.09 lots, capped by 20% exposure (≈0.01 lots)
    expect(Number(f[6])).toBeGreaterThan(0);
    expect(Number(f[6])).toBeLessThanOrEqual(0.09);
    const pos = await PositionModel.findOne({ connection: c.id });
    expect(pos).toMatchObject({ mode: 'DEMO', broker: 'mt5', brokerRef: '9001', status: 'OPEN' });
    // Same idempotency key → same order, no second command.
    const again = await request(app).post(`/api/brokers/connections/${c.id}/orders`).set(t.auth).send(order);
    expect(again.body.duplicate).toBe(true);
    expect(await Mt5CommandModel.countDocuments()).toBe(1);
    // Duplicate execution report is ignored.
    await c.term.post('reports', { reports: [{ commandId: f[1], status: 'filled', price: 1.2 }] });
    expect((await OrderModel.findById(r.body.order._id))!.averagePrice).toBe(1.08503);
  });

  it('no report → UNKNOWN (account halted), resolved by reconciliation from the terminal state — never resent', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await readyMt5(t);
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
    const p = request(app).post(`/api/brokers/connections/${c.id}/orders`).set(t.auth).send({ idempotencyKey: 'ord-unknown1', brokerSymbol: 'EURUSDm', side: 'sell', product: 'cfd', stopLoss: 1.09 }).then((r) => r);
    let cmd: string[] = [];
    for (let i = 0; i < 40 && !cmd.length; i++) {
      await wait(20);
      cmd = (await c.term.poll()).text.split('\n').filter(Boolean);
    }
    await vi.advanceTimersByTimeAsync(25_000);
    const r = await p;
    vi.useRealTimers();
    expect(r.status).toBe(202);
    expect(r.body.order.status).toBe('UNKNOWN');
    expect((await BrokerConnectionModel.findById(c.id))!.breaker?.tripped).toBe(true);
    // The terminal did execute it: the position carries the commandId in its comment.
    const commandId = cmd[0].split('|')[1];
    c.term.state.positions = [{ ticket: '9100', symbol: 'EURUSDm', type: 'sell', volume: 0.01, priceOpen: 1.085, comment: commandId }];
    await c.term.heartbeat();
    await brokerReconciliation.run((await BrokerConnectionModel.findById(c.id))!);
    expect((await OrderModel.findById(r.body.order._id))!.status).toBe('FILLED');
    expect(await PositionModel.countDocuments({ connection: c.id, brokerRef: '9100' })).toBe(1);
    expect(await Mt5CommandModel.countDocuments()).toBe(1); // never re-sent
    expect((await request(app).post(`/api/brokers/connections/${c.id}/breaker/reset`).set(t.auth)).status).toBe(200);
  });

  it('positions closed at the broker are booked with the broker P&L after a restart', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await readyMt5(t);
    c.term.state.positions = [{ ticket: '500', symbol: 'EURUSDm', type: 'buy', volume: 0.02, priceOpen: 1.08 }];
    await c.term.heartbeat();
    await brokerReconciliation.run((await BrokerConnectionModel.findById(c.id))!);
    expect(await PositionModel.countDocuments({ connection: c.id, status: 'OPEN', strategyKey: 'external' })).toBe(1); // adopted from the broker
    // "Restart": in-memory state lost, then the terminal reports the position closed by its stop loss.
    mt5Bridge.reset();
    await brokerRegistry.dropAll();
    await c.term.hello();
    c.term.state.positions = [];
    c.term.state.deals = [{ ticket: '801', positionId: '500', symbol: 'EURUSDm', entry: 'out', type: 'sell', volume: 0.02, price: 1.079, profit: -20, commission: -0.14, swap: 0, time: Date.now(), comment: '[sl 1.07900]' }];
    c.term.state.balance = 9979.86;
    await c.term.heartbeat();
    await brokerReconciliation.run((await BrokerConnectionModel.findById(c.id))!);
    const trade = await TradeModel.findOne({ connection: c.id });
    expect(trade).toMatchObject({ brokerRef: '500', netPnl: -20.14, exitReason: 'Stop loss' });
    expect((await BrokerConnectionModel.findById(c.id))!.breaker?.tripped).not.toBe(true); // balance change explained
  });
});

// ======================================================================= risk & live gating
describe('broker account risk controls', () => {
  it('live trading is disabled by default: real accounts cannot trade or be enabled', async () => {
    const t = await makeUser(app, 'r@x.io', 'trader', true);
    const c = await mt5Connection(t, 'real');
    await c.term.hello('real');
    await c.term.symbols();
    await c.term.heartbeat();
    await c.term.quote();
    await request(app).post(`/api/brokers/connections/${c.id}/test`).set(t.auth);
    await request(app).post(`/api/brokers/connections/${c.id}/trading/enable`).set(t.auth).send({ confirm: true });
    const r = await request(app).post(`/api/brokers/connections/${c.id}/orders`).set(t.auth).send({ idempotencyKey: 'live-0001', brokerSymbol: 'EURUSDm', side: 'buy', product: 'cfd', stopLoss: 1.08 });
    expect(r.status).toBe(422);
    expect(r.body.order.rejectReason).toMatch(/LIVE_TRADING_ENABLED/);
    expect(await Mt5CommandModel.countDocuments()).toBe(0); // nothing reached the terminal
    const live = await request(app).post(`/api/brokers/connections/${c.id}/live/enable`).set(t.auth).send({ confirm: 'ENABLE LIVE TRADING', password: 'CorrectHorse9Battery', totp: t.code() });
    expect(live.body.error.code).toBe('LIVE_DISABLED');
  });

  it('rejects stale quotes, missing stops, halted accounts and emergency stops before anything is sent', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await readyMt5(t);
    const send = (k: string, extra: Record<string, unknown> = {}) => request(app).post(`/api/brokers/connections/${c.id}/orders`).set(t.auth).send({ idempotencyKey: k, brokerSymbol: 'EURUSDm', side: 'buy', product: 'cfd', stopLoss: 1.08, ...extra });
    expect((await send('nostop-001', { stopLoss: undefined })).body.order.rejectReason).toMatch(/stop-loss/);
    expect((await send('wrongside1', { stopLoss: 1.09 })).body.order.rejectReason).toMatch(/wrong side/);
    expect((await send('toolarge01', { volume: 5 })).body.order.rejectReason).toMatch(/risk-per-trade|leverage/);
    tradingState.update({ tradingEnabled: false });
    expect((await send('stopped-01')).body.order.rejectReason).toMatch(/New trades are stopped/);
    tradingState.reset();
    await BrokerConnectionModel.updateOne({ _id: c.id }, { $set: { 'riskLimits.maxQuoteAgeMs': 1000 } });
    await wait(1100);
    expect((await send('stale-0001')).body.order.rejectReason).toMatch(/quote-fresh/);
    await BrokerConnectionModel.updateOne({ _id: c.id }, { $set: { dayStartEquity: 11_000 } });
    await c.term.quote();
    expect((await send('dd-0000001')).body.order.rejectReason).toMatch(/daily-loss/);
    expect(await Mt5CommandModel.countDocuments()).toBe(0);
    const prev = await request(app).post(`/api/brokers/connections/${c.id}/orders/preview`).set(t.auth).send({ idempotencyKey: 'preview-01', brokerSymbol: 'EURUSDm', side: 'buy', product: 'cfd', stopLoss: 1.08 });
    expect(prev.body.checks.find((x: { name: string }) => x.name === 'daily-loss').passed).toBe(false);
  });

  it('emergency close reports only what the broker confirmed', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await readyMt5(t);
    c.term.state.positions = [{ ticket: '11', symbol: 'EURUSDm', type: 'buy', volume: 0.01, priceOpen: 1.08 }, { ticket: '12', symbol: 'EURUSDm', type: 'buy', volume: 0.01, priceOpen: 1.08 }];
    await c.term.heartbeat();
    const p = request(app).post(`/api/brokers/connections/${c.id}/emergency/close-positions`).set(t.auth).send({ confirm: true }).then((r) => r);
    for (let i = 0; i < 80; i++) {
      await wait(30);
      await serveCommands(c.term, (f) => (f[10] === '11' ? { status: 'done', retcode: 10009, position: '11', price: 1.081 } : { status: 'rejected', retcode: 10018, message: 'Market closed' }));
    }
    const r = await p;
    expect(r.body.results.find((x: { brokerPositionId: string }) => x.brokerPositionId === '11').confirmed).toBe(true);
    expect(r.body.results.find((x: { brokerPositionId: string }) => x.brokerPositionId === '12')).toMatchObject({ confirmed: false });
    expect((await BrokerConnectionModel.findById(c.id))!.tradingEnabled).toBe(false);
  }, 20_000);
});

// ======================================================================= ownership & isolation
describe('ownership and isolation', () => {
  it('one user can never read or trade another user’s connection; broker events stay in the owner’s room', async () => {
    const a = await makeUser(app, 'a@x.io', 'trader');
    const b = await makeUser(app, 'b@x.io', 'trader');
    const c = await mt5Connection(a);
    for (const [m, path] of [['get', ''], ['post', '/test'], ['post', '/sync'], ['get', '/positions'], ['get', '/orders'], ['get', '/logs'], ['post', '/trading/disable'], ['post', '/orders']] as const) {
      const req = (request(app) as unknown as Record<string, (p: string) => request.Test>)[m](`/api/brokers/connections/${c.id}${path}`).set(b.auth);
      const r = m === 'post' ? await req.send(path === '/orders' ? { idempotencyKey: 'steal-0001', brokerSymbol: 'EURUSDm', side: 'buy', product: 'cfd', stopLoss: 1 } : {}) : await req;
      expect(r.status).toBe(404);
    }
    expect((await request(app).get('/api/brokers/connections').set(b.auth)).body.connections).toHaveLength(0);
    expect(route('broker', { user: 'u1', connection: 'c', kind: 'account' })).toBe('user:u1');
    const viewer = await makeUser(app, 'v@x.io', 'viewer');
    expect((await request(app).get('/api/brokers/connections').set(viewer.auth)).status).toBe(403);
  });
});

// ======================================================================= Deriv
function fakeDerivSocketServer(handler: (msg: Record<string, unknown>, ws: FakeWs) => Record<string, unknown> | null) {
  const sockets: FakeWs[] = [];
  class FakeWs extends EventEmitter implements WsLike {
    readyState = 0;
    sent: Record<string, unknown>[] = [];
    constructor(public url: string) {
      super();
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.emit('open');
      }, 1);
    }
    send(data: string) {
      const m = JSON.parse(data);
      this.sent.push(m);
      const r = handler(m, this);
      if (r) setTimeout(() => this.emit('message', JSON.stringify({ req_id: m.req_id, ...r })), 1);
    }
    push(m: Record<string, unknown>) {
      this.emit('message', JSON.stringify(m));
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }
  setDerivWsFactory((url) => new FakeWs(url));
  return sockets;
}

describe('Deriv (current API: OAuth + OTP WebSocket)', () => {
  it('OAuth: PKCE S256, trading scope only, browser-bound state, server-side code exchange, one connection per account', async () => {
    process.env.DERIV_CLIENT_ID = 'client-123';
    process.env.DERIV_OAUTH_SCOPES = 'trade payment';
    reloadEnv();
    const t = await makeUser(app, 't@x.io', 'trader');
    const start = await request(app).post('/api/brokers/deriv/connect').set(t.auth).send({ method: 'oauth' });
    const url = new URL(start.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://auth.deriv.com/oauth2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('trade'); // "payment" is never requested
    expect(url.searchParams.get('redirect_uri')).toMatch(/\/api\/brokers\/deriv\/callback$/);
    const cookie = String(start.headers['set-cookie']).split(';')[0];
    const state = url.searchParams.get('state')!;
    let tokenBody = '';
    setBrokerAuthFetch(async (_u, init) => ((tokenBody = init.body), { ok: true, status: 200, json: async () => ({ access_token: 'deriv-access-token-XYZ', token_type: 'Bearer', expires_in: 3600 }) }));
    setDerivFetch(async (u) => ({ ok: true, status: 200, json: async () => (u.endsWith('options/accounts') ? { data: [{ account_id: 'DOT90001', balance: '10000.00', currency: 'USD', account_type: 'demo' }, { account_id: 'ROT10001', balance: '25.00', currency: 'USD', account_type: 'real' }] } : {}) }));
    // Wrong browser (no binding cookie) → refused, and the state is consumed.
    const bad = await request(app).get(`/api/brokers/deriv/callback?code=abc&state=${state}`);
    expect(bad.headers.location).toMatch(/#error=OAUTH_STATE_INVALID/);
    const start2 = await request(app).post('/api/brokers/deriv/connect').set(t.auth).send({ method: 'oauth' });
    const s2 = new URL(start2.body.authorizeUrl).searchParams.get('state')!;
    const ok = await request(app).get(`/api/brokers/deriv/callback?code=abc&state=${s2}`).set('Cookie', String(start2.headers['set-cookie']).split(';')[0]);
    expect(ok.headers.location).toMatch(/\/brokers\?connected=deriv&accounts=2$/);
    expect(tokenBody).toContain('code_verifier=');
    expect(tokenBody).toContain('grant_type=authorization_code');
    const list = (await request(app).get('/api/brokers/connections').set(t.auth)).body.connections;
    expect(list.map((c: { environment: string }) => c.environment).sort()).toEqual(['demo', 'real']);
    expect(list.every((c: { tradingEnabled: boolean }) => c.tradingEnabled === false)).toBe(true);
    expect(JSON.stringify(list)).not.toContain('deriv-access-token-XYZ');
    expect(list[0].accountId).toMatch(/^•+\d{4}$/);
    expect(await BrokerOAuthStateModel.countDocuments()).toBe(0); // single use
    void cookie;
    delete process.env.DERIV_CLIENT_ID;
    delete process.env.DERIV_OAUTH_SCOPES;
    reloadEnv();
  });

  it('WebSocket session: fresh OTP per connect, req_id correlation, allow-list, rate limits, reconnect + resubscribe', async () => {
    let otps = 0;
    setDerivFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: { url: `wss://api.derivws.com/trading/v1/options/ws/demo?otp=OTP${++otps}` } }) }));
    const sockets = fakeDerivSocketServer((m) => {
      if (m.ticks) return { msg_type: 'tick', subscription: { id: 'sub-1' }, tick: { symbol: m.ticks, quote: 1.085, epoch: 1760000000 } };
      if (m.ticks_history) return { error: { code: 'RateLimit', message: 'Rate limit reached' } };
      if (m.ping) return { msg_type: 'ping', ping: 'pong' };
      return { msg_type: Object.keys(m)[0] };
    });
    const { DerivRest } = await import('../src/brokers/deriv/DerivApi');
    const rest = new DerivRest('tok', 'oauth');
    const streamed: Record<string, unknown>[] = [];
    const s = new DerivSocket(() => rest.otpUrl('DOT90001'), (m) => streamed.push(m), () => undefined);
    await s.subscribe('ticks:frxEURUSD', { ticks: 'frxEURUSD' });
    expect(sockets[0].url).toContain('otp=OTP1');
    expect(streamed[0]).toMatchObject({ msg_type: 'tick' });
    await expect(s.request({ cashier: 'withdraw' })).rejects.toThrow(WithdrawalForbiddenError);
    await expect(s.request({ ticks_history: 'frxEURUSD', style: 'candles' })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(s.request({ ping: 1 })).rejects.toMatchObject({ kind: 'rate_limited' }); // cool-down respected
    s.rateLimitedUntil = 0;
    sockets[0].close();
    for (let i = 0; i < 100 && sockets.length < 2; i++) await wait(30);
    for (let i = 0; i < 100 && sockets[1]?.readyState !== 1; i++) await wait(10);
    expect(sockets[1].url).toContain('otp=OTP2'); // new one-time password
    await wait(20);
    expect(sockets[1].sent.some((m) => m.ticks === 'frxEURUSD')).toBe(true); // resubscribed
    s.close();
  }, 15_000);

  it('a demo connection refuses a real-account session', async () => {
    setDerivFetch(async (u) => ({ ok: true, status: 200, json: async () => (u.endsWith('options/accounts') ? { data: [{ account_id: 'DOT1', balance: '1', currency: 'USD', account_type: 'demo' }] } : { data: { url: 'wss://api.derivws.com/trading/v1/options/ws/real?otp=X' } }) }));
    fakeDerivSocketServer(() => ({}));
    const a = new DerivConnectionAdapter({ accountId: 'DOT1', environment: 'demo', token: 't', tokenType: 'oauth' });
    await expect(a.connect()).rejects.toMatchObject({ kind: 'environment_mismatch' });
  });

  it('multiplier lifecycle: proposal → buy → verified contract → settlement with the broker profit; insufficient balance is a clean rejection', async () => {
    const contracts: Record<string, Record<string, unknown>> = {};
    let balance = 1000;
    const rpc = async (m: Record<string, unknown>) => {
      if (m.balance) return { balance: { balance, currency: 'USD', loginid: 'DOT1' } };
      if (m.proposal) return m.amount > balance ? { error: { code: 'InsufficientBalance', message: 'Your account balance is insufficient' } } : { proposal: { id: 'P1', spot: 1.085 } };
      if (m.buy) {
        contracts['77'] = { contract_id: 77, contract_type: 'MULTUP', underlying_symbol: 'frxEURUSD', buy_price: 2, entry_spot: 1.0851, is_sold: 0, profit: 0, purchase_time: Date.now() / 1000 };
        balance -= 2;
        return { buy: { contract_id: 77, buy_price: 2, transaction_id: 501 } };
      }
      if (m.proposal_open_contract) return { proposal_open_contract: contracts[String(m.contract_id)] ?? {} };
      if (m.portfolio) return { portfolio: { contracts: Object.values(contracts).filter((c) => !c.is_sold) } };
      return {};
    };
    const a = new DerivConnectionAdapter({ accountId: 'DOT1', environment: 'demo', token: 't', tokenType: 'oauth' }, rpc);
    const closed: unknown[] = [];
    a.onEvent((e) => e.type === 'position-closed' && closed.push(e.result));
    const r = await a.submitOrder({ clientOrderId: 'c1', brokerSymbol: 'frxEURUSD', side: 'buy', product: 'multiplier', type: 'market', stake: 2, multiplier: 50, stopLossAmount: 1, takeProfitAmount: 3 });
    expect(r).toMatchObject({ status: 'FILLED', brokerPositionId: '77', averagePrice: 1.0851, verified: true, cost: 2 });
    a.handleStream({ msg_type: 'proposal_open_contract', proposal_open_contract: { ...contracts['77'], is_sold: 1, status: 'sold', profit: 0.84, exit_tick: 1.0864, sell_time: 1760000100 } });
    expect(closed[0]).toMatchObject({ brokerPositionId: '77', realizedPnl: 0.84, exitPrice: 1.0864 });
    const rej = await a.submitOrder({ clientOrderId: 'c2', brokerSymbol: 'frxEURUSD', side: 'buy', product: 'multiplier', type: 'market', stake: 5000, multiplier: 50 });
    expect(rej).toMatchObject({ status: 'REJECTED', verified: true });
    await expect(a.cancelOrder()).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(a.submitOrder({ clientOrderId: 'c3', brokerSymbol: 'frxEURUSD', side: 'buy', product: 'multiplier', type: 'limit', stake: 1, multiplier: 50, price: 1 })).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('instruments, candles, statement, Rise/Fall purchase and sell-to-close map the broker responses (close confirmed only from the contract)', async () => {
    const sent: Record<string, unknown>[] = [];
    let sold = false;
    const rpc = async (m: Record<string, unknown>) => {
      sent.push(m);
      if (m.balance) return { balance: { balance: 50, currency: 'USD' } };
      if (m.active_symbols) return { active_symbols: [{ underlying_symbol: 'frxEURUSD', display_name: 'EUR/USD', market: 'forex', pip: 0.00001, exchange_is_open: 1, is_trading_suspended: 0 }, { underlying_symbol: 'R_100', display_name: 'Volatility 100 Index', market: 'synthetic_index', pip: 0.01, exchange_is_open: 1 }] };
      if (m.ticks_history) return { candles: [{ epoch: 1760000000, open: 1.08, high: 1.09, low: 1.07, close: 1.085 }] };
      if (m.statement) return { statement: { transactions: [{ transaction_id: 9, transaction_time: 1760000000, action_type: 'buy', amount: -2, balance_after: 48, contract_id: 55 }] } };
      if (m.proposal) return { proposal: { id: 'PR', spot: 1.085 } };
      if (m.buy) return { buy: { contract_id: 55, buy_price: 2 } };
      if (m.sell) {
        sold = true;
        return { sell: { sold_for: 2.5 } };
      }
      if (m.proposal_open_contract) return { proposal_open_contract: { contract_id: 55, contract_type: 'CALL', underlying_symbol: 'frxEURUSD', buy_price: 2, entry_spot: 1.085, ...(sold ? { is_sold: 1, status: 'sold', profit: 0.5, exit_tick: 1.0861, sell_time: 1760000060 } : { is_sold: 0 }) } };
      return {};
    };
    const a = new DerivConnectionAdapter({ accountId: 'DOT1', environment: 'demo', token: 't', tokenType: 'oauth' }, rpc);
    const inst = await a.getInstruments();
    expect(inst[0]).toMatchObject({ brokerSymbol: 'frxEURUSD', symbol: 'EUR/USD', category: 'forex', tradable: true, marketOpen: true, digits: 5 });
    expect(inst[1]).toMatchObject({ category: 'synthetic' });
    expect(await a.getCandles('frxEURUSD', 60, 10)).toEqual([{ timestamp: 1760000000000, open: 1.08, high: 1.09, low: 1.07, close: 1.085 }]);
    expect((await a.getTransactions(10))[0]).toMatchObject({ id: '9', amount: -2, balanceAfter: 48, brokerPositionId: '55' });
    // Rise/Fall needs a duration and is bought as CALL/PUT, never as a forex market order.
    await expect(a.submitOrder({ clientOrderId: 'rf0', brokerSymbol: 'frxEURUSD', side: 'buy', product: 'rise_fall', type: 'market', stake: 2 })).rejects.toMatchObject({ kind: 'invalid_request' });
    const r = await a.submitOrder({ clientOrderId: 'rf1', brokerSymbol: 'frxEURUSD', side: 'buy', product: 'rise_fall', type: 'market', stake: 2, duration: 5, durationUnit: 'm' });
    expect(r).toMatchObject({ status: 'FILLED', brokerPositionId: '55', verified: true });
    expect(sent.find((m) => m.proposal)).toMatchObject({ contract_type: 'CALL', duration: 5, duration_unit: 'm', basis: 'stake', amount: 2 });
    await expect(a.submitOrder({ clientOrderId: 'cfd', brokerSymbol: 'frxEURUSD', side: 'buy', product: 'cfd', type: 'market', volume: 1 })).rejects.toMatchObject({ kind: 'unsupported' });
    const closed = await a.closePosition('55');
    expect(closed).toMatchObject({ brokerPositionId: '55', closed: true, realizedPnl: 0.5, exitPrice: 1.0861 });
  });

  it('a buy that times out is looked up at Deriv before anything else (never re-bought)', async () => {
    let buys = 0;
    const rpc = async (m: Record<string, unknown>) => {
      if (m.balance) return { balance: { balance: 100, currency: 'USD' } };
      if (m.proposal) return { proposal: { id: 'P1' } };
      if (m.buy) {
        buys++;
        throw new BrokerError('ambiguous', 'timeout');
      }
      if (m.portfolio) return { portfolio: { contracts: [{ contract_id: 88, contract_type: 'MULTDOWN', underlying_symbol: 'frxEURUSD', purchase_time: Date.now() / 1000, buy_price: 1 }] } };
      if (m.proposal_open_contract) return { proposal_open_contract: { contract_id: 88, contract_type: 'MULTDOWN', underlying_symbol: 'frxEURUSD', buy_price: 1, entry_spot: 1.08 } };
      return {};
    };
    const a = new DerivConnectionAdapter({ accountId: 'DOT1', environment: 'demo', token: 't', tokenType: 'oauth' }, rpc);
    await expect(a.submitOrder({ clientOrderId: 'x', brokerSymbol: 'frxEURUSD', side: 'sell', product: 'multiplier', type: 'market', stake: 1, multiplier: 50 })).rejects.toMatchObject({ kind: 'ambiguous' });
    const found = await a.lookupOrder('x', { brokerSymbol: 'frxEURUSD', side: 'sell', since: Date.now() - 1000 });
    expect(found).toMatchObject({ status: 'FILLED', brokerPositionId: '88' });
    expect(buys).toBe(1);
  });
});

// ======================================================================= strategy routing
describe('strategy → broker account routing', () => {
  it('only explicitly assigned, enabled accounts receive signals; real accounts need a LIVE-stage strategy', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await readyMt5(t);
    const other = await readyMt5(await makeUser(app, 'o@x.io', 'trader'));
    await StrategyModel.create({ key: 'momentum', name: 'Momentum', version: '1.0.0', stage: 'PAPER', enabled: true, symbols: ['EUR/USD'], timeframes: ['1h'], params: {} });
    const decision = { strategySignal: { action: 'LONG', confidence: 0.8, price: 1.085, stopLoss: 1.08, reason: 'test', regime: 'TRENDING_UP', indicators: {} } as never, strategyValidation: { valid: true, reasons: [] }, ai: { required: false, status: 'DISABLED' as const, minConfidence: 0.6, requireAgreement: true }, minStrategyConfidence: 0.5 };
    // No assignment → nothing happens.
    expect(await dispatchSignalToAccounts({ strategyKey: 'momentum', symbol: 'EUR/USD', signalId: '000000000000000000000001', decision, direction: 'LONG', stopDistancePct: 0.005 })).toEqual([]);
    expect((await request(app).put('/api/brokers/assignments').set(t.auth).send({ connectionId: c.id, strategyKey: 'momentum', symbolMap: { 'EUR/USD': 'EURUSDm' }, product: 'cfd', enabled: true })).status).toBe(200);
    const p = dispatchSignalToAccounts({ strategyKey: 'momentum', symbol: 'EUR/USD', signalId: '000000000000000000000002', decision, direction: 'LONG', stopDistancePct: 0.005 });
    for (let i = 0; i < 60; i++) {
      await wait(30);
      await serveCommands(c.term, (f) => ({ status: 'filled', retcode: 10009, position: '4242', order: '4242', price: 1.08502, volume: Number(f[6]) }));
    }
    const out = await p;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ connection: c.id, status: 'FILLED' });
    expect(await Mt5CommandModel.countDocuments({ connection: other.id })).toBe(0); // the other user's account was never touched
    expect(await StrategyAccountAssignmentModel.countDocuments()).toBe(1);
  }, 20_000);
});
