import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { User } from '../src/models/User';
import { AuditLogModel } from '../src/models/AuditLog';
import { SettingsModel } from '../src/models/Settings';
import { StrategyModel } from '../src/models/Strategy';
import { BacktestRunModel } from '../src/models/BacktestRun';
import { BacktestModel } from '../src/models/Backtest';
import { generateTotpSecret, totp } from '../src/utils/totp';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser, PASSWORD } from './helpers/api';

const app = createApp();

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearDb();
  tradingState.reset();
  circuitBreaker.resetAll();
  process.env.LIVE_TRADING_ENABLED = 'false';
});

const cookieFrom = (res: request.Response) => ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('afx_rt='))!;

describe('authentication', () => {
  it('first registration bootstraps an admin; later public registration is closed', async () => {
    const r = await request(app).post('/api/auth/register').send({ email: 'boss@x.io', name: 'Boss', password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('admin');
    expect(r.body.user).not.toHaveProperty('passwordHash');
    const r2 = await request(app).post('/api/auth/register').send({ email: 'eve@x.io', name: 'Eve', password: PASSWORD });
    expect(r2.status).toBe(403);
  });

  it('rejects weak passwords', async () => {
    const r = await request(app).post('/api/auth/register').send({ email: 'a@x.io', name: 'A', password: 'short' });
    expect(r.status).toBe(400);
  });

  it('stores bcrypt hashes, not passwords', async () => {
    await request(app).post('/api/auth/register').send({ email: 'boss@x.io', name: 'Boss', password: PASSWORD });
    const u = await User.findOne({ email: 'boss@x.io' }).select('+passwordHash');
    expect(u!.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  it('login returns an access token and an httpOnly, SameSite=Strict refresh cookie', async () => {
    await makeUser(app, 'v@x.io', 'viewer');
    const r = await request(app).post('/api/auth/login').send({ email: 'v@x.io', password: PASSWORD });
    expect(r.body.accessToken).toBeTruthy();
    const c = cookieFrom(r);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${r.body.accessToken}`);
    expect(me.body.user.email).toBe('v@x.io');
  });

  it('wrong password gives a generic error and locks after 5 failures', async () => {
    await makeUser(app, 'v@x.io', 'viewer');
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/api/auth/login').send({ email: 'v@x.io', password: 'WrongPassword123' });
      expect(r.status).toBe(401);
    }
    const locked = await request(app).post('/api/auth/login').send({ email: 'v@x.io', password: PASSWORD });
    expect(locked.status).toBe(423);
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@x.io', password: PASSWORD });
    expect(unknown.body.error.message).toBe('Invalid email or password');
  });

  it('refresh tokens rotate and reuse revokes the session family', async () => {
    await makeUser(app, 'v@x.io', 'viewer');
    const login = await request(app).post('/api/auth/login').send({ email: 'v@x.io', password: PASSWORD });
    const c1 = cookieFrom(login);
    const r1 = await request(app).post('/api/auth/refresh').set('Cookie', c1);
    expect(r1.status).toBe(200);
    const c2 = cookieFrom(r1);
    expect(c2).not.toBe(c1);
    const reuse = await request(app).post('/api/auth/refresh').set('Cookie', c1);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_REUSE');
    const after = await request(app).post('/api/auth/refresh').set('Cookie', c2);
    expect(after.status).toBe(401); // whole family revoked
  });

  it('2FA: setup, confirm, then login requires a valid TOTP code', async () => {
    const { auth } = await makeUser(app, 't@x.io', 'trader');
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth);
    expect(setup.body.qr).toMatch(/^data:image\/png/);
    expect((await request(app).post('/api/auth/2fa/confirm').set(auth).send({ code: '000000' })).status).toBe(400);
    expect((await request(app).post('/api/auth/2fa/confirm').set(auth).send({ code: totp(setup.body.secret) })).status).toBe(200);
    const login = await request(app).post('/api/auth/login').send({ email: 't@x.io', password: PASSWORD });
    expect(login.body.requires2fa).toBe(true);
    expect(login.body.accessToken).toBeUndefined();
    // The challenge token cannot be used as an access token.
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.challengeToken}`)).status).toBe(401);
    expect((await request(app).post('/api/auth/2fa/verify').send({ challengeToken: login.body.challengeToken, code: '123456' })).status).toBe(401);
    const ok = await request(app).post('/api/auth/2fa/verify').send({ challengeToken: login.body.challengeToken, code: totp(setup.body.secret) });
    expect(ok.body.accessToken).toBeTruthy();
  });

  it('audit logs record logins without secrets', async () => {
    await makeUser(app, 'v@x.io', 'viewer');
    const logs = await AuditLogModel.find().lean();
    expect(logs.some((l) => l.action === 'LOGIN_PASSWORD_OK')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
  });
});

describe('API security', () => {
  const PRIVATE: [string, string][] = [
    ['get', '/api/users'], ['get', '/api/exchanges'], ['get', '/api/markets'], ['get', '/api/market-data/summary'], ['get', '/api/strategies'],
    ['get', '/api/signals'], ['get', '/api/orders'], ['get', '/api/positions'], ['get', '/api/trades'], ['get', '/api/portfolio'],
    ['get', '/api/backtests'], ['get', '/api/ai/status'], ['get', '/api/risk'], ['get', '/api/settings'], ['get', '/api/notifications'],
    ['get', '/api/system/health'], ['post', '/api/system/emergency/shutdown'], ['post', '/api/system/live/enable'], ['put', '/api/risk/config'], ['post', '/api/orders'],
  ];

  it('every private endpoint rejects unauthenticated requests', async () => {
    for (const [m, url] of PRIVATE) {
      const r = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[m](url);
      expect(r.status, `${m.toUpperCase()} ${url}`).toBe(401);
    }
  });

  it('rejects forged tokens', async () => {
    const r = await request(app).get('/api/risk').set('Authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIiwicm9sZSI6ImFkbWluIn0.');
    expect(r.status).toBe(401);
  });

  it('sets security headers (helmet) and hides x-powered-by', async () => {
    const r = await request(app).get('/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeDefined();
    expect(r.headers['content-security-policy']).toBeDefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS only allows the configured origin', async () => {
    const bad = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const good = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(good.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('validates input and rejects malformed JSON', async () => {
    const { auth } = await makeUser(app, 't@x.io', 'trader');
    expect((await request(app).post('/api/orders').set(auth).send({ symbol: 'BTC/USDT; drop', side: 'buy', type: 'market', amount: -1 })).status).toBe(400);
    expect((await request(app).post('/api/auth/login').set('content-type', 'application/json').send('{bad')).status).toBe(400);
  });

  it('public /health exposes no internals', async () => {
    const r = await request(app).get('/health');
    expect(Object.keys(r.body).sort()).toEqual(['mode', 'status', 'time']);
    expect(r.body.mode).toBe('PAPER');
  });
});

describe('RBAC', () => {
  it('viewer can read but cannot trade or administer', async () => {
    const { auth } = await makeUser(app, 'v@x.io', 'viewer');
    expect((await request(app).get('/api/risk').set(auth)).status).toBe(200);
    expect((await request(app).post('/api/orders').set(auth).send({ symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 1 })).status).toBe(403);
    expect((await request(app).get('/api/users').set(auth)).status).toBe(403);
    expect((await request(app).post('/api/system/emergency/stop-new-trades').set(auth).send({})).status).toBe(403);
  });

  it('trader can trade paper but cannot administer', async () => {
    const { auth } = await makeUser(app, 't@x.io', 'trader');
    expect((await request(app).get('/api/users').set(auth)).status).toBe(403);
    expect((await request(app).put('/api/risk/config').set(auth).send({ maxRiskPerTrade: 0.01 })).status).toBe(403);
    expect((await request(app).post('/api/system/live/enable').set(auth).send({ password: PASSWORD, confirmation: 'x' })).status).toBe(403);
  });

  it('admin can manage users', async () => {
    const { auth } = await makeUser(app, 'a@x.io', 'admin');
    const r = await request(app).post('/api/users').set(auth).send({ email: 'n@x.io', name: 'N', password: PASSWORD, role: 'trader' });
    expect(r.status).toBe(201);
    expect(r.body.user.role).toBe('trader');
  });
});

describe('protected actions', () => {
  it('require admin with 2FA enabled and a fresh TOTP code', async () => {
    const no2fa = await makeUser(app, 'a1@x.io', 'admin', false);
    const r1 = await request(app).post('/api/system/emergency/stop-new-trades').set(no2fa.auth).send({});
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('TWO_FACTOR_REQUIRED');

    const a = await makeUser(app, 'a2@x.io', 'admin', true);
    expect((await request(app).post('/api/system/emergency/stop-new-trades').set(a.auth).send({ totp: '000000' })).status).toBe(401);
    const ok = await request(app).post('/api/system/emergency/stop-new-trades').set(a.auth).send({ totp: a.code(), reason: 'test' });
    expect(ok.status).toBe(200);
    expect(tradingState.get().tradingEnabled).toBe(false);
    expect(circuitBreaker.isTripped('MANUAL_STOP')).toBe(true);
  });

  it('emergency controls are four separate endpoints', async () => {
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const sd = await request(app).post('/api/system/emergency/shutdown').set(a.auth).send({ totp: a.code(), reason: 'drill' });
    expect(sd.status).toBe(200);
    expect(tradingState.get().emergencyShutdown).toBe(true);
    expect(tradingState.get().mode).toBe('PAPER');
    expect((await request(app).post('/api/system/emergency/cancel-orders').set(a.auth).send({ totp: a.code() })).status).toBe(200);
    expect((await request(app).post('/api/system/emergency/close-positions').set(a.auth).send({ totp: a.code() })).status).toBe(200);
    expect((await SettingsModel.findOne({ key: 'global' }))!.emergencyShutdown).toBe(true);
  });

  it('LIVE mode cannot be enabled via the API when LIVE_TRADING_ENABLED=false, even by a 2FA admin with the right phrase', async () => {
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const status = await request(app).get('/api/system/live').set(a.auth);
    const r = await request(app).post('/api/system/live/enable').set(a.auth).send({ totp: a.code(), password: PASSWORD, confirmation: status.body.confirmationPhrase });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('LIVE_TRADING_DISABLED');
    expect(tradingState.get().mode).toBe('PAPER');
    const logs = await AuditLogModel.find({ action: 'LIVE_ENABLE_DENIED' });
    expect(logs).toHaveLength(1);
  });

  it('LIVE enable needs the password even with valid 2FA', async () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const r = await request(app).post('/api/system/live/enable').set(a.auth).send({ totp: a.code(), password: 'nope', confirmation: 'x' });
    expect(r.status).toBe(401);
    expect(tradingState.get().liveModeActive).toBe(false);
  });

  it('risk config changes are bounded', async () => {
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const bad = await request(app).put('/api/risk/config').set(a.auth).send({ totp: a.code(), maxRiskPerTrade: 0.5 });
    expect(bad.status).toBe(400);
    expect(tradingState.get().risk.maxRiskPerTrade).toBe(0.005);
    const ok = await request(app).put('/api/risk/config').set(a.auth).send({ totp: a.code(), maxRiskPerTrade: 0.004 });
    expect(ok.status).toBe(200);
    expect(tradingState.get().risk.maxRiskPerTrade).toBe(0.004);
  });

  it('manual orders are paper-only', async () => {
    tradingState.update({ mode: 'LIVE' });
    const { auth } = await makeUser(app, 't@x.io', 'trader');
    const r = await request(app).post('/api/orders').set(auth).send({ symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 1 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('PAPER_ONLY');
  });

  it('a fresh TOTP is needed (replaying a random code fails)', async () => {
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const other = generateTotpSecret();
    expect((await request(app).post('/api/system/emergency/cancel-orders').set(a.auth).send({ totp: totp(other) })).status).toBe(401);
  });

  it('strategy promotion requires evidence with real trades and cannot skip stages', async () => {
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    await StrategyModel.create({ key: 'momentum', name: 'Momentum', version: '1', stage: 'BACKTEST' });
    const promote = (stage: string) => request(app).post('/api/strategies/momentum/stage').set(a.auth).send({ totp: a.code(), stage });
    expect((await promote('LIVE')).status).toBe(409); // cannot skip stages
    expect((await promote('OUT_OF_SAMPLE')).status).toBe(412); // no backtest
    const bt = await BacktestModel.create({ strategyKey: 'momentum', symbol: 'BTC/USDT', timeframe: '1h' });
    await BacktestRunModel.create({ backtest: bt._id, strategyKey: 'momentum', segment: 'FULL', status: 'COMPLETED', metrics: { numberOfTrades: 0 } });
    expect((await promote('OUT_OF_SAMPLE')).status).toBe(412); // a backtest that never traded proves nothing
    await BacktestRunModel.create({ backtest: bt._id, strategyKey: 'momentum', segment: 'FULL', status: 'COMPLETED', metrics: { numberOfTrades: 12 } });
    expect((await promote('OUT_OF_SAMPLE')).status).toBe(200);
    expect((await promote('PAPER')).status).toBe(412); // needs walk-forward OOS evidence
    await BacktestRunModel.create({ backtest: bt._id, strategyKey: 'momentum', segment: 'OUT_OF_SAMPLE', status: 'COMPLETED', metrics: { numberOfTrades: 8 } });
    expect((await promote('PAPER')).status).toBe(200);
    expect((await promote('APPROVED')).status).toBe(412); // needs 30 paper trades
  });
});
