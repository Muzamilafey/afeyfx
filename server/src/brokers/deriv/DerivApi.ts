import WebSocket from 'ws';
import { errorMessage, logger } from '../../utils/logger';
import { WithdrawalForbiddenError } from '../../utils/errors';
import { BrokerError, type BrokerErrorKind } from '../core/types';

/**
 * Clients for the current Deriv API (developers.deriv.com):
 *  - REST  https://api.derivws.com/trading/v1/  (Bearer token; PATs also send Deriv-App-ID)
 *      GET  options/accounts                  → data[]: account_id, balance, currency, account_type (demo|real), status
 *      POST options/accounts/{id}/otp         → data.url: wss://…/options/ws/{demo|real}?otp=… (single use, 120 s)
 *  - WebSocket opened with that one-time URL; requests correlated by req_id; ping keeps it alive.
 *    The public socket (…/options/ws/public) serves market data without authentication.
 *
 * Every outgoing WebSocket request passes an allow-list: cashier, transfer, payment-agent and P2P
 * calls cannot be sent through this integration.
 */
export const DERIV_DEFAULT_API_BASE = 'https://api.derivws.com/trading/v1/';
export const DERIV_WS_ALLOWED = new Set(['ping', 'time', 'balance', 'active_symbols', 'contracts_for', 'ticks', 'ticks_history', 'forget', 'forget_all', 'proposal', 'buy', 'sell', 'proposal_open_contract', 'portfolio', 'statement', 'profit_table']);
const FORBIDDEN_KEY = /withdraw|transfer|cashier|payment|paymentagent|p2p|topup|deposit/i;

export function assertAllowedDerivRequest(msg: Record<string, unknown>) {
  const type = Object.keys(msg)[0];
  if (!DERIV_WS_ALLOWED.has(type) || Object.keys(msg).some((k) => FORBIDDEN_KEY.test(k))) throw new WithdrawalForbiddenError(`Deriv API call "${type}"`);
}

/**
 * Funding sessions (separate, opt-in `payments` authorization; never used by the trading engine):
 * balances, statements, transfers between the user's OWN Deriv accounts/wallets and the official
 * cashier deposit link. Withdrawals are never started through the API (Deriv's own cashier page,
 * with its email verification, is used instead). Payment-agent and P2P calls are impossible.
 */
export const DERIV_FUNDING_ALLOWED = new Set(['ping', 'balance', 'statement', 'transfer_between_accounts', 'cashier']);
const FUNDING_FORBIDDEN_KEY = /paymentagent|payment_agent|p2p|verification_code|address|dry_run|estimated_fee/i;
export function assertAllowedFundingRequest(msg: Record<string, unknown>) {
  const type = Object.keys(msg)[0];
  if (!DERIV_FUNDING_ALLOWED.has(type) || Object.keys(msg).some((k) => FUNDING_FORBIDDEN_KEY.test(k))) throw new WithdrawalForbiddenError(`Deriv funding call "${type}"`);
  if (type === 'cashier' && msg.cashier !== 'deposit') throw new WithdrawalForbiddenError('Withdrawals are made on Deriv\'s own cashier page');
}

/** Map a Deriv error code to a normalized kind. */
export function derivErrorKind(code?: string): BrokerErrorKind {
  const c = String(code ?? '');
  if (/InvalidToken|AuthorizationRequired|PermissionDenied|InvalidAppID|Unauthori[sz]ed/i.test(c)) return 'auth';
  if (/TokenExpired|Expired.*Token/i.test(c)) return 'auth_expired';
  if (/RateLimit|TooManyRequests/i.test(c)) return 'rate_limited';
  if (/InsufficientBalance/i.test(c)) return 'insufficient_funds';
  if (/MarketIsClosed|TradingDisabled|SymbolMissing|NotOffered/i.test(c)) return 'market_closed';
  if (/InputValidationFailed|ContractValidation|OfferingsValidation|InvalidContractProposal|ContractCreationFailure|PriceMoved|InvalidSymbol|BuyValidation/i.test(c)) return 'invalid_request';
  return 'rejected';
}

export interface DerivAccount {
  account_id: string;
  balance: string | number;
  currency: string;
  account_type: 'demo' | 'real' | string;
  status?: string;
  group?: string;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers?: { get(n: string): string | null }; json(): Promise<unknown> }>;
