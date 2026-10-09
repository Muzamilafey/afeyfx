import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { io as ioc, type Socket } from 'socket.io-client';
import { attachSocket } from '../src/websocket/socket';
import { AuthService } from '../src/services/AuthService';
import { eventBus } from '../src/utils/eventBus';
import { User } from '../src/models/User';
import { accountStatus } from '../src/services/AccountStatus';
import { connectTestDb, disconnectTestDb } from './helpers/db';

const ADMIN = '111111111111111111111111';
const mkUser = (id: string, role: 'admin' | 'trader', extra: Record<string, unknown> = {}) => User.create({ _id: id, email: `${id.slice(0, 4)}@x.io`, name: id, role, ...extra });

let server: http.Server;
let close: () => void;
let url: string;

beforeAll(async () => {
  await connectTestDb();
  await mkUser(ADMIN, 'admin');
  await mkUser('aaaaaaaaaaaaaaaaaaaaaaaa', 'trader');
  await mkUser('bbbbbbbbbbbbbbbbbbbbbbbb', 'trader');
  server = http.createServer();
  close = attachSocket(server).close;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  close();
  server.close();
  await disconnectTestDb();
});

const connect = (token?: string) =>
  new Promise<Socket>((resolve, reject) => {
    const s = ioc(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => {
      s.close();
      reject(e);
    });
  });

describe('Socket.IO', () => {
  it('rejects connections without a valid access token', async () => {
    await expect(connect()).rejects.toThrow(/unauthorized/);
    await expect(connect('garbage')).rejects.toThrow(/unauthorized/);
    const challenge = AuthService.signAccess({ sub: '1', email: 'a@b.c', role: 'admin', tfa: true }, '2fa_pending');
    await expect(connect(challenge)).rejects.toThrow(/unauthorized/);
  });

  it('streams engine events to authenticated clients and throttles price updates', async () => {
    const token = AuthService.signAccess({ sub: ADMIN, email: 'a@b.c', role: 'admin', tfa: false });
    const s = await connect(token);
    const trade = new Promise((r) => s.on('trade', r));
    const prices: unknown[] = [];
    s.on('price', (p) => prices.push(p));
    await new Promise((r) => setTimeout(r, 50));
    eventBus.publish('trade', { id: 't1', netPnl: -5 });
    for (let i = 0; i < 10; i++) eventBus.publish('price', { symbol: 'BTC/USDT', last: 100 + i });
    expect(await trade).toEqual({ id: 't1', netPnl: -5 });
    await new Promise((r) => setTimeout(r, 100));
    expect(prices.length).toBe(1);
    s.close();
  });

  it('routes account events only to their owner; system-book events only to admins', async () => {
    const alice = await connect(AuthService.signAccess({ sub: 'aaaaaaaaaaaaaaaaaaaaaaaa', email: 'a@x.io', role: 'trader', tfa: false }));
    const bob = await connect(AuthService.signAccess({ sub: 'bbbbbbbbbbbbbbbbbbbbbbbb', email: 'b@x.io', role: 'trader', tfa: false }));
    const got: Record<string, unknown[]> = { alice: [], bob: [] };
    alice.on('trade', (t) => got.alice.push(t));
    bob.on('trade', (t) => got.bob.push(t));
    alice.on('signal', (t) => got.alice.push(t));
    await new Promise((r) => setTimeout(r, 50));
    eventBus.publish('trade', { id: 'mine', user: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    eventBus.publish('trade', { id: 'system' });
    eventBus.publish('signal', { id: 'engine-signal' });
    await new Promise((r) => setTimeout(r, 150));
    expect(got.alice).toEqual([{ id: 'mine', user: 'aaaaaaaaaaaaaaaaaaaaaaaa' }]);
    expect(got.bob).toEqual([]);
    alice.close();
    bob.close();
  });

  it('refuses sockets of suspended, disabled or deleted accounts even with a still-valid token', async () => {
    const id = 'cccccccccccccccccccccccc';
    await mkUser(id, 'trader', { active: false });
    accountStatus.invalidate(id);
    await expect(connect(AuthService.signAccess({ sub: id, email: 'c@x.io', role: 'trader', tfa: false }))).rejects.toThrow(/unauthorized/);
    await User.updateOne({ _id: id }, { $set: { active: true, suspendedUntil: new Date(Date.now() + 86_400_000) } });
    accountStatus.invalidate(id);
    await expect(connect(AuthService.signAccess({ sub: id, email: 'c@x.io', role: 'trader', tfa: false }))).rejects.toThrow(/unauthorized/);
  });
});
