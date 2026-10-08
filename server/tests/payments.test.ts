import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Types } from 'mongoose';
import '../src/models';
import { createApp, redactCallbackToken } from '../src/app';
import { paymentService } from '../src/payments/PaymentService';
import { DarajaClient, MpesaError, clearMpesaTokenCache, darajaTimestamp, normalizeKenyanPhone, setMpesaFetch } from '../src/payments/MpesaClient';
import { PaymentConfigModel } from '../src/models/PaymentConfig';
import { PaymentModel } from '../src/models/PaymentTransaction';
import { PortfolioModel } from '../src/models/Portfolio';
import { EmailTokenModel } from '../src/models/EmailToken';
import { User } from '../src/models/User';
import { mailService, type MailMessage } from '../src/services/MailService';
import { marketDataCache } from '../src/marketData/MarketDataCache';
import { orderExecutionService } from '../src/execution/OrderExecutionService';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { decrypt } from '../src/utils/crypto';
import { reloadEnv } from '../src/config/env';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser } from './helpers/api';

const app = createApp();
const PHONE = '254712345678';
const outbox: MailMessage[] = [];

/** Mock M-Pesa provider: records calls; tests decide the answers. */
const provider = {
  stkPush: vi.fn(async () => ({ merchantRequestId: 'm-1', checkoutRequestId: `ws_CO_${Math.random().toString(36).slice(2)}` })),
  stkQuery: vi.fn(async () => ({ state: 'SUCCESS' as 'SUCCESS' | 'FAILED' | 'PENDING', resultCode: '0', resultDesc: 'ok' })),
  b2c: vi.fn(async (i: { originatorConversationId: string }) => ({ conversationId: 'AG_1', originatorConversationId: i.originatorConversationId })),
};

const setBook = (bid: number, ask: number) => {
  marketDataCache.setTicker('binance', { symbol: 'BTC/USDT', timestamp: Date.now(), last: (bid + ask) / 2, bid, ask });
  marketDataCache.setOrderBook('binance', { symbol: 'BTC/USDT', timestamp: Date.now(), bids: [{ price: bid, amount: 100 }], asks: [{ price: ask, amount: 100 }] });
};

async function enable(extra: Record<string, unknown> = {}) {
  await PaymentConfigModel.deleteMany({});
  await paymentService.config();
  await PaymentConfigModel.updateOne({ key: 'mpesa' }, { $set: { environment: 'simulated', depositsEnabled: true, payoutsEnabled: true, depositRate: 130, payoutRate: 127, payoutFeePct: 0.02, payoutFeeFixedCents: 0, ...extra } });
}
const token = async () => (await paymentService.config()).callbackToken!;
const stkOk = (checkoutRequestId: string, amount: number, receipt = 'QKX1234567') => ({ Body: { stkCallback: { MerchantRequestID: 'm-1', CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: 'ok', CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'PhoneNumber', Value: Number(PHONE) }] } } } });
const realBalance = async (userId: string) => (await PortfolioModel.findOne({ mode: 'REAL', owner: userId }))?.balance ?? 0;
const idOf = async (auth: Record<string, string>) => (await request(app).get('/api/auth/me').set(auth)).body.user._id as string;
const emailCode = async (auth: Record<string, string>) => {
  await EmailTokenModel.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 60_000) } });
  await request(app).post('/api/auth/2fa/email/send').set(auth).send({ context: 'Withdrawal' });
  return outbox.filter((m) => /code/i.test(m.subject)).at(-1)!.text.match(/\b(\d{6})\b/)![1];
};

