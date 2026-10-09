import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { reloadEnv } from '../src/config/env';
import { BrokerConnectionModel } from '../src/models/BrokerConnection';
import { DerivFundingAuthModel, FundingTransactionModel } from '../src/models/DerivFunding';
import { BrokerOAuthStateModel } from '../src/models/BrokerRecords';
import { brokerRegistry } from '../src/brokers/services/BrokerRegistry';
import { DerivConnectionAdapter } from '../src/brokers/deriv/DerivConnectionAdapter';
import { derivMarket } from '../src/brokers/deriv/DerivMarketService';
import { setDerivFundingRpc } from '../src/brokers/deriv/DerivFundingService';
import { assertAllowedDerivRequest, assertAllowedFundingRequest, setDerivFetch } from '../src/brokers/deriv/DerivApi';
import { setBrokerAuthFetch } from '../src/brokers/services/BrokerAuthenticationService';
import { encrypt } from '../src/utils/crypto';
import { WithdrawalForbiddenError } from '../src/utils/errors';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser } from './helpers/api';

const app = createApp();

/** Deriv account mocked at the protocol level: every request the adapter sends is recorded. */
function fakeDeriv() {
  const sent: Record<string, unknown>[] = [];
  const rpc = async (m: Record<string, unknown>) => {
    sent.push(m);
    if (m.balance) return { balance: { balance: 125.5, currency: 'USD', loginid: 'CR900001' } };
    if (m.active_symbols) return { active_symbols: [{ underlying_symbol: 'R_100', display_name: 'Volatility 100 Index', market: 'synthetic_index', market_display_name: 'Derived', submarket_display_name: 'Continuous Indices', pip: 0.01, exchange_is_open: 1, is_trading_suspended: 0 }, { underlying_symbol: 'frxEURUSD', display_name: 'EUR/USD', market: 'forex', market_display_name: 'Forex', submarket: 'major_pairs', pip: 0.00001, exchange_is_open: 0, is_trading_suspended: 0 }] };
    if (m.contracts_for) return { contracts_for: { available: [
      { contract_type: 'MULTUP', contract_category: 'multiplier', contract_category_display: 'Multiply Up/Multiply Down', multiplier_range: [100, 40, 200], min_stake: 1, max_stake: 2000, barrier_category: 'american' },
      { contract_type: 'MULTDOWN', contract_category: 'multiplier', contract_category_display: 'Multiply Up/Multiply Down', multiplier_range: [40, 100, 200], barrier_category: 'american' },
      { contract_type: 'CALL', contract_category: 'callput', contract_category_display: 'Up/Down', barrier_category: 'euro_atm', expiry_type: 'tick', min_contract_duration: '1t', max_contract_duration: '10t' },
      { contract_type: 'PUT', contract_category: 'callput', contract_category_display: 'Up/Down', barrier_category: 'euro_atm', expiry_type: 'intraday', min_contract_duration: '15s', max_contract_duration: '1d' },
      { contract_type: 'ACCU', contract_category: 'accumulator', contract_category_display: 'Accumulator' },
    ] } };
    if (m.ticks_history) return { candles: [{ epoch: 1760000000, open: 100, high: 101, low: 99, close: 100.5 }, { epoch: 1760000060, open: 100.5, high: 102, low: 100, close: 101.2 }] };
    if (m.proposal) return { proposal: { id: 'PQ1', ask_price: m.amount, payout: 1.95 * Number(m.amount), commission: 0.02, spot: 101.2, spot_time: 1760000061, longcode: 'Win payout if Volatility 100 Index is strictly higher…' } };
    if (m.statement) {
      const kind = m.action_type;
      if (kind === 'deposit') return { statement: { transactions: [{ transaction_id: 7001, transaction_time: 1760000000, amount: 50, action_type: 'deposit', longcode: 'Deposit via card' }] } };
      if (kind === 'withdrawal') return { statement: { transactions: [] } };
      return { statement: { transactions: statementTransfers } };
    }
    if (m.profit_table) return { profit_table: { transactions: [{ contract_id: 9, contract_type: 'CALL', buy_price: 10, sell_price: 19.5, purchase_time: 1760000000, sell_time: 1760000060, longcode: 'x' }] } };
    return {};
  };
  return { sent, rpc };
}
let statementTransfers: Record<string, unknown>[] = [];

async function derivConnection(userId: string, environment: 'demo' | 'real' = 'real') {
  return BrokerConnectionModel.create({ user: userId, provider: 'deriv', accountId: environment === 'real' ? 'CR900001' : 'VRTC900001', environment, currency: 'USD', status: 'CONNECTED', tokenType: 'oauth', accessTokenEnc: encrypt('trade-token-SECRET'), label: 'Deriv' });
}
const uid = async (email: string) => (await (await import('../src/models/User')).User.findOne({ email }))!._id.toString();

