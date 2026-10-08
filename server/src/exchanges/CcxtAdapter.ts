import * as ccxt from 'ccxt';
import type {
  Balance,
  Candle,
  ExchangeOrder,
  ExchangePosition,
  ExchangeTrade,
  MarketInfo,
  OrderBook,
  OrderRequest,
  OrderStatus,
  Side,
  Ticker,
} from '../types';
import type { ExchangeAdapter, ExchangeStatus, PermissionReport } from './ExchangeAdapter';
import { assertLiveOrderAllowed } from '../execution/LiveTradingGuard';
import { WithdrawalForbiddenError } from '../utils/errors';
import { errorMessage } from '../utils/logger';

export interface AdapterCredentials {
  apiKey: string;
  secret: string;
  password?: string;
}

export interface AdapterOptions {
  testnet: boolean;
  credentials?: AdapterCredentials;
  /** Inject a pre-built ccxt-like client (tests). */
  client?: unknown;
  timeoutMs?: number;
}

/** Any property name matching this is blocked on the underlying client. */
export const FORBIDDEN_METHOD_PATTERN = /withdraw|transfer/i;

/**
 * Wrap a ccxt exchange so that any withdrawal / transfer method - unified or implicit
 * (e.g. `withdraw`, `transfer`, `sapiPostCapitalWithdrawApply`) - throws immediately.
 */