async function deposited(auth: Record<string, string>, amount = 100) {
  const r = await request(app).post('/api/payments/deposits').set(auth).send({ amount, phone: '0712 345 678', idempotencyKey: `dep-${Math.random()}` });
  expect(r.status).toBe(201);
  const t = (await PaymentModel.findById(r.body.payment.id))!;
  const cb = await request(app).post(`/api/payments/mpesa/stk/${await token()}`).send(stkOk(t.checkoutRequestId!, t.amountKes, `R${Math.random().toString(36).slice(2, 10).toUpperCase()}`));
  expect(cb.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
  return (await PaymentModel.findById(t._id))!;
}

beforeAll(async () => {
  await connectTestDb();
  mailService.setSender(async (m) => void outbox.push(m));
  orderExecutionService.paperBroker.cfg = { ...orderExecutionService.paperBroker.cfg, latencyMs: 0, rejectRate: 0, slippagePct: 0 };
});
afterAll(async () => {
  mailService.setSender(null);
  paymentService.setProvider(null);
  setMpesaFetch(null);
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearDb();
  outbox.length = 0;
  marketDataCache.clear();
  tradingState.reset();
  circuitBreaker.resetAll();
  vi.clearAllMocks();
  paymentService.setProvider(provider);
});

describe('M-Pesa Daraja client', () => {
  it('normalises Kenyan numbers and rejects others', () => {
    expect(normalizeKenyanPhone('0712 345 678')).toBe('254712345678');
    expect(normalizeKenyanPhone('+254 112 345 678')).toBe('254112345678');
    expect(normalizeKenyanPhone('712345678')).toBe('254712345678');
    expect(normalizeKenyanPhone('254712345678')).toBe('254712345678');
    expect(normalizeKenyanPhone('0812345678')).toBeNull();
    expect(normalizeKenyanPhone('+1 555 123 4567')).toBeNull();
  });

  it('timestamps are East Africa Time', () => {
    expect(darajaTimestamp(new Date('2026-01-31T22:30:15Z'))).toBe('20260201013015');
  });

  it('sends correctly formed OAuth, STK Push, STK Query and B2C requests, caching the token', async () => {
    clearMpesaTokenCache();
    const calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
    setMpesaFetch(async (url, init = {}) => {
      calls.push({ url, init });
      const ok = (j: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
      if (url.includes('/oauth/')) return ok({ access_token: 'tok', expires_in: '3599' });
      if (url.includes('stkpushquery')) return ok({ ResponseCode: '0', ResultCode: '1032', ResultDesc: 'Request cancelled by user' });
      if (url.includes('stkpush')) return ok({ MerchantRequestID: 'M1', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0', CustomerMessage: 'Success' });
      return ok({ ConversationID: 'AG_1', OriginatorConversationID: 'O1', ResponseCode: '0' });
    });
    const c = new DarajaClient({ environment: 'sandbox', consumerKey: 'ck', consumerSecret: 'cs', shortcode: '174379', passkey: 'pk', b2cShortcode: '600000', initiatorName: 'api', securityCredential: 'SC' });
    expect(await c.stkPush({ amountKes: 1300, phone: PHONE, reference: '123', callbackUrl: 'https://x/cb' })).toMatchObject({ checkoutRequestId: 'ws_CO_1' });
    expect(await c.stkQuery('ws_CO_1')).toMatchObject({ state: 'FAILED', resultCode: '1032' });
    await c.b2c({ amountKes: 1000, phone: PHONE, originatorConversationId: 'O1', resultUrl: 'https://x/r', timeoutUrl: 'https://x/t', remarks: 'Withdrawal' });
    expect(calls.filter((x) => x.url.includes('/oauth/'))).toHaveLength(1); // token cached
    expect(calls[0].url).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    expect(calls[0].init.headers!.Authorization).toBe(`Basic ${Buffer.from('ck:cs').toString('base64')}`);
    const stk = JSON.parse(calls[1].init.body!);
    expect(stk).toMatchObject({ BusinessShortCode: '174379', TransactionType: 'CustomerPayBillOnline', Amount: 1300, PartyA: PHONE, PartyB: '174379', PhoneNumber: PHONE, CallBackURL: 'https://x/cb' });
    expect(Buffer.from(stk.Password, 'base64').toString()).toBe(`174379pk${stk.Timestamp}`);
    expect(calls[1].init.headers!.Authorization).toBe('Bearer tok');
    const b2c = JSON.parse(calls[3].init.body!);
    expect(calls[3].url).toContain('/mpesa/b2c/v3/paymentrequest');
    expect(b2c).toMatchObject({ OriginatorConversationID: 'O1', InitiatorName: 'api', SecurityCredential: 'SC', CommandID: 'BusinessPayment', Amount: 1000, PartyA: '600000', PartyB: PHONE, ResultURL: 'https://x/r', QueueTimeOutURL: 'https://x/t' });
    setMpesaFetch(null);
  });

  it('classifies refusals as definite and network errors / 5xx as ambiguous; "being processed" is pending', async () => {
    clearMpesaTokenCache();
    const c = new DarajaClient({ environment: 'production', consumerKey: 'a', consumerSecret: 'b', shortcode: '1', passkey: 'p', b2cShortcode: '2', initiatorName: 'i', securityCredential: 's' });
    let mode = 'refuse';
    setMpesaFetch(async (url) => {
      if (url.includes('/oauth/')) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 3599 }) };
      if (mode === 'network') throw new Error('ECONNRESET');
      if (mode === 'pending') return { ok: false, status: 500, text: async () => JSON.stringify({ errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }) };
      if (mode === '5xx') return { ok: false, status: 503, text: async () => 'Service unavailable' };
      return { ok: false, status: 400, text: async () => JSON.stringify({ errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PhoneNumber' }) };
    });
    const b2c = () => c.b2c({ amountKes: 100, phone: PHONE, originatorConversationId: 'x', resultUrl: 'u', timeoutUrl: 'u', remarks: 'r' });
    await expect(b2c()).rejects.toMatchObject({ definite: true });
    mode = 'network';
    await expect(b2c()).rejects.toMatchObject({ definite: false });
    mode = '5xx';
    await expect(b2c()).rejects.toMatchObject({ definite: false });
    mode = 'pending';
    expect((await c.stkQuery('ws')).state).toBe('PENDING');
    setMpesaFetch(null);
    expect(new MpesaError('x', true)).toBeInstanceOf(Error);
  });
});

describe('payment configuration (admin)', () => {
  it('everything is off by default; traders cannot deposit, withdraw or reach the admin console', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const cfg = (await request(app).get('/api/payments/config').set(t.auth)).body;
    expect(cfg.deposits.enabled).toBe(false);
    expect(cfg.payouts.enabled).toBe(false);
    expect(cfg.realTradingEnabled).toBe(false);
    expect((await request(app).post('/api/payments/deposits').set(t.auth).send({ amount: 20, phone: PHONE, idempotencyKey: 'abcdefgh' })).body.error.code).toBe('DEPOSITS_DISABLED');
    expect((await request(app).get('/api/admin/payments').set(t.auth)).status).toBe(403);
    expect((await request(app).get('/api/admin/payments/config').set(t.auth)).status).toBe(403);
  });

  it('saving credentials is a protected action; secrets are encrypted at rest and never returned', async () => {
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const body = { environment: 'sandbox', consumerKey: 'CONSUMERKEY1234', consumerSecret: 'SECRET-abc', passkey: 'PASSKEY-xyz', shortcode: '174379', b2cShortcode: '600000', initiatorName: 'testapi', securityCredential: 'ENCRYPTED-CRED', depositsEnabled: true, payoutsEnabled: true };
    expect((await request(app).put('/api/admin/payments/config').set(a.auth).send(body)).status).toBe(401); // no 2FA code
    const r = await request(app).put('/api/admin/payments/config').set(a.auth).send({ ...body, totp: a.code() });
    expect(r.status).toBe(200);
    const json = JSON.stringify(r.body);
    for (const s of ['SECRET-abc', 'PASSKEY-xyz', 'ENCRYPTED-CRED', 'CONSUMERKEY1234']) expect(json).not.toContain(s);
    expect(r.body.secrets).toEqual({ consumerKey: '***********1234', consumerSecret: true, passkey: true, securityCredential: true });
    expect(r.body.callbackUrls.stk).toMatch(/\/api\/payments\/mpesa\/stk\/[\w-]{20,}$/);
    const doc = (await PaymentConfigModel.findOne({ key: 'mpesa' }))!;
    expect(doc.passkeyEnc).not.toContain('PASSKEY');
    expect(decrypt(doc.passkeyEnc!)).toBe('PASSKEY-xyz');
    // Omitting a secret keeps it; enabling without credentials is refused.
    expect((await request(app).put('/api/admin/payments/config').set(a.auth).send({ depositRate: 131, totp: a.code() })).body.secrets.passkey).toBe(true);
    const cleared = await request(app).put('/api/admin/payments/config').set(a.auth).send({ clearSecrets: ['passkey'], totp: a.code() });
    expect(cleared.status).toBe(400);
    // Invalid limits are rejected
    expect((await request(app).put('/api/admin/payments/config').set(a.auth).send({ minDepositUsd: 500, maxDepositUsd: 100, totp: a.code() })).status).toBe(400);
  });

  it('the simulated provider is refused in production', async () => {
    const prev = { ...process.env };
    Object.assign(process.env, { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), JWT_REFRESH_SECRET: 'y'.repeat(40), ENCRYPTION_KEY: 'a'.repeat(64) });
    reloadEnv();
    try {
      await enable();
      const c = await paymentService.config();
      expect(paymentService.depositsConfigured(c)).toBe(false);
      await expect(paymentService.updateConfig({ environment: 'simulated' }, '000000000000000000000000')).rejects.toThrow(/production/);
    } finally {
      process.env = prev;
      reloadEnv();
    }
  });

  it('logs never contain the callback token', () => {
    expect(redactCallbackToken('/api/payments/mpesa/stk/SECRET123?x=1')).toBe('/api/payments/mpesa/stk/[REDACTED]?x=1');
    expect(redactCallbackToken('/api/payments/mpesa/b2c/result/SECRET123')).toBe('/api/payments/mpesa/b2c/result/[REDACTED]');
  });
});

describe('M-Pesa deposits', () => {
  it('STK push -> confirmed callback -> credited exactly once to the REAL account (demo untouched)', async () => {
    await enable();
    const t = await makeUser(app, 't@x.io', 'trader');
    const r = await request(app).post('/api/payments/deposits').set(t.auth).send({ amount: 50, phone: '0712345678', idempotencyKey: 'dep-00001' });
    expect(r.status).toBe(201);
    expect(r.body.payment).toMatchObject({ type: 'DEPOSIT', status: 'PENDING', amount: 50, amountKes: 6500, phone: '25471****678' });
    expect(provider.stkPush).toHaveBeenCalledWith(expect.objectContaining({ amountKes: 6500, phone: PHONE, callbackUrl: expect.stringContaining('/api/payments/mpesa/stk/') }));
    // Same idempotency key -> same transaction, no second prompt
    expect((await request(app).post('/api/payments/deposits').set(t.auth).send({ amount: 50, phone: '0712345678', idempotencyKey: 'dep-00001' })).body.payment.id).toBe(r.body.payment.id);
    expect(provider.stkPush).toHaveBeenCalledTimes(1);

    const doc = (await PaymentModel.findById(r.body.payment.id))!;
    // Wrong token -> rejected, nothing credited
    expect((await request(app).post('/api/payments/mpesa/stk/wrong-token').send(stkOk(doc.checkoutRequestId!, 6500))).status).toBe(403);
    expect(await realBalance(await idOf(t.auth))).toBe(0);

    const cb = await request(app).post(`/api/payments/mpesa/stk/${await token()}`).send(stkOk(doc.checkoutRequestId!, 6500));
    expect(cb.status).toBe(200);
    expect(provider.stkQuery).toHaveBeenCalledWith(doc.checkoutRequestId); // callback confirmed with M-Pesa
    const done = (await PaymentModel.findById(doc._id))!;
    expect(done.status).toBe('COMPLETED');
    expect(done.receipt).toBe('QKX1234567');
    const uid = await idOf(t.auth);
    expect(await realBalance(uid)).toBe(50);
    // Duplicate callback (Daraja retries) -> still credited once
    await request(app).post(`/api/payments/mpesa/stk/${await token()}`).send(stkOk(doc.checkoutRequestId!, 6500));
    await paymentService.reconcilePending();
    expect(await realBalance(uid)).toBe(50);
    const acc = (await request(app).get('/api/account?account=REAL').set(t.auth)).body;
    expect(acc.account).toMatchObject({ type: 'REAL', balance: 50, totalPnl: 0 }); // deposits are not P&L
    expect(acc.accounts.DEMO.balance).toBe(10_000);
    expect(outbox.some((m) => /Deposit received/.test(m.subject))).toBe(true);
  });

  it('cancelled, mismatched and contradicted callbacks never credit', async () => {
    await enable();
    const t = await makeUser(app, 't@x.io', 'trader');
    const uid = await idOf(t.auth);
    const mk = async (k: string) => (await PaymentModel.findById((await request(app).post('/api/payments/deposits').set(t.auth).send({ amount: 20, phone: PHONE, idempotencyKey: k })).body.payment.id))!;
    const tok = await token();

    const a = await mk('cancel-001');
    await request(app).post(`/api/payments/mpesa/stk/${tok}`).send({ Body: { stkCallback: { CheckoutRequestID: a.checkoutRequestId, ResultCode: 1032, ResultDesc: 'Request cancelled by user' } } });
    const av = (await request(app).get(`/api/payments/${a._id}`).set(t.auth)).body.payment;
    expect(av).toMatchObject({ status: 'FAILED', message: 'Cancelled on the phone' });

    const b = await mk('mismatch-1');
    await request(app).post(`/api/payments/mpesa/stk/${tok}`).send(stkOk(b.checkoutRequestId!, 1, 'RMISMATCH1'));
    expect((await PaymentModel.findById(b._id))!.status).toBe('UNCERTAIN');

    const c = await mk('contra-001');
    provider.stkQuery.mockResolvedValueOnce({ state: 'FAILED', resultCode: '1037', resultDesc: 'timeout' });
    await request(app).post(`/api/payments/mpesa/stk/${tok}`).send(stkOk(c.checkoutRequestId!, c.amountKes, 'RCONTRA01'));
    expect((await PaymentModel.findById(c._id))!.status).toBe('UNCERTAIN');

    expect(await realBalance(uid)).toBe(0);
    // Unknown request ids are ignored
    expect((await request(app).post(`/api/payments/mpesa/stk/${tok}`).send(stkOk('ws_CO_unknown', 100))).status).toBe(200);
    expect(await realBalance(uid)).toBe(0);
  });

  it('a lost callback is recovered by the reconcile job (STK Push Query)', async () => {
    await enable();
    const t = await makeUser(app, 't@x.io', 'trader');
    const r = await request(app).post('/api/payments/deposits').set(t.auth).send({ amount: 25, phone: PHONE, idempotencyKey: 'lost-0001' });
    await PaymentModel.collection.updateOne({ _id: new Types.ObjectId(r.body.payment.id as string) }, { $set: { createdAt: new Date(Date.now() - 120_000) } });
    provider.stkQuery.mockResolvedValueOnce({ state: 'PENDING', resultCode: '', resultDesc: '' });
    await paymentService.reconcilePending();
    expect((await PaymentModel.findById(r.body.payment.id))!.status).toBe('PENDING');
    await PaymentModel.updateOne({ _id: r.body.payment.id }, { $set: { lastQueriedAt: new Date(Date.now() - 120_000) } });
    await paymentService.reconcilePending();
    expect((await PaymentModel.findById(r.body.payment.id))!.status).toBe('COMPLETED');
    expect(await realBalance(await idOf(t.auth))).toBe(25);
  });

  it('enforces limits, phone format and the pending-deposit cap', async () => {
    await enable();
    const t = await makeUser(app, 't@x.io', 'trader');
    const send = (amount: number, phone = PHONE, k = `k-${Math.random()}`) => request(app).post('/api/payments/deposits').set(t.auth).send({ amount, phone, idempotencyKey: k });
    expect((await send(5)).body.error.code).toBe('AMOUNT_OUT_OF_RANGE');
    expect((await send(5000)).body.error.code).toBe('AMOUNT_OUT_OF_RANGE');
    expect((await send(10.555)).status).toBe(400);
    expect((await send(20, '0812345678')).body.error.code).toBe('INVALID_PHONE');
    for (let i = 0; i < 3; i++) expect((await send(20)).status).toBe(201);
    expect((await send(20)).body.error.code).toBe('TOO_MANY_PENDING');
    const v = await makeUser(app, 'unverified@x.io', 'trader', false, false);
    expect((await request(app).post('/api/payments/deposits').set(v.auth).send({ amount: 20, phone: PHONE, idempotencyKey: 'abcdefgh' })).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    // Verified after the token was issued: the stale token is re-checked against the database.
    await User.updateOne({ email: 'unverified@x.io' }, { $set: { emailVerified: true } });
    expect((await request(app).post('/api/payments/deposits').set(v.auth).send({ amount: 20, phone: PHONE, idempotencyKey: 'abcdefgh' })).status).toBe(201);
  });

  it('an STK push with no definite answer is held for review, never silently failed or credited', async () => {
    await enable();
    const t = await makeUser(app, 't@x.io', 'trader');
    provider.stkPush.mockRejectedValueOnce(new MpesaError('timeout', false));
    const r = await request(app).post('/api/payments/deposits').set(t.auth).send({ amount: 20, phone: PHONE, idempotencyKey: 'amb-0001' });
    expect(r.body.payment.status).toBe('UNCERTAIN');
    provider.stkPush.mockRejectedValueOnce(new MpesaError('Invalid PhoneNumber', true));
    expect((await request(app).post('/api/payments/deposits').set(t.auth).send({ amount: 20, phone: PHONE, idempotencyKey: 'def-0001' })).body.payment.status).toBe('FAILED');
  });
});

describe('M-Pesa withdrawals', () => {
  it('requires a confirmation code, holds the funds, and pays out only after admin approval (with 2FA)', async () => {
    await enable();
    const t = await makeUser(app, 't@x.io', 'trader');
    const uid = await idOf(t.auth);
    await deposited(t.auth, 100);
    const body = { amount: 40, phone: '0712345678', firstName: 'Amina', lastName: 'Otieno', idempotencyKey: 'pay-00001' };
    expect((await request(app).post('/api/payments/payouts').set(t.auth).send(body)).status).toBe(401); // no code
    const r = await request(app).post('/api/payments/payouts').set(t.auth).send({ ...body, emailCode: await emailCode(t.auth) });
    expect(r.body.error ?? r.status).toBe(201);
    expect(r.body.payment).toMatchObject({ type: 'PAYOUT', status: 'PENDING', amount: 40, fee: 0.8, net: 39.2, amountKes: Math.floor(3920 * 127 / 100) });
    expect(await realBalance(uid)).toBe(60); // held
    expect(provider.b2c).not.toHaveBeenCalled(); // waits for review

    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const list = (await request(app).get('/api/admin/payments?type=PAYOUT&status=PENDING').set(a.auth)).body.payments;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ userEmail: 't@x.io', phone: PHONE, knownDestination: true });
    expect((await request(app).post(`/api/admin/payments/${list[0].id}/approve`).set(a.auth).send({})).status).toBe(401);
    const ap = await request(app).post(`/api/admin/payments/${list[0].id}/approve`).set(a.auth).send({ totp: a.code() });
    expect(ap.status).toBe(200);
    expect(ap.body.payment.status).toBe('PROCESSING');
    expect(provider.b2c).toHaveBeenCalledWith(expect.objectContaining({ amountKes: r.body.payment.amountKes, phone: PHONE }));
    // Approving twice does not send twice
    expect((await request(app).post(`/api/admin/payments/${list[0].id}/approve`).set(a.auth).send({ totp: a.code() })).status).toBe(409);
    expect(provider.b2c).toHaveBeenCalledTimes(1);

    const oc = (await PaymentModel.findById(list[0].id))!.originatorConversationId;
    await request(app).post(`/api/payments/mpesa/b2c/result/${await token()}`).send({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: oc, ConversationID: 'AG_1', TransactionID: 'QWE1234567' } });
    const done = (await request(app).get(`/api/payments/${list[0].id}`).set(t.auth)).body.payment;
    expect(done).toMatchObject({ status: 'COMPLETED', receipt: 'QWE1234567' });
    expect(await realBalance(uid)).toBe(60);
    const hist = (await request(app).get('/api/payments').set(t.auth)).body.payments;
    expect(hist.map((p: { type: string }) => p.type)).toEqual(['PAYOUT', 'DEPOSIT']);
  });

  it('a failed payout is refunded exactly once; a timeout is NOT refunded until an admin resolves it', async () => {
    await enable();
    const t = await makeUser(app, 't@x.io', 'trader');
    const uid = await idOf(t.auth);
    await deposited(t.auth, 100);
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const payout = async (k: string) => {
      const r = await request(app).post('/api/payments/payouts').set(t.auth).send({ amount: 30, phone: PHONE, firstName: 'A', lastName: 'B', idempotencyKey: k, emailCode: await emailCode(t.auth) });
      expect(r.status).toBe(201);
      await request(app).post(`/api/admin/payments/${r.body.payment.id}/approve`).set(a.auth).send({ totp: a.code() });
      return (await PaymentModel.findById(r.body.payment.id))!;
    };
    const tok = await token();
    const f = await payout('fail-0001');
    expect(await realBalance(uid)).toBe(70);
    const fail = { Result: { ResultType: 0, ResultCode: 2001, ResultDesc: 'The initiator information is invalid.', OriginatorConversationID: f.originatorConversationId } };
    await request(app).post(`/api/payments/mpesa/b2c/result/${tok}`).send(fail);
    await request(app).post(`/api/payments/mpesa/b2c/result/${tok}`).send(fail); // retry
    expect((await PaymentModel.findById(f._id))!.status).toBe('FAILED');
    expect(await realBalance(uid)).toBe(100);

    const u = await payout('timeout-01');
    await request(app).post(`/api/payments/mpesa/b2c/timeout/${tok}`).send({ Result: { OriginatorConversationID: u.originatorConversationId } });
    expect((await PaymentModel.findById(u._id))!.status).toBe('UNCERTAIN');
    expect(await realBalance(uid)).toBe(70); // money may have left: not refunded automatically
    expect((await request(app).post(`/api/admin/payments/${u._id}/resolve`).set(a.auth).send({ outcome: 'FAILED', note: 'Not on statement', totp: a.code() })).status).toBe(200);
    expect(await realBalance(uid)).toBe(100);

    // Ambiguous B2C submission -> UNCERTAIN, no refund
    provider.b2c.mockRejectedValueOnce(new MpesaError('socket hang up', false));
    const amb = await payout('ambig-001');
    expect(amb.status).toBe('UNCERTAIN');
    expect(await realBalance(uid)).toBe(70);
    // Definite refusal -> FAILED and refunded
    await request(app).post(`/api/admin/payments/${amb._id}/resolve`).set(a.auth).send({ outcome: 'COMPLETED', note: 'Seen on statement', receipt: 'QAB1234567', totp: a.code() });
    expect((await PaymentModel.findById(amb._id))!.status).toBe('COMPLETED');
    provider.b2c.mockRejectedValueOnce(new MpesaError('Invalid initiator', true));
    const ref = await payout('refused-01');
    expect(ref.status).toBe('FAILED');
    expect(await realBalance(uid)).toBe(70);
  });

  it('enforces balance, open trades, destination, daily limit; traders can cancel and admins reject (both refund)', async () => {
    await enable({ dailyPayoutLimitCents: 10_000, maxPayoutCents: 10_000 });
    const t = await makeUser(app, 't@x.io', 'trader');
    const uid = await idOf(t.auth);
    await deposited(t.auth, 100);
    const send = async (amount: number, phone = PHONE, k = `p-${Math.random()}`) => request(app).post('/api/payments/payouts').set(t.auth).send({ amount, phone, firstName: 'A', lastName: 'B', idempotencyKey: k, emailCode: await emailCode(t.auth) });
    expect((await send(30, '0799999999')).body.error.code).toBe('UNKNOWN_DESTINATION');
    // Funds in an open trade are not withdrawable
    await PaymentConfigModel.updateOne({ key: 'mpesa' }, { $set: { realTradingEnabled: true } });
    const prevSource = process.env.MARKET_DATA_SOURCE;
    setBook(99.9, 100.1);
    const o = await request(app).post('/api/account/orders').set(t.auth).send({ account: 'REAL', symbol: 'BTC/USDT', direction: 'LONG', investment: 60, stopLossPct: 0.05 });
    expect(o.status).toBe(201);
    expect((await send(50)).body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await PaymentModel.countDocuments({ type: 'PAYOUT' })).toBe(0);
    await request(app).post(`/api/account/positions/${o.body.position._id}/close`).set(t.auth);
    process.env.MARKET_DATA_SOURCE = prevSource;

    const c = await send(30);
    expect(c.status).toBe(201);
    const before = await realBalance(uid);
    expect((await request(app).post(`/api/payments/payouts/${c.body.payment.id}/cancel`).set(t.auth)).body.payment.status).toBe('CANCELLED');
    expect(await realBalance(uid)).toBeCloseTo(before + 30, 6);

    const d = await send(40);
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const rej = await request(app).post(`/api/admin/payments/${d.body.payment.id}/reject`).set(a.auth).send({ note: 'Verify your identity first', totp: a.code() });
    expect(rej.body.payment.status).toBe('REJECTED');
    expect(await realBalance(uid)).toBeCloseTo(before + 30, 6);
    // Another trader cannot see or cancel
    const other = await makeUser(app, 'o@x.io', 'trader');
    expect((await request(app).get(`/api/payments/${d.body.payment.id}`).set(other.auth)).status).toBe(404);
    expect((await request(app).post(`/api/payments/payouts/${d.body.payment.id}/cancel`).set(other.auth)).status).toBe(404);
    expect((await request(app).get('/api/payments').set(other.auth)).body.payments).toHaveLength(0);
    // Daily limit counts pending + completed payouts
    expect((await send(60)).status).toBe(201);
    expect((await send(50)).body.error.code).toBe('DAILY_LIMIT');
  });

  it('auto-approves small payouts to a known number when the admin allows it', async () => {
    await enable({ autoApproveBelowCents: 2_000 });
    const t = await makeUser(app, 't@x.io', 'trader');
    await deposited(t.auth, 100);
    const r = await request(app).post('/api/payments/payouts').set(t.auth).send({ amount: 15, phone: PHONE, firstName: 'A', lastName: 'B', idempotencyKey: 'auto-0001', emailCode: await emailCode(t.auth) });
    expect(r.body.payment.status).toBe('PROCESSING');
    expect(provider.b2c).toHaveBeenCalledTimes(1);
    const big = await request(app).post('/api/payments/payouts').set(t.auth).send({ amount: 25, phone: PHONE, firstName: 'A', lastName: 'B', idempotencyKey: 'auto-0002', emailCode: await emailCode(t.auth) });
    expect(big.body.payment.status).toBe('PENDING');
  });

  it('traders with an authenticator must use it (an email code alone is not enough)', async () => {
    await enable();
    const t = await makeUser(app, 't2fa@x.io', 'trader', true);
    await deposited(t.auth, 50);
    const body = { amount: 20, phone: PHONE, firstName: 'A', lastName: 'B', idempotencyKey: 'tfa-00001' };
    expect((await request(app).post('/api/payments/payouts').set(t.auth).send({ ...body, emailCode: '123456' })).status).toBe(401);
    expect((await request(app).post('/api/payments/payouts').set(t.auth).send({ ...body, totp: t.code() })).status).toBe(201);
  });
});

