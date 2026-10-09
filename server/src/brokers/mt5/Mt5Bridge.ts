import crypto from 'crypto';
import { EventEmitter } from 'events';
import { env } from '../../config/env';
import { BrokerConnectionModel, type BrokerConnectionDoc } from '../../models/BrokerConnection';
import { BrokerNonceModel, Mt5CommandModel } from '../../models/BrokerRecords';
import { AppError } from '../../utils/errors';
import { decrypt } from '../../utils/crypto';

/**
 * AfeyFX ⇄ MetaTrader 5 bridge protocol (server side). See docs/BROKERS.md for the full spec.
 *
 * The Expert Advisor runs inside the user's own MT5 terminal (already logged in to their broker)
 * and connects OUT to AfeyFX over HTTPS. MT5 offers no inbound API, so the EA polls for commands.
 * The terminal password never leaves the terminal.
 *
 * Every request is signed:  X-AFX-Terminal, X-AFX-Timestamp (ms), X-AFX-Nonce, X-AFX-Signature
 *   signature = hex(HMAC-SHA256(secret, `${timestamp}\n${nonce}\n${METHOD}\n${path}\n${hex(sha256(body))}`))
 * Requests outside the clock window or with a reused nonce are rejected (replay protection).
 *
 * Endpoints (POST, JSON in; commands come back as plain text lines — trivial to parse in MQL5):
 *   /hello      account identity (login, server, company, currency, trade mode, leverage)
 *   /heartbeat  balance/equity/margin, positions, pending orders, recent deals  → command lines
 *   /symbols    symbol specifications (contract size, tick size/value, volume limits, digits)
 *   /quotes     bid/ask batch
 *   /reports    execution reports for commands (idempotent per commandId)
 *   /poll       lightweight command pickup between heartbeats                → command lines
 *
 * Command line format (one per line, '|' separated, empty fields allowed):
 *   CMD|commandId|type|symbol|side|orderType|volume|price|sl|tp|ticket|deadlineEpochSec
 * The EA must not execute a command after its deadline, must execute each commandId at most
 * once (persisted across restarts) and must put the commandId in the order comment.
 */
export interface Mt5Position { ticket: string; symbol: string; type: 'buy' | 'sell'; volume: number; priceOpen: number; priceCurrent?: number; sl?: number; tp?: number; profit?: number; time?: number; comment?: string; magic?: number }
export interface Mt5Order { ticket: string; symbol: string; type: string; volume: number; price: number; sl?: number; tp?: number; comment?: string }
export interface Mt5Deal { ticket: string; order?: string; positionId?: string; symbol: string; entry: 'in' | 'out' | 'inout' | 'out_by' | string; type: string; volume: number; price: number; profit?: number; commission?: number; swap?: number; time: number; comment?: string }
export interface Mt5Symbol { name: string; description?: string; digits?: number; contractSize?: number; tickSize?: number; tickValue?: number; volumeMin?: number; volumeMax?: number; volumeStep?: number; tradeMode?: string; currencyProfit?: string; currencyMargin?: string; path?: string; sessionOpen?: boolean }
export interface Mt5Report { commandId: string; status: 'filled' | 'placed' | 'done' | 'rejected' | 'error' | 'expired' | 'unknown'; retcode?: number; message?: string; order?: string; deal?: string; position?: string; price?: number; volume?: number; time?: number }

export interface TerminalState {
  hello?: { login: string; server: string; company: string; currency: string; tradeMode: string; leverage?: number; name?: string; eaVersion?: string; at: number };
  account?: { balance: number; equity: number; margin: number; freeMargin: number; marginLevel?: number; currency?: string; at: number };
  positions: Mt5Position[];
  orders: Mt5Order[];
  deals: Mt5Deal[];
  symbols: Map<string, Mt5Symbol>;
  quotes: Map<string, { bid: number; ask: number; time: number }>;
  lastSeenAt: number;
  terminalTimeSkewMs?: number;
}