beforeAll(connectTestDb);
afterAll(async () => {
  brokerRegistry.setFactory('deriv', null);
  setDerivFundingRpc(null);
  setBrokerAuthFetch(null);
  setDerivFetch(null);
  await disconnectTestDb();
});
let fake: ReturnType<typeof fakeDeriv>;
beforeEach(async () => {
  await clearDb();
  await brokerRegistry.dropAll();
  derivMarket.clearCache();
  statementTransfers = [];
  fake = fakeDeriv();
  brokerRegistry.setFactory('deriv', (c) => new DerivConnectionAdapter({ accountId: c.accountId!, environment: c.environment as 'demo' | 'real', token: 't', tokenType: 'oauth' }, fake.rpc));
  setDerivFundingRpc(null);
  for (const k of ['DERIV_FUNDING_ENABLED', 'DERIV_CLIENT_ID']) delete process.env[k];
  reloadEnv();
});

describe('Deriv terminal: market data and quotes (read-only Deriv calls)', () => {
  it('symbols, account-specific offerings, candles and a price quote — and nothing is ever bought', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await derivConnection(await uid('t@x.io'));
    const base = `/api/deriv/accounts/${c._id}`;
    const s = await request(app).get(`${base}/symbols`).set(t.auth);
    expect(s.body.symbols.map((x: { symbol: string }) => x.symbol)).toEqual(['R_100', 'frxEURUSD']);
    expect(s.body.symbols[1]).toMatchObject({ open: false, marketName: 'Forex' });
    const o = (await request(app).get(`${base}/offerings?symbol=R_100`).set(t.auth)).body.offerings;
    expect(o.multiplier).toMatchObject({ available: true, multipliers: [40, 100, 200], minStake: 1, maxStake: 2000 });
    expect(o.riseFall.available).toBe(true);
    expect(o.riseFall.durations).toEqual(expect.arrayContaining([{ unit: 't', min: 1, max: 10 }, { unit: 's-d', min: 15, max: 1 }]));
    expect(o.categories.find((x: { category: string }) => x.category === 'accumulator')).toMatchObject({ supportedInAfeyfx: false });
    const k = await request(app).get(`${base}/candles?symbol=R_100&timeframe=1m&count=2`).set(t.auth);
    expect(k.body).toMatchObject({ granularity: 60, candles: [{ timestamp: 1760000000000, open: 100, close: 100.5 }, { close: 101.2 }] });
    expect((await request(app).get(`${base}/candles?symbol=R_100&timeframe=7m`).set(t.auth)).status).toBe(400);
    const q = await request(app).post(`${base}/quote`).set(t.auth).send({ symbol: 'R_100', product: 'rise_fall', side: 'buy', stake: 10, duration: 5, durationUnit: 't' });
    expect(q.body.quote).toMatchObject({ id: 'PQ1', contractType: 'CALL', askPrice: 10, payout: 19.5, spot: 101.2 });
    expect(fake.sent.find((m) => m.proposal)).toMatchObject({ contract_type: 'CALL', duration: 5, duration_unit: 't', basis: 'stake' });
    expect(fake.sent.some((m) => 'buy' in m || 'sell' in m)).toBe(false);
    const pt = await request(app).get(`${base}/profit-table`).set(t.auth);
    expect(pt.body.contracts[0]).toMatchObject({ contractId: '9', profit: 9.5 });
  });

  it("another user's account is invisible; the engine account can be selected", async () => {
    const a = await makeUser(app, 'a@x.io', 'trader');
    const b = await makeUser(app, 'b@x.io', 'trader');
    const ca = await derivConnection(await uid('a@x.io'));
    expect((await request(app).get(`/api/deriv/accounts/${ca._id}/symbols`).set(b.auth)).status).toBe(404);
    const demo = await derivConnection(await uid('a@x.io'), 'demo');
    const st = await request(app).post('/api/deriv/engine-account').set(a.auth).send({ connectionId: demo._id.toString() });
    expect(st.status).toBe(200);
    expect((await request(app).get('/api/deriv/status').set(a.auth)).body.engineAccount).toBe(demo._id.toString());
    expect(JSON.stringify((await request(app).get('/api/deriv/status').set(a.auth)).body)).not.toContain('trade-token-SECRET');
  });
});