describe('REAL-account trading', () => {
  it('is off until the admin enables it, never uses simulated prices, and is booked separately from demo', async () => {
    await enable();
    const t = await makeUser(app, 't@x.io', 'trader');
    await deposited(t.auth, 100);
    setBook(99.9, 100.1);
    const order = { account: 'REAL', symbol: 'BTC/USDT', direction: 'LONG', investment: 50, stopLossPct: 0.05 };
    expect((await request(app).post('/api/account/orders').set(t.auth).send(order)).body.error.code).toBe('REAL_TRADING_DISABLED');
    await PaymentConfigModel.updateOne({ key: 'mpesa' }, { $set: { realTradingEnabled: true } });
    process.env.MARKET_DATA_SOURCE = 'simulated';
    reloadEnv();
    expect((await request(app).post('/api/account/orders').set(t.auth).send(order)).body.error.code).toBe('SIMULATED_DATA');
    delete process.env.MARKET_DATA_SOURCE;
    reloadEnv();
    expect((await request(app).post('/api/account/orders').set(t.auth).send({ ...order, investment: 100 })).body.error.code).toBe('INSUFFICIENT_BALANCE');
    const o = await request(app).post('/api/account/orders').set(t.auth).send(order);
    expect(o.status).toBe(201);
    expect(o.body.position.mode).toBe('REAL');
    expect(o.body.order.exchangeOrderId).toMatch(/^client-/); // filled internally, never sent to an exchange
    const real = (await request(app).get('/api/account/positions?account=REAL').set(t.auth)).body.positions;
    const demo = (await request(app).get('/api/account/positions').set(t.auth)).body.positions;
    expect(real).toHaveLength(1);
    expect(demo).toHaveLength(0);
    setBook(109.9, 110.1);
    const c = await request(app).post(`/api/account/positions/${real[0]._id}/close`).set(t.auth);
    expect(c.body.trade.mode).toBe('REAL');
    const acc = (await request(app).get('/api/account?account=REAL').set(t.auth)).body;
    expect(acc.account.balance).toBeGreaterThan(104);
    expect(acc.account.totalPnl).toBeCloseTo(acc.account.balance - 100, 6);
    expect(acc.accounts.DEMO.balance).toBe(10_000);
    expect((await request(app).get('/api/account/history?account=REAL').set(t.auth)).body.trades).toHaveLength(1);
    expect((await request(app).get('/api/account/history').set(t.auth)).body.trades).toHaveLength(0);
  });
});

