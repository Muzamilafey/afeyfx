import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { env } from '../config/env';
import { AuthService } from '../services/AuthService';
import { eventBus, type BusEvent } from '../utils/eventBus';
import { setSocketClientCount } from '../services/HealthService';
import { logger } from '../utils/logger';

/** Market events go to everyone. Account events go to their owner; system-book events to admins only. */
const PUBLIC_EVENTS = new Set<BusEvent>(['price', 'candle', 'exchange-status']);
const OWNED_EVENTS = new Set<BusEvent>(['order', 'trade', 'position', 'portfolio']);

export function route(ev: BusEvent, payload: unknown): string | string[] {
  if (PUBLIC_EVENTS.has(ev)) return 'dashboard';
  if (OWNED_EVENTS.has(ev)) {
    const p = (payload ?? {}) as { user?: unknown; owner?: unknown };
    const owner = p.user ?? p.owner;
    // A personal account's events go only to that user (admins see the system book, not other users' accounts).
    return owner ? `user:${String(owner)}` : 'admins';
  }
  return 'admins';
}

/** Events streamed to authenticated dashboard clients. */
const STREAMED: BusEvent[] = ['price', 'candle', 'signal', 'order', 'trade', 'position', 'portfolio', 'risk', 'exchange-status', 'ai-analysis', 'system'];

/**
 * Socket.IO server. Connections must present a valid access token (auth.token). Price updates
 * are throttled per symbol to protect clients; everything else is forwarded as it happens.
 */
export function attachSocket(server: HttpServer) {
  const io = new Server(server, {
    cors: { origin: env.CLIENT_ORIGIN.split(',').map((s) => s.trim()), credentials: true },
    path: '/socket.io',
    serveClient: false,
  });

  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: string })?.token;
    if (!token) return next(new Error('unauthorized'));
    try {
      const c = AuthService.verifyAccess(token);
      if (c.typ !== 'access') return next(new Error('unauthorized'));
      socket.data.user = { id: c.sub, role: c.role };
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    setSocketClientCount(io.engine.clientsCount);
    socket.join('dashboard');
    socket.join(`user:${socket.data.user.id}`);
    if (socket.data.user.role === 'admin') socket.join('admins');
    socket.on('disconnect', () => setSocketClientCount(io.engine.clientsCount));
  });

  const lastPrice = new Map<string, number>();
  const handlers = STREAMED.map((ev) => {
    const fn = (payload: unknown) => {
      if (ev === 'price') {
        const sym = (payload as { symbol?: string }).symbol ?? '';
        const now = Date.now();
        if (now - (lastPrice.get(sym) ?? 0) < 250) return;
        lastPrice.set(sym, now);
      }
      io.to(route(ev, payload)).emit(ev, payload);
    };
    eventBus.on(ev, fn);
    return [ev, fn] as const;
  });

  logger.info('Socket.IO attached');
  return {
    io,
    close: () => {
      for (const [ev, fn] of handlers) eventBus.off(ev, fn);
      io.close();
    },
  };
}
