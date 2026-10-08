import type {
  Balance,
  Candle,
  ExchangeOrder,
  ExchangePosition,
  ExchangeTrade,
  MarketInfo,
  OrderBook,
  OrderRequest,
  Ticker,
} from '../types';

export interface PermissionReport {
  /** Whether the permission state could actually be verified with the exchange. */
  verified: boolean;
  canRead: boolean;
  canTrade: boolean;
  /** MUST be false for the key to be accepted for live trading. */
  canWithdraw: boolean;
  ipRestricted?: boolean;
  notes: string[];
  raw?: unknown;
}

export interface ExchangeStatus {
  ok: boolean;
  status: string;
  updated?: number;
  message?: string;
}

/**
 * Exchange-agnostic adapter contract. The rest of the platform depends only on this interface,
 * never on a specific exchange SDK.
 *
 * Deliberately absent: withdraw(), transfer(), or any method that moves funds off-exchange.
 * The platform never supports withdrawals.
 */
export interface ExchangeAdapter {
  readonly name: string;
  readonly testnet: boolean;
  readonly hasCredentials: boolean;

  getMarkets(): Promise<MarketInfo[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getOrderBook(symbol: string, limit?: number): Promise<OrderBook>;
  getCandles(symbol: string, timeframe: string, since?: number, limit?: number): Promise<Candle[]>;
  getBalance(): Promise<Balance[]>;
  getPositions(symbols?: string[]): Promise<ExchangePosition[]>;
  getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>;
  createOrder(req: OrderRequest): Promise<ExchangeOrder>;
  cancelOrder(id: string, symbol: string): Promise<ExchangeOrder>;
  getOrder(id: string, symbol: string, clientOrderId?: string): Promise<ExchangeOrder>;
  getTrades(symbol: string, since?: number, limit?: number): Promise<ExchangeTrade[]>;

  getServerTime(): Promise<number>;
  getStatus(): Promise<ExchangeStatus>;
  verifyPermissions(): Promise<PermissionReport>;
  getFundingRate?(symbol: string): Promise<number | undefined>;
  getOpenInterest?(symbol: string): Promise<number | undefined>;
  close(): Promise<void>;
}