describe('simulated provider (development)', () => {
  it('completes a deposit and a payout end to end through the same callback handlers', async () => {
    await enable({ autoApproveBelowCents: 100_000 });
    paymentService.setProvider(null);
    paymentService.setSimulatedDelay(20);
    const t = await makeUser(app, 't@x.io', 'trader');
    const uid = await idOf(t.auth);
    const r = await request(app).post('/api/payments/deposits').set(t.auth).send({ amount: 30, phone: PHONE, idempotencyKey: 'sim-00001' });
    expect(r.body.payment.status).toBe('PENDING');
    await new Promise((res) => setTimeout(res, 200));
    expect((await PaymentModel.findById(r.body.payment.id))!.status).toBe('COMPLETED');
    expect(await realBalance(uid)).toBe(30);
    const cancelled = await request(app).post('/api/payments/deposits').set(t.auth).send({ amount: 30, phone: '0712345000', idempotencyKey: 'sim-00002' });
    await new Promise((res) => setTimeout(res, 200));
    expect((await PaymentModel.findById(cancelled.body.payment.id))!.status).toBe('FAILED');
    const p = await request(app).post('/api/payments/payouts').set(t.auth).send({ amount: 20, phone: PHONE, firstName: 'A', lastName: 'B', idempotencyKey: 'sim-pay-1', emailCode: await emailCode(t.auth) });
    expect(p.body.payment.status).toBe('PROCESSING');
    await new Promise((res) => setTimeout(res, 200));
    expect((await PaymentModel.findById(p.body.payment.id))!.status).toBe('COMPLETED');
    expect(await realBalance(uid)).toBe(10);
    paymentService.setSimulatedDelay(3_000);
  });
});
