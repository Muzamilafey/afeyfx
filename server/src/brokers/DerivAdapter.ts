import WebSocket from 'ws';
import { WithdrawalForbiddenError } from '../utils/errors';
import { logger, errorMessage } from '../utils/logger';
import { BrokerAmbiguousError, type BrokerAdapter, type BrokerCloseResult, type BrokerFill, type BrokerOpenRequest, type BrokerPositionStatus, type BrokerTestResult } from './types';

/**
 * Deriv (deriv.com) adapter over the Deriv WebSocket API, using Multiplier contracts
 * (MULTUP = buy/long, MULTDOWN = sell/short) with broker-side stop loss / take profit.
 *
 * Sizing: exposure = stake x multiplier, so stake = investment / multiplier. Deriv expresses the
 * stop loss / take profit as amounts in account currency, derived from the requested prices.
 * Only the request types in ALLOWED can ever be sent: cashier, transfer and payment-agent calls
 * are impossible through this adapter.
 */
const FORBIDDEN = /withdraw|transfer|cashier|payment|paymentagent|p2p|topup/i;
export const DERIV_ALLOWED = new Set(['authorize', 'proposal', 'buy', 'sell', 'proposal_open_contract', 'portfolio', 'balance', 'ping', 'active_symbols']);

export interface DerivConfig {
  appId: string;
  token: string;
  currency: string;
  multipliers: { crypto: number; forex: number; metals: number };
  endpoint?: string;
}