describe('Deriv funding (separate opt-in payments authorization)', () => {
  it('trading sockets can never send payment calls; funding sockets cannot withdraw or use payment agents', () => {
    expect(() => assertAllowedDerivRequest({ transfer_between_accounts: 1 })).toThrow(WithdrawalForbiddenError);
    expect(() => assertAllowedDerivRequest({ cashier: 'deposit' })).toThrow(WithdrawalForbiddenError);
    expect(() => assertAllowedFundingRequest({ cashier: 'withdraw', type: 'url' })).toThrow(/Deriv's own cashier/);
    expect(() => assertAllowedFundingRequest({ paymentagent_withdraw: 1 })).toThrow(WithdrawalForbiddenError);
    expect(() => assertAllowedFundingRequest({ cashier: 'deposit', type: 'api', address: 'x' })).toThrow(WithdrawalForbiddenError);
    expect(() => assertAllowedFundingRequest({ buy: 'P1' })).toThrow(WithdrawalForbiddenError);
    expect(() => assertAllowedFundingRequest({ transfer_between_accounts: 1, account_from: 'A', account_to: 'B', amount: 1, currency: 'USD' })).not.toThrow();
  });

  it('is off by default; when enabled it uses its own OAuth (payments scope) and never touches trading tokens', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    process.env.DERIV_CLIENT_ID = 'client-123';
    reloadEnv();
    expect((await request(app).post('/api/deriv/funding/authorize').set(t.auth)).body.error.code).toBe('FUNDING_DISABLED');
    process.env.DERIV_FUNDING_ENABLED = 'true';
    reloadEnv();
    const c = await derivConnection(await uid('t@x.io'));
    const start = await request(app).post('/api/deriv/funding/authorize').set(t.auth);
    const url = new URL(start.body.authorizeUrl);
    expect(url.searchParams.get('scope')).toBe('payments');
    expect((await BrokerOAuthStateModel.findOne())!.purpose).toBe('funding');
    setBrokerAuthFetch(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'FUNDING-TOKEN-ABC', expires_in: 3600, scope: 'payments' }) }));
    const cb = await request(app).get(`/api/brokers/deriv/callback?code=abc&state=${url.searchParams.get('state')}`).set('Cookie', String(start.headers['set-cookie']).split(';')[0]);
    expect(cb.headers.location).toMatch(/\/deriv\/funding\?funding=authorized$/);
    const auth = (await DerivFundingAuthModel.findOne())!;
    expect(auth.accessTokenEnc).not.toContain('FUNDING-TOKEN-ABC');
    const conn = (await BrokerConnectionModel.findById(c._id))!;
    expect(conn.accessTokenEnc).toBe(c.accessTokenEnc); // trading token untouched
    const st = (await request(app).get('/api/deriv/funding/status').set(t.auth)).body;
    expect(st).toMatchObject({ enabled: true, authorized: true, scopes: ['payments'] });
    expect(JSON.stringify(st)).not.toContain('FUNDING-TOKEN');
    // A trading authorization that comes back with a payment scope is still refused.
    const t2 = await request(app).post('/api/brokers/deriv/connect').set(t.auth).send({ method: 'oauth' });
    setBrokerAuthFetch(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'X', scope: 'trade payments' }) }));
    const bad = await request(app).get(`/api/brokers/deriv/callback?code=abc&state=${new URL(t2.body.authorizeUrl).searchParams.get('state')}`).set('Cookie', String(t2.headers['set-cookie']).split(';')[0]);
    expect(bad.headers.location).toMatch(/#error=DERIV_SCOPE/);
  });

  it('transfers between own accounts need 2FA, are idempotent, and complete only when the statement shows them', async () => {
    process.env.DERIV_FUNDING_ENABLED = 'true';
    reloadEnv();
    const t = await makeUser(app, 't@x.io', 'trader', true);
    const userId = await uid('t@x.io');
    const c = await derivConnection(userId);
    await DerivFundingAuthModel.create({ user: userId, accessTokenEnc: encrypt('F'), scopes: ['payments'] });
    const calls: Record<string, unknown>[] = [];
    let refuse = false;
    setDerivFundingRpc(async (accountId, m) => {
      calls.push({ accountId, ...m });
      if (m.transfer_between_accounts && !m.account_to) return { accounts: [{ loginid: 'CR900001', account_category: 'trading', currency: 'USD', balance: '125.50', transfers: 'all' }, { loginid: 'CRW1000', account_category: 'wallet', currency: 'USD', balance: '40.00', transfers: 'all' }, { loginid: 'MTR77', account_category: 'trading', account_type: 'mt5', currency: 'USD', balance: '0', transfers: 'none' }] };
      if (m.transfer_between_accounts) {
        if (refuse) return { error: { code: 'TransferBetweenAccountsError', message: 'Transfers are not available for your account' } };
        statementTransfers = [{ transaction_id: 88001, transaction_time: Math.floor(Date.now() / 1000), amount: -25, action_type: 'transfer', longcode: 'Account transfer to CRW1000' }];
        return { transfer_between_accounts: 1, transaction_id: 88001, accounts: [] };
      }
      return {};
    });
    const base = `/api/deriv/accounts/${c._id}/funding`;
    const accts = (await request(app).get(`${base}/accounts`).set(t.auth)).body.accounts;
    expect(accts.map((a: { loginid: string }) => a.loginid)).toEqual(['CR900001', 'CRW1000', 'MTR77']);
    expect(accts[1]).toMatchObject({ category: 'wallet', balance: 40 });
    const body = { to: 'CRW1000', amount: 25, currency: 'USD', idempotencyKey: 'transfer-0001' };
    expect((await request(app).post(`${base}/transfer`).set(t.auth).send(body)).status).toBe(401); // no fresh 2FA code
    const ok = await request(app).post(`${base}/transfer`).set(t.auth).send({ ...body, totp: t.code() });
    expect(ok.status).toBe(201);
    expect(ok.body.transaction).toMatchObject({ status: 'COMPLETED', reference: '88001', type: 'TRANSFER_OUT', amount: 25 });
    expect(calls.find((x) => x.account_to)).toMatchObject({ accountId: 'CR900001', account_from: 'CR900001', account_to: 'CRW1000', amount: 25 });
    await new Promise((r) => setTimeout(r, 1100));
    const dup = await request(app).post(`${base}/transfer`).set(t.auth).send({ ...body, totp: t.code() });
    expect(dup.body.duplicate).toBe(true);
    expect(calls.filter((x) => x.account_to).length).toBe(1); // never sent twice
    // Accounts Deriv says cannot receive transfers are refused before anything is sent.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await request(app).post(`${base}/transfer`).set(t.auth).send({ ...body, to: 'MTR77', idempotencyKey: 'transfer-0002', totp: t.code() })).body.error.code).toBe('TRANSFER_NOT_ALLOWED');
    // A refusal from Deriv is recorded as FAILED with Deriv's message.
    refuse = true;
    await new Promise((r) => setTimeout(r, 1100));
    const fail = await request(app).post(`${base}/transfer`).set(t.auth).send({ ...body, idempotencyKey: 'transfer-0003', totp: t.code() });
    expect(fail.status).toBe(422);
    expect(fail.body.transaction).toMatchObject({ status: 'FAILED', message: 'Transfers are not available for your account' });
  }, 20_000);

  it('deposit opens Deriv’s own cashier; withdrawals are always on Deriv’s site; history comes from the statement', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const userId = await uid('t@x.io');
    const real = await derivConnection(userId);
    const demo = await derivConnection(userId, 'demo');
    // Funding not authorized → official cashier page.
    const d1 = await request(app).get(`/api/deriv/accounts/${real._id}/funding/deposit-link`).set(t.auth);
    expect(d1.body).toEqual({ url: 'https://app.deriv.com/cashier/deposit', source: 'official-page' });
    expect((await request(app).get(`/api/deriv/accounts/${demo._id}/funding/deposit-link`).set(t.auth)).body.error.code).toBe('DEMO_ACCOUNT');
    process.env.DERIV_FUNDING_ENABLED = 'true';
    reloadEnv();
    await DerivFundingAuthModel.create({ user: userId, accessTokenEnc: encrypt('F'), scopes: ['payments'] });
    setDerivFundingRpc(async (_a, m) => (m.cashier === 'deposit' ? { cashier: 'https://cashier.deriv.com/handshake?token=abc' } : {}));
    const d2 = await request(app).get(`/api/deriv/accounts/${real._id}/funding/deposit-link`).set(t.auth);
    expect(d2.body).toEqual({ url: 'https://cashier.deriv.com/handshake?token=abc', source: 'deriv-cashier' });
    const w = await request(app).get('/api/deriv/funding/withdraw-link').set(t.auth);
    expect(w.body).toMatchObject({ url: 'https://app.deriv.com/cashier/withdrawal', source: 'official-page' });
    statementTransfers = [{ transaction_id: 5501, transaction_time: 1760000100, amount: 10, action_type: 'transfer', longcode: 'Transfer from CRW1000' }];
    const s = await request(app).post(`/api/deriv/accounts/${real._id}/funding/sync`).set(t.auth);
    expect(s.body.added).toBe(2);
    expect((await request(app).post(`/api/deriv/accounts/${real._id}/funding/sync`).set(t.auth)).body.added).toBe(0); // idempotent
    const h = (await request(app).get('/api/deriv/funding/history').set(t.auth)).body.transactions;
    expect(h.map((x: { type: string; status: string; reference: string }) => `${x.type}:${x.status}:${x.reference}`).sort()).toEqual(['DEPOSIT:COMPLETED:7001', 'TRANSFER_IN:COMPLETED:5501']);
    expect(await FundingTransactionModel.countDocuments({ source: 'statement' })).toBe(2);
  });
});