export function guardAgainstWithdrawals<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && FORBIDDEN_METHOD_PATTERN.test(prop)) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v === 'function') {
          return () => {
            throw new WithdrawalForbiddenError(prop);
          };
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

type Ccxt = ccxt.Exchange;
/** ccxt precision-mode constant (ccxt.TICK_SIZE); not exported in the type declarations. */
const TICK_SIZE = 4;

const STATUS_MAP: Record<string, OrderStatus> = {
  open: 'OPEN',
  closed: 'FILLED',
  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
  expired: 'EXPIRED',
  rejected: 'REJECTED',
};

export function mapOrder(o: ccxt.Order): ExchangeOrder {
  let status: OrderStatus = STATUS_MAP[o.status ?? ''] ?? 'UNKNOWN';
  const filled = Number(o.filled ?? 0);
  const amount = Number(o.amount ?? 0);
  if (status === 'OPEN' && filled > 0) status = 'PARTIALLY_FILLED';
  if (status === 'CANCELLED' && filled > 0 && filled < amount) status = 'CANCELLED'; // partial fill then cancel; fills tracked separately
  return {
    id: String(o.id),
    clientOrderId: o.clientOrderId,
    symbol: o.symbol ?? '',
    side: o.side as Side,
    type: String(o.type ?? ''),
    status,
    price: o.price ?? undefined,
    average: o.average ?? undefined,
    amount,
    filled,
    remaining: Number(o.remaining ?? Math.max(0, amount - filled)),
    fee: o.fee?.cost ?? undefined,
    feeCurrency: o.fee?.currency ?? undefined,
    timestamp: o.timestamp ?? Date.now(),
  };
}

/**
 * Generic CCXT-backed adapter. Exchange-specific subclasses override permission verification
 * and order-parameter details.
 */
export class CcxtAdapter implements ExchangeAdapter {
  protected client: Ccxt;
  readonly hasCredentials: boolean;
  readonly testnet: boolean;
  private marketsLoaded = false;

  constructor(
    readonly name: string,
    opts: AdapterOptions,
  ) {
    this.testnet = opts.testnet;
    this.hasCredentials = !!opts.credentials?.apiKey && !!opts.credentials?.secret;
    let raw: Ccxt;
    if (opts.client) {
      raw = opts.client as Ccxt;
    } else {
      const Ctor = (ccxt as unknown as Record<string, new (cfg: object) => Ccxt>)[name];
      if (!Ctor) throw new Error(`Exchange not supported by ccxt: ${name}`);
      raw = new Ctor({
        apiKey: opts.credentials?.apiKey,
        secret: opts.credentials?.secret,
        password: opts.credentials?.password,
        enableRateLimit: true,
        timeout: opts.timeoutMs ?? 15_000,
        options: { adjustForTimeDifference: true },
      });
      if (opts.testnet && typeof raw.setSandboxMode === 'function') {
        try {
          raw.setSandboxMode(true);
        } catch {
          /* exchange without sandbox: stays on mainnet but credentials still guarded */
        }
      }
    }
    this.client = guardAgainstWithdrawals(raw);
  }

  protected async ensureMarkets() {
    if (!this.marketsLoaded) {
      await this.client.loadMarkets();
      this.marketsLoaded = true;
    }
  }

  async getMarkets(): Promise<MarketInfo[]> {
    await this.ensureMarkets();
    return Object.values(this.client.markets ?? {}).map((m) => ({
      symbol: m!.symbol,
      base: m!.base,
      quote: m!.quote,
      active: m!.active !== false,
      type: String(m!.type ?? 'spot'),
      minAmount: m!.limits?.amount?.min ?? undefined,
      amountPrecision: typeof m!.precision?.amount === 'number' ? this.decimalsOf(m!.precision.amount) : undefined,
      pricePrecision: typeof m!.precision?.price === 'number' ? this.decimalsOf(m!.precision.price) : undefined,
      takerFee: m!.taker ?? undefined,
      makerFee: m!.maker ?? undefined,
    }));
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const t = await this.client.fetchTicker(symbol);
    return {
      symbol,
      timestamp: t.timestamp ?? Date.now(),
      last: Number(t.last ?? t.close ?? NaN),
      bid: Number(t.bid ?? NaN),
      ask: Number(t.ask ?? NaN),
      high24h: t.high ?? undefined,
      low24h: t.low ?? undefined,
      change24hPct: t.percentage !== undefined && t.percentage !== null ? t.percentage / 100 : undefined,
      baseVolume: t.baseVolume ?? undefined,
      quoteVolume: t.quoteVolume ?? undefined,
    };
  }

  async getOrderBook(symbol: string, limit = 20): Promise<OrderBook> {
    const ob = await this.client.fetchOrderBook(symbol, limit);
    const lv = (rows: ccxt.OrderBook['bids']) => rows.map((r) => ({ price: Number(r[0]), amount: Number(r[1]) }));
    return { symbol, timestamp: ob.timestamp ?? Date.now(), bids: lv(ob.bids), asks: lv(ob.asks) };
  }

  async getCandles(symbol: string, timeframe: string, since?: number, limit = 500): Promise<Candle[]> {
    const rows = await this.client.fetchOHLCV(symbol, timeframe, since, limit);
    return rows.map((r) => ({
      timestamp: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }));
  }

  async getBalance(): Promise<Balance[]> {
    this.requireCredentials();
    const b = await this.client.fetchBalance();
    const total = (b.total ?? {}) as unknown as Record<string, number>;
    const free = (b.free ?? {}) as unknown as Record<string, number>;
    const used = (b.used ?? {}) as unknown as Record<string, number>;
    return Object.keys(total)
      .filter((c) => Number(total[c]) !== 0)
      .map((c) => ({ currency: c, total: Number(total[c] ?? 0), free: Number(free[c] ?? 0), used: Number(used[c] ?? 0) }));
  }

  async getPositions(symbols?: string[]): Promise<ExchangePosition[]> {
    this.requireCredentials();
    if (!this.client.has?.fetchPositions) return []; // spot accounts: positions are balances
    const ps = await this.client.fetchPositions(symbols);
    return ps
      .filter((p) => Number(p.contracts ?? 0) !== 0)
      .map((p) => ({
        symbol: p.symbol ?? '',
        side: p.side === 'short' ? 'SHORT' : 'LONG',
        amount: Number(p.contracts ?? 0) * Number(p.contractSize ?? 1),
        entryPrice: Number(p.entryPrice ?? 0),
        markPrice: p.markPrice ?? undefined,
        unrealizedPnl: p.unrealizedPnl ?? undefined,
        leverage: p.leverage ?? undefined,
      }));
  }

  async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    this.requireCredentials();
    const os = await this.client.fetchOpenOrders(symbol);
    return os.map(mapOrder);
  }

  /** Map our order request to ccxt (type, price, params). */
  protected buildOrderParams(req: OrderRequest): { type: string; price?: number; params: Record<string, unknown> } {
    const params: Record<string, unknown> = { clientOrderId: req.clientOrderId };
    if (req.reduceOnly && this.client.has?.fetchPositions) params.reduceOnly = true;
    switch (req.type) {
      case 'market':
        return { type: 'market', params };
      case 'limit':
        if (!req.price) throw new Error('Limit order requires price');
        return { type: 'limit', price: req.price, params };
      case 'stop_loss':
        if (!req.stopPrice) throw new Error('Stop-loss order requires stopPrice');
        return { type: req.price ? 'limit' : 'market', price: req.price, params: { ...params, stopLossPrice: req.stopPrice } };
      case 'take_profit':
        if (!req.stopPrice) throw new Error('Take-profit order requires stopPrice');
        return { type: req.price ? 'limit' : 'market', price: req.price, params: { ...params, takeProfitPrice: req.stopPrice } };
      case 'trailing_stop':
        if (!this.client.has?.createTrailingPercentOrder) throw new Error(`${this.name} does not support trailing-stop orders`);
        return { type: 'market', params: { ...params, trailingPercent: (req.trailingPct ?? 0) * 100 } };
      default:
        throw new Error(`Unsupported order type ${String(req.type)}`);
    }
  }

  async createOrder(req: OrderRequest): Promise<ExchangeOrder> {
    // Defence in depth: refuse before any network call unless live trading is fully authorized.
    assertLiveOrderAllowed(req.reduceOnly ? 'REDUCE' : 'OPEN');
    this.requireCredentials();
    if (!(req.amount > 0)) throw new Error('Order amount must be positive');
    const { type, price, params } = this.buildOrderParams(req);
    const o = await this.client.createOrder(req.symbol, type, req.side, req.amount, price, params);
    return mapOrder(o);
  }

  async cancelOrder(id: string, symbol: string): Promise<ExchangeOrder> {
    this.requireCredentials();
    const o = await this.client.cancelOrder(id, symbol);
    return mapOrder(o);
  }

  async getOrder(id: string, symbol: string, clientOrderId?: string): Promise<ExchangeOrder> {
    this.requireCredentials();
    const o = await this.client.fetchOrder(id, symbol, clientOrderId ? { clientOrderId } : {});
    return mapOrder(o);
  }

  /** Look up an order by our idempotency key (used after timeouts to avoid duplicate submission). */
  async findOrderByClientId(symbol: string, clientOrderId: string): Promise<ExchangeOrder | null> {
    this.requireCredentials();
    const candidates: ccxt.Order[] = [];
    try {
      candidates.push(...(await this.client.fetchOpenOrders(symbol)));
    } catch {
      /* ignore, try closed */
    }
    if (this.client.has?.fetchClosedOrders) {
      try {
        candidates.push(...(await this.client.fetchClosedOrders(symbol, Date.now() - 86_400_000)));
      } catch {
        /* ignore */
      }
    }
    const hit = candidates.find((o) => o.clientOrderId === clientOrderId);
    return hit ? mapOrder(hit) : null;
  }

  async getTrades(symbol: string, since?: number, limit = 100): Promise<ExchangeTrade[]> {
    this.requireCredentials();
    const ts = await this.client.fetchMyTrades(symbol, since, limit);
    return ts.map((t) => ({
      id: String(t.id),
      orderId: t.order ?? undefined,
      symbol: t.symbol ?? symbol,
      side: t.side as Side,
      price: Number(t.price),
      amount: Number(t.amount),
      fee: Number(t.fee?.cost ?? 0),
      feeCurrency: t.fee?.currency ?? undefined,
      timestamp: t.timestamp ?? Date.now(),
    }));
  }

  async getServerTime(): Promise<number> {
    if (this.client.has?.fetchTime) {
      const t = await this.client.fetchTime();
      if (t) return Number(t);
    }
    throw new Error(`${this.name} does not expose server time`);
  }

  async getStatus(): Promise<ExchangeStatus> {
    try {
      if (this.client.has?.fetchStatus) {
        const s = await this.client.fetchStatus();
        return { ok: s.status === 'ok', status: String(s.status ?? 'unknown'), updated: s.updated ?? undefined };
      }
      await this.client.fetchTime?.();
      return { ok: true, status: 'ok' };
    } catch (err) {
      return { ok: false, status: 'error', message: errorMessage(err) };
    }
  }

  /** Default: cannot verify -> fail closed (treated as not verified, live trading refused). */
  async verifyPermissions(): Promise<PermissionReport> {
    return { verified: false, canRead: false, canTrade: false, canWithdraw: true, notes: [`Permission verification not implemented for ${this.name}`] };
  }

  async getFundingRate(symbol: string): Promise<number | undefined> {
    if (!this.client.has?.fetchFundingRate) return undefined;
    const f = await this.client.fetchFundingRate(symbol);
    return f.fundingRate ?? undefined;
  }

  async getOpenInterest(symbol: string): Promise<number | undefined> {
    if (!this.client.has?.fetchOpenInterest) return undefined;
    const oi = await this.client.fetchOpenInterest(symbol);
    return oi.openInterestAmount ?? undefined;
  }

  /** ccxt expresses precision either as a tick size or as a count of decimal places. */
  protected decimalsOf(p: number): number {
    if (this.client.precisionMode === TICK_SIZE) return Math.max(0, Math.round(-Math.log10(p)));
    return Math.max(0, Math.round(p));
  }

  protected requireCredentials() {
    if (!this.hasCredentials) throw new Error(`${this.name}: API credentials not configured`);
  }

  async close() {
    const c = this.client as unknown as { close?: () => Promise<void> };
    if (typeof c.close === 'function') await c.close();
  }
}