let fetchImpl: FetchFn = (url, init) => fetch(url, init) as never;
export function setDerivFetch(f: FetchFn | null) {
  fetchImpl = f ?? ((url, init) => fetch(url, init) as never);
}

export class DerivRest {
  constructor(
    private token: string,
    private tokenType: 'oauth' | 'pat',
    private appId?: string,
    private base = DERIV_DEFAULT_API_BASE,
  ) {}

  private async call(method: string, path: string) {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    if (this.tokenType === 'pat') {
      if (!this.appId) throw new BrokerError('auth', 'A Deriv App ID is required with a Personal Access Token');
      headers['Deriv-App-ID'] = this.appId;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    let r;
    try {
      r = await fetchImpl(`${this.base.replace(/\/?$/, '/')}${path}`, { method, headers, signal: ctl.signal });
    } catch (err) {
      throw new BrokerError('disconnected', `Deriv API unreachable: ${errorMessage(err)}`);
    } finally {
      clearTimeout(t);
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 401) throw new BrokerError('auth_expired', 'Deriv authorization expired or was revoked');
    if (r.status === 403) throw new BrokerError('auth', 'Deriv refused access (check token scopes / App ID)');
    if (r.status === 429) throw new BrokerError('rate_limited', 'Deriv rate limit reached', undefined, Number(r.headers?.get('retry-after') ?? 10) * 1000);
    if (!r.ok) {
      const e = (body.errors as { code?: string; message?: string }[] | undefined)?.[0] ?? (body.error as { code?: string; message?: string } | undefined);
      throw new BrokerError(r.status >= 500 ? 'disconnected' : derivErrorKind(e?.code), e?.message ?? `Deriv HTTP ${r.status}`, { status: r.status, code: e?.code });
    }
    return body;
  }

  async listAccounts(): Promise<DerivAccount[]> {
    const b = await this.call('GET', 'options/accounts');
    return ((b.data ?? []) as DerivAccount[]).filter((a) => a && a.account_id);
  }

  /** One-time WebSocket URL for an account (valid 120 s, single use). */
  async otpUrl(accountId: string): Promise<string> {
    const b = await this.call('POST', `options/accounts/${encodeURIComponent(accountId)}/otp`);
    const url = (b.data as { url?: string } | undefined)?.url;
    if (!url || !/^wss:\/\//.test(url)) throw new BrokerError('rejected', 'Deriv did not return a WebSocket URL');
    return url;
  }
}

/** Minimal socket surface (the `ws` package, or a fake in tests). */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(ev: 'open' | 'message' | 'close' | 'error', fn: (...a: unknown[]) => void): unknown;
  removeAllListeners?(): void;
}
export type WsFactory = (url: string) => WsLike;
let wsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;
export function setDerivWsFactory(f: WsFactory | null) {
  wsFactory = f ?? ((url) => new WebSocket(url) as unknown as WsLike);
}

type Msg = Record<string, unknown>;

/**
 * Authenticated Deriv WebSocket session: fresh OTP URL on every (re)connect, req_id correlation,
 * per-request timeouts, ping heartbeat, staleness watchdog, bounded reconnects (5 attempts, then
 * the session is reset and reported), and automatic re-subscription after a reconnect.
 */
export class DerivSocket {
  private ws?: WsLike;
  private ready?: Promise<void>;
  private reqId = 1;
  private pending = new Map<number, { resolve(v: Msg): void; reject(e: Error): void; timer: NodeJS.Timeout; sentAt: number }>();
  private subs = new Map<string, Msg>(); // key → subscribe request (re-sent after reconnect)
  private timers: NodeJS.Timeout[] = [];
  private attempts = 0;
  private closedByUser = false;
  lastMessageAt = 0;
  latencyMs: number | null = null;
  rateLimitedUntil = 0;
  connected = false;

  constructor(
    private url: () => Promise<string>,
    private onStream: (m: Msg) => void,
    private onStatus: (connected: boolean, info?: string) => void,
    private opts = { requestTimeoutMs: 15_000, pingMs: 30_000, staleMs: 90_000, maxAttempts: 5 },
    /** Which requests this socket may send (trading sessions: no payment calls at all). */
    private guard: (msg: Msg) => void = assertAllowedDerivRequest,
  ) {}

  open() {
    this.closedByUser = false;
    this.ready ??= this.connectOnce();
    return this.ready;
  }

