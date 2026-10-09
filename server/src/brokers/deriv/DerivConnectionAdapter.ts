import { EventEmitter } from 'events';
import { capabilitySet } from '../core/capabilities';
import { BrokerError, BrokerUnsupportedError, type AccountEnvironment, type BrokerAccountInfo, type BrokerAdapter, type BrokerCandle, type BrokerHealth, type BrokerOpenOrder, type BrokerOrderRequest, type BrokerOrderResult, type BrokerPosition, type BrokerStreamEvent, type BrokerTransaction, type ClosedPositionResult, type InstrumentSpec, type Side } from '../core/types';
import { DerivRest, DerivSocket, assertAllowedDerivRequest, derivErrorKind } from './DerivApi';

/**
 * Deriv adapter for ONE Deriv account (demo or real), on the current Deriv API.
 *
 * Products (each with its own lifecycle; nothing is treated as a plain forex market order):
 *  - Multipliers (MULTUP = buy, MULTDOWN = sell): stake × multiplier exposure, optional
 *    broker-side stop loss / take profit expressed as AMOUNTS; open until sold, stopped or stopped out.
 *  - Rise/Fall (CALL / PUT): stake for a fixed duration; settles automatically at expiry.
 *
 * Every purchase is verified with proposal_open_contract before it is reported as filled, and
 * open contracts are streamed so settlements (expiry, stop loss, take profit, stop-out) are
 * reported with the broker's own profit figure.
 */
export interface DerivAdapterConfig {
  accountId: string;
  environment: AccountEnvironment;
  token: string;
  tokenType: 'oauth' | 'pat';
  appId?: string;
  apiBase?: string;
}

/** Test hook: replace the socket with a request function. */
export type DerivRpc = (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;

const CRYPTO = new Set(['BTC', 'ETH', 'LTC', 'BCH', 'XRP', 'DOGE', 'SOL', 'ADA', 'BNB', 'DOT', 'LINK', 'AVAX', 'TRX', 'UNI', 'XLM', 'ATOM', 'NEAR', 'TON']);

/** Normalized symbol → Deriv underlying (EUR/USD → frxEURUSD, BTC/USDT → cryBTCUSD). Native Deriv symbols pass through. */
export function toDerivSymbol(symbol: string): string {
  if (!symbol.includes('/')) return symbol;
  const [b, q] = symbol.split('/');
  if (CRYPTO.has(b) && (q === 'USDT' || q === 'USD')) return `cry${b}USD`;
  return `frx${b}${q}`;
}

export function fromDerivSymbol(s: string): string {
  const m = /^frx([A-Z]{3})([A-Z]{3})$/.exec(s) ?? /^cry([A-Z]{2,5})(USD)$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : s;
}

const sideOf = (contractType: string): Side => (/^(MULTUP|CALL|CALLE)$/.test(contractType) ? 'buy' : 'sell');
const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));

export class DerivConnectionAdapter implements BrokerAdapter {
  readonly provider = 'deriv' as const;
  readonly capabilities = capabilitySet('deriv');
  private rest: DerivRest;
  private socket?: DerivSocket;
  private events = new EventEmitter();
  private contracts = new Map<string, Record<string, unknown>>(); // latest proposal_open_contract per id
  private tickSubs = new Map<string, string>(); // symbol → subscription id
  private pocSubs = new Map<string, string>(); // contract id → subscription id
  private lastError?: string;

  constructor(
    private cfg: DerivAdapterConfig,
    private rpc?: DerivRpc,
  ) {
    this.rest = new DerivRest(cfg.token, cfg.tokenType, cfg.appId, cfg.apiBase);
  }

  // ------------------------------------------------------------ plumbing

  private emit(e: BrokerStreamEvent) {
    this.events.emit('event', e);
  }

  onEvent(listener: (e: BrokerStreamEvent) => void) {
    this.events.on('event', listener);
    return () => void this.events.off('event', listener);
  }

