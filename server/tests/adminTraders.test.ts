import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { User } from '../src/models/User';
import { RefreshToken } from '../src/models/RefreshToken';
import { PortfolioModel } from '../src/models/Portfolio';
import { PositionModel } from '../src/models/Position';
import { TradeModel } from '../src/models/Trade';
import { AuditLogModel } from '../src/models/AuditLog';
import { accountStatus } from '../src/services/AccountStatus';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser, PASSWORD } from './helpers/api';

const app = createApp();
beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(clearDb);

const idOf = async (email: string) => (await User.findOne({ email }))!._id.toString();
const login = (email: string, password = PASSWORD) => request(app).post('/api/auth/login').send({ email, password });

describe('admin: traders overview', () => {
  it('lists traders with demo/real summaries and shows one trader in detail; traders cannot see it', async () => {
    const a = await makeUser(app, 'boss@x.io', 'admin');
    const t = await makeUser(app, 't@x.io', 'trader');
    const tid = await idOf('t@x.io');
    await request(app).get('/api/account').set(t.auth); // creates the demo account
    await TradeModel.create({ mode: 'PAPER', user: tid, exchange: 'binance', symbol: 'BTC/USDT', direction: 'LONG', amount: 1, entryPrice: 100, exitPrice: 110, grossPnl: 10, fees: 0, netPnl: 10, openedAt: new Date(), closedAt: new Date() });
    const list = await request(app).get('/api/admin/traders').set(a.auth);
    expect(list.status).toBe(200);
    const row = list.body.traders.find((x: { email: string }) => x.email === 't@x.io');
    expect(row).toMatchObject({ status: 'active', demo: { exists: true, balance: 10000, trades: 1, netPnl: 10, winRate: 1 } });
    expect((await request(app).get('/api/admin/traders?q=t%40x').set(a.auth)).body.traders).toHaveLength(1);
    const d = await request(app).get(`/api/admin/traders/${tid}`).set(a.auth);
    expect(d.body.accounts.DEMO).toMatchObject({ balance: 10000 });
    expect(d.body.trades).toHaveLength(1);
    expect(JSON.stringify(d.body)).not.toMatch(/passwordHash|twoFactorSecret/);
    expect(await AuditLogModel.countDocuments({ action: 'ADMIN_VIEWED_TRADER' })).toBe(1);
    expect((await request(app).get('/api/admin/traders').set(t.auth)).status).toBe(403);
  });
});