  private async connectOnce(): Promise<void> {
    const url = await this.url();
    await new Promise<void>((resolve, reject) => {
      const ws = wsFactory(url);
      this.ws = ws;
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.connected = true;
        this.attempts = 0;
        this.lastMessageAt = Date.now();
        this.onStatus(true);
        this.startTimers();
        for (const m of this.subs.values()) this.rawSend(m).catch((err) => logger.warn({ err: errorMessage(err) }, 'Deriv resubscribe failed'));
        resolve();
      });
      ws.on('message', (data: unknown) => this.handle(String(data)));
      ws.on('error', (err: unknown) => {
        if (!opened) reject(new BrokerError('disconnected', `Deriv WebSocket error: ${errorMessage(err)}`));
      });
      ws.on('close', () => {
        this.connected = false;
        this.stopTimers();
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new BrokerError('ambiguous', 'Deriv connection closed before a response'));
        }
        this.pending.clear();
        this.ready = undefined;
        if (!opened) return reject(new BrokerError('disconnected', 'Deriv WebSocket closed during connect'));
        this.onStatus(false, 'closed');
        if (!this.closedByUser) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect() {
    if (this.attempts >= this.opts.maxAttempts) {
      this.onStatus(false, `gave up after ${this.attempts} reconnect attempts`);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** this.attempts++) * (0.8 + Math.random() * 0.4);
    const t = setTimeout(() => {
      this.ready = this.connectOnce().catch((err) => {
        this.ready = undefined;
        this.onStatus(false, errorMessage(err));
        this.scheduleReconnect();
      });
    }, delay);
    t.unref?.();
  }

  private startTimers() {
    this.stopTimers();
    const ping = setInterval(() => void this.request({ ping: 1 }).catch(() => undefined), this.opts.pingMs);
    const watchdog = setInterval(() => {
      if (Date.now() - this.lastMessageAt > this.opts.staleMs) {
        logger.warn({ component: 'deriv' }, 'Deriv socket stale; reconnecting');
        this.ws?.close();
      }
    }, 10_000);
    ping.unref?.();
    watchdog.unref?.();
    this.timers.push(ping, watchdog);
  }

  private stopTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private handle(raw: string) {
    this.lastMessageAt = Date.now();
    let m: Msg;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const id = Number(m.req_id);
    const p = this.pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.latencyMs = Date.now() - p.sentAt;
      p.resolve(m);
      // The first message of a subscription is also a stream update.
      if (m.subscription) this.onStream(m);
      return;
    }
    this.onStream(m);
  }

  private rawSend(msg: Msg): Promise<Msg> {
    this.guard(msg);
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new BrokerError('disconnected', 'Deriv socket not connected'));
      const id = this.reqId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrokerError('ambiguous', `Deriv request "${Object.keys(msg)[0]}" timed out`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, sentAt: Date.now() });
      this.ws.send(JSON.stringify({ ...msg, req_id: id }));
    });
  }

  /** Send a request and return the response; Deriv errors become BrokerError. */
  async request(msg: Msg): Promise<Msg> {
    if (Date.now() < this.rateLimitedUntil) throw new BrokerError('rate_limited', 'Deriv rate limit cool-down', undefined, this.rateLimitedUntil - Date.now());
    await this.open();
    const r = await this.rawSend(msg);
    const e = r.error as { code?: string; message?: string } | undefined;
    if (e) {
      const kind = derivErrorKind(e.code);
      if (kind === 'rate_limited') this.rateLimitedUntil = Date.now() + 15_000;
      throw new BrokerError(kind, e.message ?? e.code ?? 'Deriv error', { code: e.code, msg_type: r.msg_type });
    }
    return r;
  }

  /** Subscribe (and remember the subscription so it survives reconnects). */
  async subscribe(key: string, msg: Msg) {
    const m = { ...msg, subscribe: 1 };
    this.subs.set(key, m);
    try {
      return await this.request(m);
    } catch (err) {
      this.subs.delete(key);
      throw err;
    }
  }

  async unsubscribe(key: string, subscriptionId?: string) {
    this.subs.delete(key);
    if (subscriptionId && this.connected) await this.request({ forget: subscriptionId }).catch(() => undefined);
  }

  close() {
    this.closedByUser = true;
    this.subs.clear();
    this.stopTimers();
    this.ws?.close();
    this.ws = undefined;
    this.ready = undefined;
    this.connected = false;
  }
}