const sha256hex = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
export const signMt5 = (secret: string, ts: string, nonce: string, method: string, path: string, body: Buffer | string) =>
  crypto.createHmac('sha256', secret).update(`${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${sha256hex(body)}`).digest('hex');

const clean = (v: unknown) => String(v ?? '').replace(/[|\r\n]/g, '');

export class Mt5BridgeService {
  private state = new Map<string, TerminalState>(); // connectionId → live terminal state
  readonly events = new EventEmitter();
  private waiters = new Map<string, (r: Mt5Report) => void>();

  stateOf(connectionId: string): TerminalState {
    let s = this.state.get(connectionId);
    if (!s) {
      s = { positions: [], orders: [], deals: [], symbols: new Map(), quotes: new Map(), lastSeenAt: 0 };
      this.state.set(connectionId, s);
    }
    return s;
  }

  reset(connectionId?: string) {
    if (connectionId) this.state.delete(connectionId);
    else this.state.clear();
  }

  /** Verify a signed terminal request; returns the connection. */
  async authenticate(headers: Record<string, string | string[] | undefined>, method: string, path: string, rawBody: Buffer | undefined): Promise<BrokerConnectionDoc> {
    if (!env.MT5_BRIDGE_ENABLED) throw new AppError(404, 'Not found');
    const h = (k: string) => {
      const v = headers[k.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const terminalId = h('x-afx-terminal');
    const ts = h('x-afx-timestamp');
    const nonce = h('x-afx-nonce');
    const sig = h('x-afx-signature');
    const deny = () => new AppError(401, 'Invalid terminal signature', 'BRIDGE_AUTH');
    if (!terminalId || !ts || !nonce || !sig || !/^[\w-]{8,64}$/.test(nonce) || !/^[0-9a-f]{64}$/i.test(sig)) throw deny();
    if (Math.abs(Date.now() - Number(ts)) > env.MT5_BRIDGE_MAX_SKEW_MS) throw new AppError(401, 'Terminal clock out of sync (check Windows time)', 'BRIDGE_CLOCK');
    const conn = await BrokerConnectionModel.findOne({ terminalId, provider: 'mt5' });
    if (!conn?.terminalSecretEnc || conn.status === 'REVOKED') throw deny();
    const expected = signMt5(decrypt(conn.terminalSecretEnc), ts, nonce, method, path, rawBody ?? Buffer.alloc(0));
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig.toLowerCase(), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw deny();
    try {
      await BrokerNonceModel.create({ key: `${terminalId}:${nonce}`, expiresAt: new Date(Date.now() + 2 * env.MT5_BRIDGE_MAX_SKEW_MS) });
    } catch {
      throw new AppError(401, 'Replayed request', 'BRIDGE_REPLAY');
    }
    this.stateOf(conn._id.toString()).lastSeenAt = Date.now();
    return conn;
  }

  /** Terminal identity. The first hello binds the MT5 login; later ones must match it exactly. */
  async hello(conn: BrokerConnectionDoc, b: Record<string, unknown>) {
    const login = clean(b.login);
    const tradeMode = String(b.tradeMode ?? '').toLowerCase(); // demo | real | contest
    const env_ = tradeMode === 'real' ? 'real' : tradeMode === 'demo' || tradeMode === 'contest' ? 'demo' : '';
    if (!login || !env_) throw new AppError(400, 'login and tradeMode are required', 'BRIDGE_HELLO');
    if (conn.accountId && conn.accountId !== login) {
      await this.fault(conn, `Terminal is logged in to a different account (${login.slice(-3)})`);
      throw new AppError(409, 'This terminal is registered for a different MT5 account', 'ACCOUNT_MISMATCH');
    }
    if (conn.environment !== env_) {
      await this.fault(conn, `Account is ${env_} but the connection was registered as ${conn.environment}`);
      throw new AppError(409, `Account type mismatch: connection is ${conn.environment}, terminal reports ${env_}`, 'ENVIRONMENT_MISMATCH');
    }
    const st = this.stateOf(conn._id.toString());
    st.hello = { login, server: clean(b.server), company: clean(b.company), currency: clean(b.currency), tradeMode: env_, leverage: Number(b.leverage) || undefined, name: clean(b.name), eaVersion: clean(b.eaVersion), at: Date.now() };
    if (b.terminalTime) st.terminalTimeSkewMs = Date.now() - Number(b.terminalTime);
    conn.accountId = login;
    conn.currency = st.hello.currency || conn.currency;
    conn.leverage = st.hello.leverage;
    conn.terminalInfo = { server: st.hello.server, company: st.hello.company, eaVersion: st.hello.eaVersion };
    if (conn.status !== 'CONNECTED') conn.recoveredAt = new Date();
    conn.status = 'CONNECTED';
    conn.lastHeartbeatAt = new Date();
    conn.lastError = undefined;
    await conn.save();
    this.events.emit('status', conn._id.toString(), true);
    return { ok: true, serverTime: Date.now(), pollMs: 1000, heartbeatMs: 5000 };
  }

  private async fault(conn: BrokerConnectionDoc, message: string) {
    conn.status = 'ERROR';
    conn.tradingEnabled = false;
    conn.liveEnabled = false;
    conn.breaker = { tripped: true, reason: message, at: new Date() };
    conn.lastError = message;
    conn.lastErrorAt = new Date();
    await conn.save();
    this.events.emit('fault', conn._id.toString(), message);
  }

  async heartbeat(conn: BrokerConnectionDoc, b: Record<string, unknown>) {
    const id = conn._id.toString();
    const st = this.stateOf(id);
    if (!st.hello) throw new AppError(409, 'Send /hello first', 'BRIDGE_HELLO_REQUIRED');
    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    st.account = { balance: n(b.balance), equity: n(b.equity), margin: n(b.margin), freeMargin: n(b.freeMargin), marginLevel: b.marginLevel !== undefined ? n(b.marginLevel) : undefined, currency: st.hello.currency, at: Date.now() };
    st.positions = ((b.positions as Mt5Position[]) ?? []).slice(0, 500).map((p) => ({ ...p, ticket: clean(p.ticket), symbol: clean(p.symbol), comment: clean(p.comment), volume: n(p.volume), priceOpen: n(p.priceOpen) }));
    st.orders = ((b.orders as Mt5Order[]) ?? []).slice(0, 500).map((o) => ({ ...o, ticket: clean(o.ticket), symbol: clean(o.symbol), comment: clean(o.comment), volume: n(o.volume), price: n(o.price) }));
    const deals = ((b.deals as Mt5Deal[]) ?? []).slice(0, 500).map((d) => ({ ...d, ticket: clean(d.ticket), positionId: d.positionId ? clean(d.positionId) : undefined, symbol: clean(d.symbol), comment: clean(d.comment) }));
    const known = new Set(st.deals.map((d) => d.ticket));
    st.deals = [...st.deals, ...deals.filter((d) => !known.has(d.ticket))].slice(-1000);
    await BrokerConnectionModel.updateOne({ _id: conn._id }, { $set: { lastHeartbeatAt: new Date(), balance: st.account.balance, equity: st.account.equity, margin: st.account.margin, freeMargin: st.account.freeMargin, marginLevel: st.account.marginLevel, status: 'CONNECTED' } });
    this.events.emit('heartbeat', id, st);
    return this.pendingCommands(id);
  }

  async symbols(conn: BrokerConnectionDoc, b: Record<string, unknown>) {
    const st = this.stateOf(conn._id.toString());
    for (const s of ((b.symbols as Mt5Symbol[]) ?? []).slice(0, 2000)) if (s?.name) st.symbols.set(clean(s.name), { ...s, name: clean(s.name) });
    this.events.emit('symbols', conn._id.toString(), st);
    return { ok: true, count: st.symbols.size };
  }

  quotes(conn: BrokerConnectionDoc, b: Record<string, unknown>) {
    const id = conn._id.toString();
    const st = this.stateOf(id);
    for (const q of ((b.quotes as { s: string; b: number; a: number; t?: number }[]) ?? []).slice(0, 500)) {
      if (!q?.s || !(Number(q.b) > 0) || !(Number(q.a) > 0)) continue;
      const quote = { bid: Number(q.b), ask: Number(q.a), time: Number(q.t) || Date.now() };
      st.quotes.set(clean(q.s), quote);
      this.events.emit('quote', id, clean(q.s), quote);
    }
    return { ok: true };
  }

  /** Execution reports: the first report per command wins; duplicates are acknowledged and ignored. */
  async reports(conn: BrokerConnectionDoc, b: Record<string, unknown>) {
    const acks: string[] = [];
    for (const r of ((b.reports as Mt5Report[]) ?? []).slice(0, 200)) {
      if (!r?.commandId) continue;
      const done = ['filled', 'placed', 'done'].includes(r.status);
      const updated = await Mt5CommandModel.findOneAndUpdate({ connection: conn._id, commandId: r.commandId, reportedAt: null }, { $set: { report: r, reportedAt: new Date(), status: done ? 'DONE' : r.status === 'expired' ? 'EXPIRED' : 'FAILED' } }, { returnDocument: 'after' });
      acks.push(r.commandId);
      if (!updated) continue; // duplicate or unknown
      this.waiters.get(r.commandId)?.(r);
      this.waiters.delete(r.commandId);
      this.events.emit('report', conn._id.toString(), r);
    }
    return { ok: true, acks };
  }

  /** Queue a command for the terminal and wait (bounded) for its execution report. */
  async enqueue(connectionId: string, type: 'order.place' | 'order.cancel' | 'order.modify' | 'position.close', params: Record<string, unknown>, deadlineMs: number, waitExtraMs = 5_000): Promise<Mt5Report | null> {
    const commandId = `C${crypto.randomBytes(10).toString('hex')}`; // fits the 31-char MT5 comment
    await Mt5CommandModel.create({ connection: connectionId, commandId, type, params, deadline: new Date(Date.now() + deadlineMs) });
    return this.await(commandId, deadlineMs + waitExtraMs);
  }

  await(commandId: string, timeoutMs: number): Promise<Mt5Report | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(commandId);
        resolve(null);
      }, timeoutMs);
      t.unref?.();
      this.waiters.set(commandId, (r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
  }

  /** Commands for the terminal as text lines; expired undelivered commands are never sent. */
  async pendingCommands(connectionId: string): Promise<string> {
    const now = new Date();
    await Mt5CommandModel.updateMany({ connection: connectionId, status: 'QUEUED', deadline: { $lte: now } }, { $set: { status: 'EXPIRED' } });
    const list = await Mt5CommandModel.find({ connection: connectionId, status: { $in: ['QUEUED', 'DELIVERED'] }, deadline: { $gt: now } }).sort({ createdAt: 1 }).limit(20);
    const lines: string[] = [];
    for (const c of list) {
      const p = c.params as Record<string, unknown>;
      lines.push(['CMD', c.commandId, c.type, p.symbol, p.side, p.orderType, p.volume, p.price, p.sl, p.tp, p.ticket, Math.floor(c.deadline.getTime() / 1000)].map(clean).join('|'));
      if (c.status === 'QUEUED') {
        c.status = 'DELIVERED';
        c.deliveredAt = now;
        await c.save();
      }
    }
    return lines.join('\n');
  }

  /** Report a command lookup (e.g. after a server restart). */
  async commandReport(commandId: string) {
    const c = await Mt5CommandModel.findOne({ commandId }).lean();
    return c ? { status: c.status, report: c.report as Mt5Report | undefined, params: c.params as Record<string, unknown> } : null;
  }
}

export const mt5Bridge = new Mt5BridgeService();
