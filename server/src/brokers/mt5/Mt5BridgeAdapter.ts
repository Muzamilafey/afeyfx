import { EventEmitter } from 'events';
import { capabilitySet } from '../core/capabilities';
import { BrokerError, BrokerUnsupportedError, type AccountEnvironment, type BrokerAccountInfo, type BrokerAdapter, type BrokerCandle, type BrokerHealth, type BrokerOpenOrder, type BrokerOrderRequest, type BrokerOrderResult, type BrokerPosition, type BrokerStreamEvent, type BrokerTransaction, type ClosedPositionResult, type InstrumentSpec, type Side } from '../core/types';
import { Mt5CommandModel } from '../../models/BrokerRecords';
import { mt5Bridge, type Mt5Report, type Mt5Symbol, type TerminalState } from './Mt5Bridge';

/**
 * Adapter for an MT5 account reached through the AfeyFX Bridge EA. Orders are queued as signed-
 * protocol commands; the result is whatever the TERMINAL reports from the broker's trade server
 * (retcode, order, deal, position). No report within the deadline = UNKNOWN, resolved later by
 * matching the commandId in position/order comments from heartbeats.
 */
const HEARTBEAT_STALE_MS = 30_000;

/** Normalized symbol from an MT5 name ("EURUSD", "EURUSDm", "XAUUSD.r") when it looks like a pair. */
export function fromMt5Symbol(name: string): string {
  const m = /^([A-Z]{3})([A-Z]{3})[a-z.#_-]*\w*$/.exec(name);
  return m ? `${m[1]}/${m[2]}` : name;
}

const categoryOf = (s: Mt5Symbol): InstrumentSpec['category'] => {
  const p = (s.path ?? '').toLowerCase();
  if (/^(XAU|XAG|XPT|XPD)/.test(s.name)) return 'metals';
  if (p.includes('forex') || /^[A-Z]{6}/.test(s.name)) return 'forex';
  if (p.includes('crypto')) return 'crypto';
  if (p.includes('indic') || p.includes('index')) return 'indices';
  if (p.includes('stock') || p.includes('share')) return 'stocks';
  return 'other';
};

export class Mt5BridgeAdapter implements BrokerAdapter {
  readonly provider = 'mt5' as const;
  readonly capabilities = capabilitySet('mt5');
  private events = new EventEmitter();
  private offs: (() => void)[] = [];

  constructor(
    private connectionId: string,
    private environment: AccountEnvironment,
  ) {}

  private st(): TerminalState {
    return mt5Bridge.stateOf(this.connectionId);
  }

  private live(): TerminalState {
    const s = this.st();
    if (!s.hello || Date.now() - s.lastSeenAt > HEARTBEAT_STALE_MS) throw new BrokerError('disconnected', 'MT5 terminal is not connected (start the AfeyFX Bridge EA)');
    return s;
  }

  onEvent(listener: (e: BrokerStreamEvent) => void) {
    this.events.on('event', listener);
    return () => void this.events.off('event', listener);
  }

  async connect() {
    if (this.offs.length) return;
    const onQuote = (id: string, sym: string, q: { bid: number; ask: number; time: number }) => id === this.connectionId && this.events.emit('event', { type: 'quote', quote: { brokerSymbol: sym, symbol: fromMt5Symbol(sym), bid: q.bid, ask: q.ask, timestamp: q.time } } satisfies BrokerStreamEvent);
    const onStatus = (id: string, connected: boolean) => id === this.connectionId && this.events.emit('event', { type: 'status', connected } satisfies BrokerStreamEvent);
    const onHeartbeat = (id: string) => {
      if (id !== this.connectionId) return;
      void this.getAccount().then((a) => this.events.emit('event', { type: 'account', account: a } satisfies BrokerStreamEvent), () => undefined);
    };
    mt5Bridge.events.on('quote', onQuote);
    mt5Bridge.events.on('status', onStatus);
    mt5Bridge.events.on('heartbeat', onHeartbeat);
    this.offs.push(() => mt5Bridge.events.off('quote', onQuote), () => mt5Bridge.events.off('status', onStatus), () => mt5Bridge.events.off('heartbeat', onHeartbeat));
    this.replayQuotes();
  }

  /** Quotes the terminal pushed before this adapter existed, with their original receive time. */
  private replayQuotes(symbols?: string[]) {
    for (const [sym, q] of this.st().quotes) {
      if (symbols && !symbols.includes(sym)) continue;
      this.events.emit('event', { type: 'quote', quote: { brokerSymbol: sym, symbol: fromMt5Symbol(sym), bid: q.bid, ask: q.ask, timestamp: q.time, receivedAt: q.rx } } satisfies BrokerStreamEvent);
    }
  }

  async disconnect() {
    for (const off of this.offs) off();
    this.offs = [];
  }

  async validateAccess() {
    const s = this.live();
    if (s.hello!.tradeMode !== this.environment) throw new BrokerError('environment_mismatch', `Terminal reports a ${s.hello!.tradeMode} account`);
    return this.getAccount();
  }

  async getAccount(): Promise<BrokerAccountInfo> {
    const s = this.live();
    const a = s.account;
    if (!a) throw new BrokerError('disconnected', 'No account data from the terminal yet');
    return { accountId: s.hello!.login, environment: this.environment, currency: s.hello!.currency, balance: a.balance, equity: a.equity, margin: a.margin, freeMargin: a.freeMargin, marginLevel: a.marginLevel ?? null, leverage: s.hello!.leverage ?? null, company: s.hello!.company, server: s.hello!.server };
  }

  async getInstruments(): Promise<InstrumentSpec[]> {
    return [...this.st().symbols.values()].map((s) => ({
      brokerSymbol: s.name,
      symbol: fromMt5Symbol(s.name),
      name: s.description || s.name,
      category: categoryOf(s),
      tradable: !s.tradeMode || /full|long|short/i.test(s.tradeMode),
      marketOpen: s.sessionOpen ?? null,
      digits: s.digits,
      contractSize: s.contractSize,
      tickSize: s.tickSize,
      tickValue: s.tickValue,
      volumeMin: s.volumeMin,
      volumeMax: s.volumeMax,
      volumeStep: s.volumeStep,
      profitCurrency: s.currencyProfit,
      marginCurrency: s.currencyMargin,
    }));
  }

  /** The EA pushes quotes for the symbols configured in its inputs; nothing to request. */
  async subscribeQuotes(symbols: string[]) {
    this.replayQuotes(symbols);
  }
  async unsubscribeQuotes() {}

  async getCandles(): Promise<BrokerCandle[]> {
    throw new BrokerUnsupportedError('mt5', 'candles');
  }

  private result(r: Mt5Report | null, fallbackPending: boolean): BrokerOrderResult {
    if (!r) return { status: 'UNKNOWN', rejectReason: 'No execution report from the terminal within the deadline', verified: false };
    if (r.status === 'filled' || r.status === 'done') return { status: 'FILLED', brokerOrderId: r.order, brokerPositionId: r.position, filledVolume: r.volume, averagePrice: r.price, verified: true, raw: { retcode: r.retcode, deal: r.deal } };
    if (r.status === 'placed') return { status: fallbackPending ? 'OPEN' : 'FILLED', brokerOrderId: r.order, verified: true, raw: { retcode: r.retcode } };
    if (r.status === 'unknown') return { status: 'UNKNOWN', rejectReason: r.message ?? 'Terminal could not confirm the result', verified: false };
    return { status: r.status === 'expired' ? 'EXPIRED' : 'REJECTED', rejectReason: `${r.message ?? 'Rejected'}${r.retcode ? ` (retcode ${r.retcode})` : ''}`, verified: true, raw: { retcode: r.retcode } };
  }

  async submitOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    if (req.product !== 'cfd') throw new BrokerUnsupportedError('mt5', `${req.product} contracts`);
    this.live();
    if (!(req.volume && req.volume > 0)) throw new BrokerError('invalid_request', 'Volume (lots) is required');
    if (req.type !== 'market' && !req.price) throw new BrokerError('invalid_request', 'Pending orders need a price');
    const deadlineMs = req.type === 'market' ? 15_000 : 30_000;
    const r = await mt5Bridge.enqueue(this.connectionId, 'order.place', { clientOrderId: req.clientOrderId, symbol: req.brokerSymbol, side: req.side, orderType: req.type, volume: req.volume, price: req.price, sl: req.stopLoss, tp: req.takeProfit }, deadlineMs);
    return this.result(r, req.type !== 'market');
  }

  async lookupOrder(clientOrderId: string): Promise<BrokerOrderResult | null> {
    const cmd = await Mt5CommandModel.findOne({ connection: this.connectionId, 'params.clientOrderId': clientOrderId }).lean();
    if (!cmd) return null;
    if (cmd.report) return this.result(cmd.report as Mt5Report, (cmd.params as { orderType?: string }).orderType !== 'market');
    // No report: the EA writes the commandId into the order/position comment.
    const s = this.st();
    const pos = s.positions.find((p) => p.comment === cmd.commandId);
    if (pos) return { status: 'FILLED', brokerPositionId: pos.ticket, filledVolume: pos.volume, averagePrice: pos.priceOpen, verified: true };
    const ord = s.orders.find((o) => o.comment === cmd.commandId);
    if (ord) return { status: 'OPEN', brokerOrderId: ord.ticket, verified: true };
    const deal = s.deals.find((d) => d.comment === cmd.commandId);
    if (deal) return { status: 'FILLED', brokerPositionId: deal.positionId, averagePrice: deal.price, filledVolume: deal.volume, verified: true };
    // Expired before delivery → definitely not executed.
    if (cmd.status === 'EXPIRED' && !cmd.deliveredAt) return { status: 'EXPIRED', rejectReason: 'Command expired before the terminal received it', verified: true };
    return null;
  }

  async cancelOrder(ticket: string) {
    this.live();
    return this.result(await mt5Bridge.enqueue(this.connectionId, 'order.cancel', { ticket }, 15_000), false);
  }

  async modifyOrder(ticket: string, changes: { price?: number; stopLoss?: number; takeProfit?: number }) {
    this.live();
    return this.result(await mt5Bridge.enqueue(this.connectionId, 'order.modify', { ticket, price: changes.price, sl: changes.stopLoss, tp: changes.takeProfit }, 15_000), false);
  }

  async closePosition(ticket: string, opts: { volume?: number } = {}): Promise<ClosedPositionResult> {
    const pos = this.live().positions.find((p) => p.ticket === ticket);
    if (!pos) {
      const closed = await this.getClosedPosition(ticket);
      if (closed?.closed) return closed;
      throw new BrokerError('rejected', `Position ${ticket} is not open on the terminal`);
    }
    const r = await mt5Bridge.enqueue(this.connectionId, 'position.close', { ticket, symbol: pos.symbol, volume: opts.volume ?? pos.volume }, 15_000);
    const res = this.result(r, false);
    if (res.status !== 'FILLED') {
      if (res.status === 'UNKNOWN') return { brokerPositionId: ticket, closed: false, reason: res.rejectReason };
      throw new BrokerError('rejected', res.rejectReason ?? 'Close rejected');
    }
    // Realized P&L comes from the closing deal(s) reported in the next heartbeat; until then report what we know.
    // The terminal's trade-server confirmation is authoritative even if the last heartbeat still lists it.
    const known = await this.getClosedPosition(ticket);
    return known?.closed ? known : { brokerPositionId: ticket, closed: true, exitPrice: res.averagePrice, closedAt: Date.now(), reason: 'Closed' };
  }

  async getClosedPosition(ticket: string): Promise<ClosedPositionResult | null> {
    const s = this.st();
    if (s.positions.some((p) => p.ticket === ticket)) return { brokerPositionId: ticket, closed: false };
    const outs = s.deals.filter((d) => d.positionId === ticket && /out/.test(d.entry));
    if (!outs.length) return null;
    const pnl = outs.reduce((sum, d) => sum + (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0), 0);
    const last = outs[outs.length - 1];
    return { brokerPositionId: ticket, closed: true, realizedPnl: pnl, exitPrice: last.price, closedAt: last.time, reason: last.comment?.startsWith('[sl') ? 'Stop loss' : last.comment?.startsWith('[tp') ? 'Take profit' : 'Closed' };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return this.live().positions.map((p) => ({ brokerPositionId: p.ticket, brokerSymbol: p.symbol, symbol: fromMt5Symbol(p.symbol), side: p.type as Side, volume: p.volume, entryPrice: p.priceOpen, currentPrice: p.priceCurrent, stopLoss: p.sl || undefined, takeProfit: p.tp || undefined, unrealizedPnl: p.profit, openedAt: p.time, product: 'cfd', clientOrderId: p.comment || undefined }));
  }

  async getOpenOrders(): Promise<BrokerOpenOrder[]> {
    return this.live().orders.map((o) => ({ brokerOrderId: o.ticket, brokerSymbol: o.symbol, side: /sell/.test(o.type) ? 'sell' : 'buy', type: /stop/.test(o.type) ? 'stop' : 'limit', volume: o.volume, price: o.price, stopLoss: o.sl || undefined, takeProfit: o.tp || undefined, clientOrderId: o.comment || undefined }));
  }

  async getTransactions(limit: number): Promise<BrokerTransaction[]> {
    return this.st().deals.slice(-limit).reverse().map((d) => ({ id: d.ticket, time: d.time, type: `${d.type}/${d.entry}`, amount: (d.profit ?? 0) + (d.commission ?? 0) + (d.swap ?? 0), brokerPositionId: d.positionId, description: `${d.symbol} ${d.volume} @ ${d.price}` }));
  }

  health(): BrokerHealth {
    const s = this.st();
    const connected = !!s.hello && Date.now() - s.lastSeenAt <= HEARTBEAT_STALE_MS;
    return { connected, latencyMs: null, lastMessageAt: s.lastSeenAt || null, rateLimitedUntil: null, lastError: connected ? undefined : 'No recent heartbeat from the terminal' };
  }
}
