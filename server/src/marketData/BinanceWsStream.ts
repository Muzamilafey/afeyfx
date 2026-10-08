import WebSocket from 'ws';
import { logger, errorMessage } from '../utils/logger';
import type { Candle, Ticker } from '../types';

export interface WsHandlers {
  onTicker(t: Ticker): void;
  onClosedCandle(symbol: string, tf: string, c: Candle): void;
  onStatus(connected: boolean, info?: string): void;
}

const toStream = (symbol: string) => symbol.replace('/', '').toLowerCase();

/**
 * Native Binance combined-stream client (bookTicker + kline) for low-latency data.
 * - Automatic reconnection with exponential backoff (capped) and jitter
 * - Heartbeat watchdog: reconnects if no message within `staleMs`
 * - De-duplication: bookTicker by update id, klines by (symbol, tf, open time); only CLOSED klines emitted
 * - Proactive reconnect before Binance's 24h connection limit
 */
export class BinanceWsStream {
  private ws?: WebSocket;
  private attempts = 0;
  private stopped = false;
  private watchdog?: NodeJS.Timeout;
  private rotate?: NodeJS.Timeout;
  private lastMsgAt = 0;
  private lastUpdateId = new Map<string, number>();
  private lastKline = new Map<string, number>();
  private symbolMap = new Map<string, string>();

  constructor(
    private symbols: string[],
    private timeframes: string[],
    private handlers: WsHandlers,
    private opts = { baseUrl: 'wss://stream.binance.com:9443/stream', staleMs: 30_000, maxBackoffMs: 60_000 },
  ) {
    for (const s of symbols) this.symbolMap.set(toStream(s).toUpperCase(), s);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.rotate);
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.handlers.onStatus(false, 'stopped');
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private url() {
    const streams = this.symbols.flatMap((s) => [`${toStream(s)}@bookTicker`, ...this.timeframes.map((tf) => `${toStream(s)}@kline_${tf}`)]);
    return `${this.opts.baseUrl}?streams=${streams.join('/')}`;
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.on('open', () => {
      this.attempts = 0;
      this.lastMsgAt = Date.now();
      this.handlers.onStatus(true);
      clearInterval(this.watchdog);
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastMsgAt > this.opts.staleMs) {
          logger.warn({ component: 'binance-ws' }, 'WebSocket stale; reconnecting');
          ws.terminate();
        }
      }, 5_000);
      clearTimeout(this.rotate);
      this.rotate = setTimeout(() => ws.close(1000, 'rotate'), 23 * 3_600_000);
    });
    ws.on('message', (buf) => {
      this.lastMsgAt = Date.now();
      try {
        this.handle(JSON.parse(buf.toString()));
      } catch (err) {
        logger.warn({ component: 'binance-ws', err: errorMessage(err) }, 'Bad WS message');
      }
    });
    ws.on('ping', (d) => ws.pong(d));
    ws.on('error', (err) => logger.warn({ component: 'binance-ws', err: errorMessage(err) }, 'WebSocket error'));
    ws.on('close', () => {
      clearInterval(this.watchdog);
      this.handlers.onStatus(false, 'closed');
      if (this.stopped) return;
      const backoff = Math.min(this.opts.maxBackoffMs, 1000 * 2 ** this.attempts++) * (0.8 + Math.random() * 0.4);
      setTimeout(() => this.connect(), backoff);
    });
  }

  /** Exposed for tests. */
  handle(msg: { stream?: string; data?: Record<string, unknown> }) {
    const d = msg.data;
    if (!d || !msg.stream) return;
    if (msg.stream.endsWith('@bookTicker')) {
      const sym = this.symbolMap.get(String(d.s));
      if (!sym) return;
      const u = Number(d.u);
      if ((this.lastUpdateId.get(sym) ?? -1) >= u) return; // duplicate / out-of-order
      this.lastUpdateId.set(sym, u);
      const bid = Number(d.b);
      const ask = Number(d.a);
      this.handlers.onTicker({ symbol: sym, timestamp: Date.now(), bid, ask, last: (bid + ask) / 2 });
      return;
    }
    if (msg.stream.includes('@kline_')) {
      const k = d.k as Record<string, unknown>;
      const sym = this.symbolMap.get(String(d.s));
      if (!sym || !k || k.x !== true) return; // only closed candles
      const tf = String(k.i);
      const ts = Number(k.t);
      const key = `${sym}:${tf}`;
      if ((this.lastKline.get(key) ?? -1) >= ts) return;
      this.lastKline.set(key, ts);
      this.handlers.onClosedCandle(sym, tf, { timestamp: ts, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v) });
    }
  }
}
