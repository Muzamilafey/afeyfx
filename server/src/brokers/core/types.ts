/**
 * Normalized, provider-independent broker types used by every broker adapter and service.
 *
 * Rules every adapter follows:
 *  - Results come from the broker's own responses. A request that "went out" is never treated as
 *    executed until the broker confirms the final order/contract state.
 *  - Unsupported operations throw BrokerUnsupportedError (never a fake success).
 *  - Outcomes the adapter cannot determine throw BrokerError with kind 'ambiguous'; callers must
 *    query the broker (lookup/reconcile) before any retry.
 *  - No adapter exposes deposit, withdrawal or transfer operations.
 */

export type BrokerProvider = 'deriv' | 'mt5';
export type AccountEnvironment = 'demo' | 'real';
export type Side = 'buy' | 'sell';

export const CAPABILITIES = [
  'connect',
  'oauth',
  'refreshAuth',
  'revokeAuth',
  'accountInfo',
  'margin',
  'instruments',
  'quotes',
  'orderBook',
  'candles',
  'marketOrder',
  'pendingOrder',
  'stopLossTakeProfit',
  'modifyOrder',
  'cancelOrder',
  'closePosition',
  'partialClose',
  'positions',
  'openOrders',
  'transactions',
  'contracts',
  'reconcile',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type BrokerErrorKind =
  | 'rejected' // the broker received and refused the request (safe to treat as not executed)
  | 'insufficient_funds'
  | 'invalid_request'
  | 'ambiguous' // timeout / dropped connection: the request may or may not have executed
  | 'unsupported'
  | 'auth' // credentials invalid or revoked
  | 'auth_expired' // re-authorization required
  | 'rate_limited'
  | 'disconnected'
  | 'market_closed'
  | 'environment_mismatch'; // e.g. a demo connection is now pointing at a real account

export class BrokerError extends Error {
  constructor(
    public kind: BrokerErrorKind,
    message: string,
    public details?: Record<string, unknown>,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
  /** True when the operation definitely did not execute. */
  get definite() {
    return this.kind !== 'ambiguous' && this.kind !== 'disconnected';
  }
}

export class BrokerUnsupportedError extends BrokerError {
  constructor(provider: string, capability: Capability | string) {
    super('unsupported', `${provider} does not support "${capability}" through this integration`);
    this.name = 'BrokerUnsupportedError';
  }
}

export interface BrokerAccountInfo {
  accountId: string;
  environment: AccountEnvironment;
  currency: string;
  balance: number;
  /** Balance plus open P&L, when the broker provides or it can be computed. */
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  leverage: number | null;
  name?: string;
  company?: string;
  server?: string;
  raw?: Record<string, unknown>;
}

export interface InstrumentSpec {
  /** Broker's symbol, e.g. "frxEURUSD", "EURUSD", "EURUSDm". */
  brokerSymbol: string;
  /** Normalized symbol when it maps to a known market, e.g. "EUR/USD". */
  symbol: string;
  name: string;
  category: 'forex' | 'crypto' | 'metals' | 'indices' | 'synthetic' | 'commodities' | 'stocks' | 'other';
  tradable: boolean;
  marketOpen: boolean | null;
  digits?: number;
  /** MT5-style specification (lots). */
  contractSize?: number;
  tickSize?: number;
  /** Profit/loss of one tick for 1 lot, in the account currency. */
  tickValue?: number;
  volumeMin?: number;
  volumeMax?: number;
  volumeStep?: number;
  profitCurrency?: string;
  marginCurrency?: string;
  /** Deriv-style specification (stake-based contracts). */
  contractTypes?: string[];
  minStake?: number;
  maxStake?: number;
  multipliers?: number[];
  raw?: Record<string, unknown>;
}

export interface BrokerQuote {
  brokerSymbol: string;
  symbol: string;
  bid: number;
  ask: number;
  last?: number;
  timestamp: number;
}

export interface BrokerCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * Normalized order request. `product` selects the broker product:
 *  - 'cfd' (MT5): volume in lots, market or pending, price-level SL/TP
 *  - 'multiplier' (Deriv MULTUP/MULTDOWN): stake + multiplier, SL/TP as amounts
 *  - 'rise_fall' (Deriv CALL/PUT): stake + fixed duration; settles at expiry
 */
export interface BrokerOrderRequest {
  clientOrderId: string;
  brokerSymbol: string;
  side: Side;
  product: 'cfd' | 'multiplier' | 'rise_fall';
  type: 'market' | 'limit' | 'stop';
  volume?: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  stake?: number;
  multiplier?: number;
  stopLossAmount?: number;
  takeProfitAmount?: number;
  duration?: number;
  durationUnit?: 't' | 's' | 'm' | 'h' | 'd';
  currency?: string;
  /** Latest quote used to size/validate the order. */
  referencePrice?: number;
  /** For MT5: a deadline after which the terminal must not execute the order. */
  deadline?: number;
}

export type BrokerOrderStatus = 'PENDING' | 'SUBMITTED' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED' | 'UNKNOWN';

export interface BrokerOrderResult {
  status: BrokerOrderStatus;
  brokerOrderId?: string;
  /** Position / contract identifier created by the order. */
  brokerPositionId?: string;
  filledVolume?: number;
  averagePrice?: number;
  /** Amount paid (Deriv buy price). */
  cost?: number;
  fee?: number;
  rejectReason?: string;
  verified: boolean;
  raw?: Record<string, unknown>;
}

export interface BrokerPosition {
  brokerPositionId: string;
  brokerSymbol: string;
  symbol: string;
  side: Side;
  volume: number;
  entryPrice: number;
  currentPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPnl?: number;
  openedAt?: number;
  product: BrokerOrderRequest['product'];
  /** Our client reference when the broker echoes it (MT5 comment). */
  clientOrderId?: string;
  /** Deriv: contract expiry; MT5: none. */
  expiresAt?: number;
  raw?: Record<string, unknown>;
}

export interface BrokerOpenOrder {
  brokerOrderId: string;
  brokerSymbol: string;
  side: Side;
  type: 'limit' | 'stop';
  volume: number;
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  clientOrderId?: string;
}

export interface BrokerTransaction {
  id: string;
  time: number;
  type: string;
  amount: number;
  balanceAfter?: number;
  brokerPositionId?: string;
  description?: string;
}

export interface ClosedPositionResult {
  brokerPositionId: string;
  closed: boolean;
  /** Realized P&L in the account currency, as reported by the broker. */
  realizedPnl?: number;
  exitPrice?: number;
  closedAt?: number;
  reason?: string;
  raw?: Record<string, unknown>;
}

export interface BrokerHealth {
  connected: boolean;
  latencyMs: number | null;
  lastMessageAt: number | null;
  rateLimitedUntil: number | null;
  lastError?: string;
}

export type BrokerStreamEvent =
  | { type: 'quote'; quote: BrokerQuote }
  | { type: 'account'; account: BrokerAccountInfo }
  | { type: 'position-closed'; result: ClosedPositionResult }
  | { type: 'position-update'; position: BrokerPosition }
  | { type: 'order-report'; clientOrderId: string; result: BrokerOrderResult }
  | { type: 'status'; connected: boolean; info?: string };

/**
 * One adapter instance serves exactly one broker account (one BrokerConnection).
 * Capability flags say what is implemented; calling anything else throws BrokerUnsupportedError.
 */
export interface BrokerAdapter {
  readonly provider: BrokerProvider;
  readonly capabilities: ReadonlySet<Capability>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Confirms credentials work and the account is the expected one (id + demo/real). */
  validateAccess(): Promise<BrokerAccountInfo>;
  getAccount(): Promise<BrokerAccountInfo>;
  getInstruments(): Promise<InstrumentSpec[]>;
  subscribeQuotes(brokerSymbols: string[]): Promise<void>;
  unsubscribeQuotes(brokerSymbols: string[]): Promise<void>;
  getCandles(brokerSymbol: string, granularitySec: number, count: number): Promise<BrokerCandle[]>;
  submitOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult>;
  /** Look up the result of an order by our client id (after an ambiguous submission). */
  lookupOrder(clientOrderId: string, hint?: { brokerSymbol?: string; since?: number; side?: Side }): Promise<BrokerOrderResult | null>;
  cancelOrder(brokerOrderId: string): Promise<BrokerOrderResult>;
  modifyOrder(brokerOrderId: string, changes: { price?: number; stopLoss?: number; takeProfit?: number }): Promise<BrokerOrderResult>;
  closePosition(brokerPositionId: string, opts?: { volume?: number; clientOrderId?: string }): Promise<ClosedPositionResult>;
  getPositions(): Promise<BrokerPosition[]>;
  getOpenOrders(): Promise<BrokerOpenOrder[]>;
  getTransactions(limit: number): Promise<BrokerTransaction[]>;
  /** Final result of a position/contract that is no longer open (settlement, broker-side SL/TP). */
  getClosedPosition(brokerPositionId: string): Promise<ClosedPositionResult | null>;
  health(): BrokerHealth;
  /** Stream events (quotes, settlements, account changes, connection status). */
  onEvent(listener: (e: BrokerStreamEvent) => void): () => void;
}

/** Credentials handed to an adapter (decrypted in memory only, never logged or returned). */
export interface BrokerSecrets {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: 'oauth' | 'pat';
  appId?: string;
  terminalSecret?: string;
}