export type DerivTransport = (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;

const CRYPTO = new Set(['BTC', 'ETH', 'LTC', 'BCH', 'XRP', 'DOGE', 'SOL', 'ADA', 'BNB', 'DOT', 'LINK', 'AVAX', 'TRX', 'UNI', 'XLM', 'ATOM', 'NEAR', 'TON']);

export function derivSymbol(symbol: string): string | null {
  const [b, q] = symbol.split('/');
  if (!b || !q) return null;
  if (CRYPTO.has(b) && (q === 'USDT' || q === 'USD')) return `cry${b}USD`;
  if (/^[A-Z]{3}$/.test(b) && /^[A-Z]{3}$/.test(q)) return `frx${b}${q}`;
  return null;
}

const category = (symbol: string) => (derivSymbol(symbol)?.startsWith('cry') ? 'crypto' : symbol.startsWith('X') ? 'metals' : 'forex');

/** Persistent, authorized Deriv WebSocket connection with request/response correlation. */
class DerivConnection {
  private ws?: WebSocket;
  private ready?: Promise<void>;
  private reqId = 1;
  private pending = new Map<number, { resolve(v: Record<string, unknown>): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private keepalive?: NodeJS.Timeout;

  constructor(private cfg: DerivConfig) {}

  private connect() {
    this.ready ??= new Promise<void>((resolve, reject) => {
      const url = `${this.cfg.endpoint ?? 'wss://ws.derivws.com/websockets/v3'}?app_id=${encodeURIComponent(this.cfg.appId)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      const fail = (e: Error) => {
        this.ready = undefined;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new BrokerAmbiguousError(`Deriv connection lost: ${e.message}`));
        }
        this.pending.clear();
        clearInterval(this.keepalive);
      };
      ws.on('open', async () => {
        try {
          const a = await this.raw({ authorize: this.cfg.token });
          if (a.error) throw new Error(String((a.error as { message?: string }).message ?? 'authorize failed'));
          this.keepalive = setInterval(() => void this.raw({ ping: 1 }).catch(() => undefined), 30_000);
          resolve();
        } catch (err) {
          reject(err as Error);
          ws.close();
        }
      });
      ws.on('message', (buf) => {
        try {
          const m = JSON.parse(buf.toString()) as Record<string, unknown>;
          const id = Number(m.req_id);
          const p = this.pending.get(id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.resolve(m);
        } catch (err) {
          logger.warn({ err: errorMessage(err) }, 'Bad Deriv message');
        }
      });
      ws.on('error', (err) => fail(err));
      ws.on('close', () => fail(new Error('closed')));
    });
    return this.ready;
  }

  private raw(msg: Record<string, unknown>, timeoutMs = 15_000) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = this.reqId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrokerAmbiguousError('Deriv request timed out'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ ...msg, req_id: id }));
    });
  }

  async send(msg: Record<string, unknown>) {
    await this.connect();
    return this.raw(msg);
  }

  close() {
    clearInterval(this.keepalive);
    this.ws?.close();
    this.ready = undefined;
  }
}

export class DerivAdapter implements BrokerAdapter {
  readonly id = 'deriv' as const;
  readonly name = 'Deriv';
  private conn?: DerivConnection;

  constructor(
    private cfg: DerivConfig,
    private transport?: DerivTransport,
  ) {}

  configured() {
    return !!this.cfg.appId && !!this.cfg.token;
  }

  supports(symbol: string) {
    return !!derivSymbol(symbol);
  }

  /** Every outgoing request passes the allow-list. */
  private async call(msg: Record<string, unknown>) {
    // The request type is the first key of every Deriv request.
    const type = Object.keys(msg)[0];
    if (!DERIV_ALLOWED.has(type) || Object.keys(msg).some((k) => FORBIDDEN.test(k))) throw new WithdrawalForbiddenError(`Deriv API call "${type}"`);
    if (this.transport) return this.transport(msg);
    this.conn ??= new DerivConnection(this.cfg);
    return this.conn.send(msg);
  }

  private err(r: Record<string, unknown>) {
    const e = r.error as { message?: string; code?: string } | undefined;
    return e ? `${e.code ?? 'Error'}: ${e.message ?? 'Deriv error'}` : null;
  }

  async open(req: BrokerOpenRequest): Promise<BrokerFill> {
    const sym = derivSymbol(req.symbol);
    if (!sym) return { status: 'REJECTED', rejectReason: `${req.symbol} is not available on Deriv` };
    const multiplier = this.cfg.multipliers[category(req.symbol)];
    const stake = Math.floor((req.investmentUsd / multiplier) * 100) / 100;
    if (stake < 1) return { status: 'REJECTED', rejectReason: `Investment too small for Deriv (minimum stake $1 at x${multiplier})` };
    const limit: Record<string, number> = {};
    // Prices -> amounts: P&L of a multiplier = stake x multiplier x relative price move = investment x move.
    if (req.stopLoss) limit.stop_loss = Math.min(stake, Math.max(0.01, Math.round(req.investmentUsd * (Math.abs(req.price - req.stopLoss) / req.price) * 100) / 100));
    if (req.takeProfit) limit.take_profit = Math.max(0.01, Math.round(req.investmentUsd * (Math.abs(req.takeProfit - req.price) / req.price) * 100) / 100);
    const proposal = await this.call({ proposal: 1, amount: stake, basis: 'stake', contract_type: req.direction === 'LONG' ? 'MULTUP' : 'MULTDOWN', currency: this.cfg.currency, symbol: sym, multiplier, ...(Object.keys(limit).length ? { limit_order: limit } : {}) });
    const pErr = this.err(proposal);
    if (pErr) return { status: 'REJECTED', rejectReason: pErr, raw: proposal };
    const pid = (proposal.proposal as { id?: string })?.id;
    if (!pid) return { status: 'REJECTED', rejectReason: 'No proposal from Deriv', raw: proposal };
    const bought = await this.call({ buy: pid, price: stake, passthrough: { ref: req.clientRef } });
    const bErr = this.err(bought);
    if (bErr) return { status: 'REJECTED', rejectReason: bErr, raw: bought };
    const b = bought.buy as { contract_id: number; buy_price: number; start_time?: number };
    const st = await this.status(String(b.contract_id)).catch(() => null);
    const entry = Number((st?.raw as { entry_spot?: number } | undefined)?.entry_spot) || Number((proposal.proposal as { spot?: number })?.spot) || req.price;
    return { status: 'FILLED', brokerRef: String(b.contract_id), price: entry, units: req.investmentUsd / entry, feeUsd: 0, raw: { contract_id: b.contract_id, buy_price: b.buy_price, multiplier, stake } };
  }

  async close(brokerRef: string): Promise<BrokerCloseResult> {
    const r = await this.call({ sell: Number(brokerRef), price: 0 });
    const e = this.err(r);
    if (e) {
      // Already closed at the broker (stop loss / take profit / stop out): read the final result.
      const st = await this.status(brokerRef);
      if (!st.open) return { status: 'CLOSED', pnlUsd: st.pnlUsd, price: st.closePrice, raw: st.raw };
      return { status: 'REJECTED', rejectReason: e, raw: r };
    }
    const st = await this.status(brokerRef).catch(() => null);
    const sold = r.sell as { sold_for: number };
    const buyPrice = Number((st?.raw as { buy_price?: number } | undefined)?.buy_price);
    return { status: 'CLOSED', pnlUsd: st?.pnlUsd ?? (Number.isFinite(buyPrice) ? sold.sold_for - buyPrice : undefined), price: st?.closePrice, raw: r };
  }

  async status(brokerRef: string): Promise<BrokerPositionStatus> {
    const r = await this.call({ proposal_open_contract: 1, contract_id: Number(brokerRef) });
    const e = this.err(r);
    if (e) throw new BrokerAmbiguousError(e);
    const c = (r.proposal_open_contract ?? {}) as { is_sold?: number; profit?: number; exit_tick?: number; current_spot?: number; status?: string };
    const open = !c.is_sold && c.status !== 'sold' && c.status !== 'won' && c.status !== 'lost';
    return { open, pnlUsd: c.profit !== undefined ? Number(c.profit) : undefined, closePrice: open ? undefined : Number(c.exit_tick ?? c.current_spot), raw: c };
  }

  async lookup(_clientRef: string, req: BrokerOpenRequest, since: number): Promise<BrokerFill | null> {
    // Deriv has no client order ids: adopt a contract on this symbol/side bought since the attempt.
    const r = await this.call({ portfolio: 1 });
    const sym = derivSymbol(req.symbol);
    const type = req.direction === 'LONG' ? 'MULTUP' : 'MULTDOWN';
    const c = ((r.portfolio as { contracts?: { contract_id: number; contract_type: string; symbol: string; purchase_time: number; buy_price: number }[] })?.contracts ?? []).find((x) => x.symbol === sym && x.contract_type === type && x.purchase_time * 1000 >= since - 5_000);
    if (!c) return null;
    return { status: 'FILLED', brokerRef: String(c.contract_id), price: req.price, units: req.units, feeUsd: 0, raw: c };
  }

  async openRefs() {
    const r = await this.call({ portfolio: 1 });
    return ((r.portfolio as { contracts?: { contract_id: number; contract_type: string }[] })?.contracts ?? []).filter((c) => c.contract_type.startsWith('MULT')).map((c) => String(c.contract_id));
  }

  async test(): Promise<BrokerTestResult> {
    try {
      const r = await this.call({ balance: 1 });
      const e = this.err(r);
      if (e) return { ok: false, message: e };
      const b = r.balance as { balance: number; currency: string; loginid: string };
      return { ok: true, message: `Connected to Deriv account ${b.loginid}`, balance: b.balance, currency: b.currency, account: b.loginid, demo: /^VR/.test(b.loginid) };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  dispose() {
    this.conn?.close();
  }
}