describe('admin: account management', () => {
  it('suspend blocks the next request immediately (even with a valid token) and login, until lifted', async () => {
    const a = await makeUser(app, 'boss@x.io', 'admin');
    const t = await makeUser(app, 't@x.io', 'trader');
    const tid = await idOf('t@x.io');
    expect((await request(app).get('/api/account').set(t.auth)).status).toBe(200);
    expect((await request(app).post(`/api/admin/traders/${tid}/suspend`).set(a.auth).send({ days: 7, reason: 'Chargeback investigation' })).body.user.status).toBe('suspended');
    const blocked = await request(app).get('/api/account').set(t.auth);
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect(await RefreshToken.countDocuments({ user: tid, revokedAt: null })).toBe(0);
    const l = await login('t@x.io');
    expect(l.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await login('t@x.io', 'wrong-password-1A')).body.error.code).toBe('INVALID_CREDENTIALS'); // status only revealed with the right password
    await request(app).post(`/api/admin/traders/${tid}/unsuspend`).set(a.auth);
    expect((await login('t@x.io')).status).toBe(200);
  });

  it('disable / enable', async () => {
    const a = await makeUser(app, 'boss@x.io', 'admin');
    const t = await makeUser(app, 't@x.io', 'trader');
    const tid = await idOf('t@x.io');
    expect((await request(app).post(`/api/admin/traders/${tid}/disable`).set(a.auth).send({ reason: 'x' })).status).toBe(400); // reason required
    await request(app).post(`/api/admin/traders/${tid}/disable`).set(a.auth).send({ reason: 'Terms violation' });
    expect((await request(app).get('/api/account').set(t.auth)).body.error.code).toBe('ACCOUNT_DISABLED');
    expect((await login('t@x.io')).body.error.code).toBe('ACCOUNT_DISABLED');
    await request(app).post(`/api/admin/traders/${tid}/enable`).set(a.auth);
    expect((await login('t@x.io')).status).toBe(200);
  });

  it('soft delete needs 2FA + typed confirmation, is refused while money or positions are open, keeps history, and can be restored', async () => {
    const a = await makeUser(app, 'boss@x.io', 'admin', true);
    await makeUser(app, 't@x.io', 'trader');
    const tid = await idOf('t@x.io');
    await TradeModel.create({ mode: 'PAPER', user: tid, exchange: 'binance', symbol: 'BTC/USDT', direction: 'LONG', amount: 1, entryPrice: 100, exitPrice: 90, grossPnl: -10, fees: 0, netPnl: -10, openedAt: new Date(), closedAt: new Date() });
    const del = (body: Record<string, unknown>) => request(app).post(`/api/admin/traders/${tid}/delete`).set(a.auth).send(body);
    expect((await del({ reason: 'Closed at request', confirm: 'DELETE' })).status).toBe(401); // no 2FA code
    expect((await del({ reason: 'Closed at request', confirm: 'yes', totp: a.code() })).status).toBe(400);
    await PortfolioModel.create({ mode: 'REAL', owner: tid, startingBalance: 50, balance: 50, equity: 50, available: 50, peakEquity: 50 });
    await PositionModel.create({ mode: 'PAPER', user: tid, exchange: 'binance', symbol: 'BTC/USDT', direction: 'LONG', amount: 1, entryPrice: 100, status: 'OPEN', openedAt: new Date() });
    const refused = await del({ reason: 'Closed at request', confirm: 'DELETE', totp: a.code() });
    expect(refused.body.error.code).toBe('ACCOUNT_HAS_FUNDS');
    expect(refused.body.error.message).toMatch(/open position.*real-money balance of \$50\.00/);
    await PositionModel.deleteMany({});
    await PortfolioModel.updateOne({ mode: 'REAL', owner: tid }, { $set: { balance: 0 } });
    await new Promise((r) => setTimeout(r, 1100)); // fresh TOTP window for the protected action
    const ok = await del({ reason: 'Closed at request', confirm: 'DELETE', totp: a.code() });
    expect(ok.body.user.status).toBe('deleted');
    expect((await login('t@x.io')).body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await TradeModel.countDocuments({ user: tid })).toBe(1); // history kept
    expect((await request(app).get('/api/admin/traders').set(a.auth)).body.traders.some((x: { email: string }) => x.email === 't@x.io')).toBe(false);
    expect((await request(app).get('/api/admin/traders?status=deleted').set(a.auth)).body.traders).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1100));
    const back = await request(app).post(`/api/admin/traders/${tid}/restore`).set(a.auth).send({ totp: a.code() });
    expect(back.body.user.status).toBe('active');
    accountStatus.invalidate(tid);
    expect((await login('t@x.io')).status).toBe(200);
  }, 20_000);

  it('reset password: sets a temporary password, ends sessions, unlocks, asks the user to change it; never on yourself', async () => {
    const a = await makeUser(app, 'boss@x.io', 'admin', true);
    const t = await makeUser(app, 't@x.io', 'trader');
    const tid = await idOf('t@x.io');
    await User.updateOne({ _id: tid }, { $set: { lockedUntil: new Date(Date.now() + 3_600_000) } });
    expect((await request(app).post(`/api/admin/traders/${tid}/reset-password`).set(a.auth).send({ password: 'weak', totp: a.code() })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 1100));
    const r = await request(app).post(`/api/admin/traders/${tid}/reset-password`).set(a.auth).send({ password: 'TempPassword2026', totp: a.code() });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('TempPassword2026');
    expect((await request(app).get('/api/account').set(t.auth)).status).toBe(200); // access token still valid briefly...
    expect(await RefreshToken.countDocuments({ user: tid, revokedAt: null })).toBe(0); // ...but every session is revoked
    expect((await login('t@x.io')).status).toBe(401);
    const l = await login('t@x.io', 'TempPassword2026');
    expect(l.status).toBe(200);
    expect(l.body.user.mustChangePassword).toBe(true);
    const me = await idOf('boss@x.io');
    expect((await request(app).post(`/api/admin/traders/${me}/suspend`).set(a.auth).send({ days: 1, reason: 'self test' })).body.error.code).toBe('SELF_ACTION');
    expect(await AuditLogModel.countDocuments({ action: 'TRADER_PASSWORD_RESET' })).toBe(1);
  }, 20_000);
});
