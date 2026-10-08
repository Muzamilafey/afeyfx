export type TradingMode = 'BACKTEST' | 'PAPER' | 'LIVE';
export type Side = 'buy' | 'sell';
export type Direction = 'LONG' | 'SHORT';
export type SignalAction = 'LONG' | 'SHORT' | 'EXIT' | 'HOLD';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type Role = 'admin' | 'trader' | 'viewer';

export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export type MarketRegime =
  | 'TRENDING_UP'
  | 'TRENDING_DOWN'
  | 'SIDEWAYS'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY'
  | 'ABNORMAL';

export interface Candle {
  /** Open time, epoch ms (UTC). */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  symbol: string;
  timestamp: number;
  last: number;
  bid: number;
  ask: number;
  high24h?: number;
  low24h?: number;
  change24hPct?: number;
  baseVolume?: number;
  quoteVolume?: number;
}

export interface OrderBookLevel {
  price: number;
  amount: number;
}

export interface OrderBook {
  symbol: string;
  timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface Balance {
  currency: string;
  free: number;
  used: number;
  total: number;
}

export type OrderType = 'market' | 'limit' | 'stop_loss' | 'take_profit' | 'trailing_stop';
export type OrderStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  amount: number;
  price?: number;
  stopPrice?: number;
  trailingPct?: number;
  clientOrderId: string;
  reduceOnly?: boolean;
}

export interface ExchangeOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  side: Side;
  type: string;
  status: OrderStatus;
  price?: number;
  average?: number;
  amount: number;
  filled: number;
  remaining: number;
  fee?: number;
  feeCurrency?: string;
  timestamp: number;
  raw?: unknown;
}

export interface ExchangeTrade {
  id: string;
  orderId?: string;
  symbol: string;
  side: Side;
  price: number;
  amount: number;
  fee: number;
  feeCurrency?: string;
  timestamp: number;
}

export interface ExchangePosition {
  symbol: string;
  side: Direction;
  amount: number;
  entryPrice: number;
  markPrice?: number;
  unrealizedPnl?: number;
  leverage?: number;
}

export interface MarketInfo {
  symbol: string;
  base: string;
  quote: string;
  active: boolean;
  type: string;
  minAmount?: number;
  amountPrecision?: number;
  pricePrecision?: number;
  takerFee?: number;
  makerFee?: number;
}
