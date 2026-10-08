import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { io as ioc, type Socket } from 'socket.io-client';
import { attachSocket } from '../src/websocket/socket';
import { AuthService } from '../src/services/AuthService';
import { eventBus } from '../src/utils/eventBus';

let server: http.Server;
let close: () => void;
let url: string;

beforeAll(async () => {
  server = http.createServer();
  close = attachSocket(server).close;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  close();
  server.close();
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
    const token = AuthService.signAccess({ sub: '1', email: 'a@b.c', role: 'viewer', tfa: false });
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
});