  private async send(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.rpc) {
      assertAllowedDerivRequest(msg);
      const r = await this.rpc(msg);
      const e = r.error as { code?: string; message?: string } | undefined;
      if (e) throw new BrokerError(derivErrorKind(e.code), e.message ?? e.code ?? 'Deriv error', { code: e.code });
      return r;
    }
    if (!this.socket) throw new BrokerError('disconnected', 'Not connected to Deriv');
    return this.socket.request(msg);
  }

  private async subscribe(key: string, msg: Record<string, unknown>) {
    if (this.rpc) return this.send({ ...msg, subscribe: 1 });
    if (!this.socket) throw new BrokerError('disconnected', 'Not connected to Deriv');
    return this.socket.subscribe(key, msg);
  }

  /** Handle streamed messages (ticks, open-contract updates). Exposed for tests. */
  handleStream(m: Record<string, unknown>) {
    if (m.msg_type === 'tick' && m.tick) {
      const t = m.tick as { symbol?: string; underlying_symbol?: string; quote: number; bid?: number; ask?: number; epoch: number };
      const s = String(t.symbol ?? t.underlying_symbol ?? '');
      const subId = (m.subscription as { id?: string } | undefined)?.id;
      if (subId && s) this.tickSubs.set(s, subId);
      this.emit({ type: 'quote', quote: { brokerSymbol: s, symbol: fromDerivSymbol(s), bid: Number(t.bid ?? t.quote), ask: Number(t.ask ?? t.quote), last: Number(t.quote), timestamp: Number(t.epoch) * 1000 } });
    } else if (m.msg_type === 'proposal_open_contract' && m.proposal_open_contract) {
      const c = m.proposal_open_contract as Record<string, unknown>;
      const id = String(c.contract_id ?? '');
      if (!id) return;
      const subId = (m.subscription as { id?: string } | undefined)?.id;
      if (subId) this.pocSubs.set(id, subId);
      this.contracts.set(id, c);
      const closed = this.closedResult(c);
      if (closed) {
        this.emit({ type: 'position-closed', result: closed });
        const sid = this.pocSubs.get(id);
        this.pocSubs.delete(id);
        if (sid && this.socket) void this.socket.unsubscribe(`poc:${id}`, sid);
      } else this.emit({ type: 'position-update', position: this.positionOf(c) });
    } else if (m.msg_type === 'balance' && m.balance) {
      void this.getAccount().then((a) => this.emit({ type: 'account', account: a }), () => undefined);
    }
  }

  private closedResult(c: Record<string, unknown>): ClosedPositionResult | null {
    const sold = c.is_sold === 1 || c.is_sold === true || c.status === 'sold' || c.status === 'won' || c.status === 'lost' || (c.is_expired === 1 && c.is_settleable === 1);
    if (!sold) return null;
    return {
      brokerPositionId: String(c.contract_id),
      closed: true,
      realizedPnl: num(c.profit),
      exitPrice: num(c.exit_tick ?? c.sell_spot ?? c.current_spot),
      closedAt: num(c.sell_time ?? c.date_expiry) !== undefined ? Number(c.sell_time ?? c.date_expiry) * 1000 : Date.now(),
      reason: c.status === 'won' || c.status === 'lost' ? `Settled (${String(c.status)})` : 'Sold',
      raw: { status: c.status, profit: c.profit, buy_price: c.buy_price, sell_price: c.sell_price },
    };
  }

  private positionOf(c: Record<string, unknown>): BrokerPosition {
    const type = String(c.contract_type ?? '');
    const sym = String(c.underlying_symbol ?? c.underlying ?? c.symbol ?? '');
    const limit = (c.limit_order ?? {}) as { stop_loss?: { order_amount?: number }; take_profit?: { order_amount?: number } };
    return {
      brokerPositionId: String(c.contract_id),
      brokerSymbol: sym,
      symbol: fromDerivSymbol(sym),
      side: sideOf(type),
      volume: Number(c.buy_price ?? 0),
      entryPrice: Number(c.entry_spot ?? c.entry_tick ?? 0),
      currentPrice: num(c.current_spot),
      unrealizedPnl: num(c.profit),
      openedAt: num(c.purchase_time) !== undefined ? Number(c.purchase_time) * 1000 : undefined,
      expiresAt: num(c.date_expiry) !== undefined && !/^MULT/.test(type) ? Number(c.date_expiry) * 1000 : undefined,
      product: /^MULT/.test(type) ? 'multiplier' : 'rise_fall',
      raw: { contract_type: type, stop_loss_amount: limit.stop_loss?.order_amount, take_profit_amount: limit.take_profit?.order_amount, bid_price: c.bid_price, is_valid_to_sell: c.is_valid_to_sell },
    };
  }

  // ------------------------------------------------------------ lifecycle

  async connect() {
    if (this.rpc) return;
    // Verify the account exists and is still the expected type BEFORE opening a session.
    const acct = await this.findAccount();
    if (acct.account_type !== this.cfg.environment) throw new BrokerError('environment_mismatch', `Deriv account ${this.cfg.accountId} is ${acct.account_type}, expected ${this.cfg.environment}`);
    this.socket ??= new DerivSocket(
      async () => {
        const url = await this.rest.otpUrl(this.cfg.accountId);
        // The OTP URL encodes the account type (…/ws/demo or …/ws/real): never silently cross over.
        const seg = /\/ws\/(demo|real)\b/.exec(url)?.[1];
        if (seg && seg !== this.cfg.environment) throw new BrokerError('environment_mismatch', `Deriv issued a ${seg} session for a ${this.cfg.environment} connection`);
        return url;
      },
      (m) => this.handleStream(m),
      (connected, info) => {
        if (!connected && info) this.lastError = info;
        this.emit({ type: 'status', connected, info });
      },
    );
    await this.socket.open();
  }

  async disconnect() {
    this.socket?.close();
    this.socket = undefined;
    this.tickSubs.clear();
    this.pocSubs.clear();
  }

  private async findAccount() {
    const list = await this.rest.listAccounts();
    const a = list.find((x) => String(x.account_id) === this.cfg.accountId);
    if (!a) throw new BrokerError('auth', `Deriv account ${this.cfg.accountId} is not available to this authorization`);
    return a;
  }

  async validateAccess(): Promise<BrokerAccountInfo> {
    if (!this.rpc) {
      const a = await this.findAccount();
      if (a.account_type !== this.cfg.environment) throw new BrokerError('environment_mismatch', `Deriv account is ${a.account_type}, expected ${this.cfg.environment}`);
    }
    return this.getAccount();
  }

  async getAccount(): Promise<BrokerAccountInfo> {
    const r = await this.send({ balance: 1 });
    const b = (r.balance ?? {}) as { balance?: number; currency?: string; loginid?: string };
    const balance = Number(b.balance ?? 0);
    // Equity = balance + current value of open contracts (their bid price).
    let openValue = 0;
    for (const c of this.contracts.values()) if (!this.closedResult(c)) openValue += Number(c.bid_price ?? 0);
    return { accountId: this.cfg.accountId, environment: this.cfg.environment, currency: String(b.currency ?? ''), balance, equity: balance + openValue, margin: null, freeMargin: null, marginLevel: null, leverage: null, raw: { loginid: b.loginid } };
  }

  async getInstruments(): Promise<InstrumentSpec[]> {
    const r = await this.send({ active_symbols: 'brief' });
    const list = (r.active_symbols ?? []) as Record<string, unknown>[];
    return list.map((s) => {
      const sym = String(s.underlying_symbol ?? s.symbol ?? '');
      const market = String(s.market ?? '');
      const category: InstrumentSpec['category'] = market === 'forex' ? 'forex' : market === 'cryptocurrency' ? 'crypto' : market === 'commodities' ? (/XA[UG]|XP[TD]/.test(sym) ? 'metals' : 'commodities') : market === 'synthetic_index' ? 'synthetic' : market === 'indices' ? 'indices' : 'other';
      const pip = num(s.pip);
      return {
        brokerSymbol: sym,
        symbol: fromDerivSymbol(sym),
        name: String(s.display_name ?? sym),
        category,
        tradable: !(s.is_trading_suspended === 1 || s.is_trading_suspended === true),
        marketOpen: s.exchange_is_open === undefined ? null : s.exchange_is_open === 1 || s.exchange_is_open === true,
        digits: pip ? Math.max(0, Math.round(-Math.log10(pip))) : undefined,
        contractTypes: ['MULTUP', 'MULTDOWN', 'CALL', 'PUT'],
        raw: { market, submarket: s.submarket },
      };
    });
  }

  async subscribeQuotes(symbols: string[]) {
    for (const s of symbols) {
      if (this.tickSubs.has(s)) continue;
      const r = await this.subscribe(`ticks:${s}`, { ticks: s });
      const id = (r.subscription as { id?: string } | undefined)?.id;
      if (id) this.tickSubs.set(s, id);
      if (r.tick) this.handleStream({ ...r, msg_type: 'tick' });
    }
  }

  async unsubscribeQuotes(symbols: string[]) {
    for (const s of symbols) {
      const id = this.tickSubs.get(s);
      this.tickSubs.delete(s);
      if (this.socket) await this.socket.unsubscribe(`ticks:${s}`, id);
    }
  }

  async getCandles(symbol: string, granularitySec: number, count: number): Promise<BrokerCandle[]> {
    const r = await this.send({ ticks_history: symbol, style: 'candles', granularity: granularitySec, count: Math.min(count, 5000), end: 'latest' });
    return ((r.candles ?? []) as { epoch: number; open: number; high: number; low: number; close: number }[]).map((c) => ({ timestamp: c.epoch * 1000, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }));
  }

  // ------------------------------------------------------------ trading

  async submitOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    if (req.product === 'cfd') throw new BrokerUnsupportedError('deriv', 'cfd orders');
    if (req.type !== 'market') throw new BrokerUnsupportedError('deriv', 'pendingOrder');
    if (!(req.stake && req.stake > 0)) throw new BrokerError('invalid_request', 'A stake is required for Deriv contracts');
    const currency = req.currency ?? (await this.getAccount()).currency;
    const proposal: Record<string, unknown> = { proposal: 1, amount: Math.round(req.stake * 100) / 100, basis: 'stake', currency, underlying_symbol: req.brokerSymbol };
    if (req.product === 'multiplier') {
      if (!req.multiplier) throw new BrokerError('invalid_request', 'A multiplier is required');
      proposal.contract_type = req.side === 'buy' ? 'MULTUP' : 'MULTDOWN';
      proposal.multiplier = req.multiplier;
      const limit: Record<string, number> = {};
      if (req.stopLossAmount) limit.stop_loss = Math.round(req.stopLossAmount * 100) / 100;
      if (req.takeProfitAmount) limit.take_profit = Math.round(req.takeProfitAmount * 100) / 100;
      if (Object.keys(limit).length) proposal.limit_order = limit;
    } else {
      if (!req.duration || !req.durationUnit) throw new BrokerError('invalid_request', 'Rise/Fall contracts need a duration');
      proposal.contract_type = req.side === 'buy' ? 'CALL' : 'PUT';
      proposal.duration = req.duration;
      proposal.duration_unit = req.durationUnit;
    }
    // Pricing step: definite refusals (validation, closed market, insufficient balance) surface here.
    let p;
    try {
      p = await this.send(proposal);
    } catch (err) {
      if (err instanceof BrokerError && err.kind === 'ambiguous') return { status: 'REJECTED', rejectReason: 'Price proposal timed out (nothing was bought)', verified: true };
      if (err instanceof BrokerError && err.definite) return { status: 'REJECTED', rejectReason: err.message, verified: true, raw: err.details };
      throw err;
    }
    const pid = (p.proposal as { id?: string } | undefined)?.id;
    if (!pid) return { status: 'REJECTED', rejectReason: 'Deriv returned no proposal', verified: true };
    // Purchase step: a timeout here is AMBIGUOUS (the contract may exist) → caller must lookup.
    let b;
    try {
      b = await this.send({ buy: pid, price: proposal.amount });
    } catch (err) {
      if (err instanceof BrokerError && err.definite) return { status: 'REJECTED', rejectReason: err.message, verified: true, raw: err.details };
      throw err instanceof BrokerError ? err : new BrokerError('ambiguous', String(err));
    }
    const buy = (b.buy ?? {}) as { contract_id?: number | string; buy_price?: number; transaction_id?: number | string; purchase_time?: number };
    if (!buy.contract_id) return { status: 'UNKNOWN', rejectReason: 'Buy response had no contract id', verified: false, raw: b };
    return this.verifyContract(String(buy.contract_id), { buy_price: buy.buy_price, transaction_id: buy.transaction_id });
  }

  /** Confirm a contract with Deriv, start streaming its updates, and return a verified fill. */
  private async verifyContract(id: string, extra: Record<string, unknown> = {}): Promise<BrokerOrderResult> {
    let c: Record<string, unknown>;
    try {
      const r = await this.subscribe(`poc:${id}`, { proposal_open_contract: 1, contract_id: Number(id) });
      c = (r.proposal_open_contract ?? {}) as Record<string, unknown>;
      const sid = (r.subscription as { id?: string } | undefined)?.id;
      if (sid) this.pocSubs.set(id, sid);
    } catch {
      return { status: 'UNKNOWN', brokerOrderId: String(extra.transaction_id ?? id), brokerPositionId: id, rejectReason: 'Purchase not yet verified with Deriv', verified: false, raw: extra };
    }
    if (!c.contract_id) return { status: 'UNKNOWN', brokerPositionId: id, rejectReason: 'Contract not found yet', verified: false, raw: extra };
    this.contracts.set(id, c);
    const pos = this.positionOf(c);
    return {
      status: 'FILLED',
      brokerOrderId: String(extra.transaction_id ?? (c.transaction_ids as { buy?: unknown } | undefined)?.buy ?? id),
      brokerPositionId: id,
      filledVolume: Number(c.buy_price ?? extra.buy_price ?? 0),
      averagePrice: pos.entryPrice || num(c.current_spot) || undefined,
      cost: Number(c.buy_price ?? extra.buy_price ?? 0),
      fee: num(c.commission) ?? 0,
      verified: true,
      raw: { contract_type: c.contract_type, buy_price: c.buy_price, multiplier: c.multiplier, date_expiry: c.date_expiry },
    };
  }

  async lookupOrder(_clientOrderId: string, hint: { brokerSymbol?: string; since?: number; side?: Side } = {}): Promise<BrokerOrderResult | null> {
    // Deriv has no client order ids: adopt the newest matching contract bought since the attempt.
    const r = await this.send({ portfolio: 1 });
    const list = ((r.portfolio as { contracts?: Record<string, unknown>[] } | undefined)?.contracts ?? []).filter((c) => (!hint.brokerSymbol || String(c.underlying_symbol ?? c.symbol) === hint.brokerSymbol) && (!hint.side || sideOf(String(c.contract_type)) === hint.side) && Number(c.purchase_time ?? 0) * 1000 >= (hint.since ?? 0) - 5_000);
    const c = list.sort((a, b) => Number(b.purchase_time) - Number(a.purchase_time))[0];
    return c ? this.verifyContract(String(c.contract_id), { buy_price: c.buy_price, transaction_id: c.transaction_id }) : null;
  }

  async cancelOrder(): Promise<BrokerOrderResult> {
    throw new BrokerUnsupportedError('deriv', 'cancelOrder');
  }

  async modifyOrder(): Promise<BrokerOrderResult> {
    throw new BrokerUnsupportedError('deriv', 'modifyOrder');
  }

  async closePosition(id: string): Promise<ClosedPositionResult> {
    try {
      await this.send({ sell: Number(id), price: 0 });
    } catch (err) {
      // Already settled/sold at Deriv? Then report the broker's final result.
      const st = await this.getClosedPosition(id).catch(() => null);
      if (st?.closed) return st;
      throw err;
    }
    // Confirm with the broker (never assume): poll the contract a few times.
    for (let i = 0; i < 5; i++) {
      const st = await this.getClosedPosition(id).catch(() => null);
      if (st?.closed) return st;
      await new Promise((r) => setTimeout(r, this.rpc ? 0 : 400));
    }
    return { brokerPositionId: id, closed: false, reason: 'Sell sent; settlement not yet confirmed by Deriv' };
  }

  async getClosedPosition(id: string): Promise<ClosedPositionResult | null> {
    const r = await this.send({ proposal_open_contract: 1, contract_id: Number(id) });
    const c = (r.proposal_open_contract ?? {}) as Record<string, unknown>;
    if (!c.contract_id) return null;
    this.contracts.set(id, c);
    return this.closedResult(c) ?? { brokerPositionId: id, closed: false };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const r = await this.send({ portfolio: 1 });
    const list = ((r.portfolio as { contracts?: Record<string, unknown>[] } | undefined)?.contracts ?? []);
    return list.map((c) => {
      const known = this.contracts.get(String(c.contract_id));
      return this.positionOf({ ...c, ...(known ?? {}) });
    });
  }

  async getOpenOrders(): Promise<BrokerOpenOrder[]> {
    return []; // Deriv contracts are bought at the current price; there are no resting orders.
  }

  async getTransactions(limit: number): Promise<BrokerTransaction[]> {
    const r = await this.send({ statement: 1, description: 1, limit: Math.min(limit, 100) });
    return (((r.statement as { transactions?: Record<string, unknown>[] } | undefined)?.transactions) ?? []).map((t) => ({
      id: String(t.transaction_id),
      time: Number(t.transaction_time) * 1000,
      type: String(t.action_type),
      amount: Number(t.amount),
      balanceAfter: num(t.balance_after),
      brokerPositionId: t.contract_id ? String(t.contract_id) : undefined,
      description: t.longcode ? String(t.longcode).slice(0, 200) : undefined,
    }));
  }

  health(): BrokerHealth {
    return {
      connected: this.rpc ? true : !!this.socket?.connected,
      latencyMs: this.socket?.latencyMs ?? null,
      lastMessageAt: this.socket?.lastMessageAt || null,
      rateLimitedUntil: this.socket && this.socket.rateLimitedUntil > Date.now() ? this.socket.rateLimitedUntil : null,
      lastError: this.lastError,
    };
  }
}
