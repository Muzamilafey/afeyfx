export type Mode = 'PAPER' | 'LIVE';
export type Role = 'admin' | 'trader' | 'viewer';

export interface User {
  _id: string;
  email: string;
  name: string;
  role: Role;
  twoFactorEnabled: boolean;
  lastLoginAt?: string;
  active: boolean;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSummary {
  exchange: string;
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  spreadPct: number;
  change24hPct?: number;
  volume24h?: number;
  volatility?: number;
  dataAgeMs: number;
  unavailable?: boolean;
}

export interface Portfolio {
  mode: Mode;
  baseCurrency: string;
  startingBalance: number;
  balance: number;
  equity: number;
  available: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fees: number;
  exposure: number;
  exposurePct: number;
  drawdown: number;
  dailyPnl: number;
  dailyPnlPct: number;
  dailyDrawdownPct: number;
  weeklyDrawdownPct: number;
  totalPnl: number;
}

export interface Position {
  _id: string;
  mode: Mode;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED';
  amount: number;
  entryPrice: number;
  currentPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPnl: number;
  realizedPnl: number;
  strategyKey?: string;
  openedAt: string;
}

export interface Trade {
  _id: string;
  mode: Mode;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strategyKey?: string;
  timeframe?: string;
  amount: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  returnPct: number;
  exitReason: string;
  openedAt: string;
  closedAt: string;
}

export interface Order {
  _id: string;
  mode: Mode;
  idempotencyKey: string;
  exchange: string;
  exchangeOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  amount: number;
  price?: number;
  status: string;
  filled: number;
  averagePrice?: number;
  fee: number;
  purpose: string;
  rejectReason?: string;
  createdAt: string;
}

export interface Signal {
  _id: string;
  mode: Mode;
  strategyKey: string;
  symbol: string;
  timeframe: string;
  action: string;
  confidence: number;
  price: number;
  regime: string;
  reason: string;
  decision: 'EXECUTE' | 'REJECT' | 'PENDING';
  decisionReasons: string[];
  createdAt: string;
}

export interface AIAnalysis {
  _id: string;
  kind: string;
  symbol?: string;
  timeframe?: string;
  model?: string;
  signal?: string;
  confidence?: number;
  marketRegime?: string;
  riskLevel?: string;
  newsSentiment?: string;
  newsCount?: number;
  reason?: string;
  status: string;
  error?: string;
  createdAt: string;
  output?: { keyRisks?: string[]; dataQualityConcerns?: string[] };
}

export interface CircuitTrip {
  code: string;
  message: string;
  at: number;
  autoReset: boolean;
}

export interface RiskStatus {
  mode: Mode;
  config: Record<string, number | boolean>;
  circuitBreaker: { open: boolean; trips: CircuitTrip[] };
  tradingEnabled: boolean;
  emergencyShutdown: boolean;
  exposure: { value: number; pct: number; max: number };
  dailyLoss: { pct: number; max: number; pnl: number };
  weeklyLoss: { pct: number; max: number };
  openPositions: { count: number; max: number };
  riskPerTrade: number;
}

export interface Metrics {
  startingBalance: number;
  endingEquity: number;
  totalReturn: number;
  totalPnl: number;
  numberOfTrades: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  averageTrade: number;
  maxDrawdown: number;
  sharpe: number | null;
  sortino: number | null;
  longestWinStreak: number;
  longestLossStreak: number;
  totalFees: number;
  totalSlippage: number;
}

export interface StrategyDoc {
  _id: string;
  key: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  stage: string;
  symbols: string[];
  timeframes: string[];
  riskLevel: string;
  params: Record<string, number>;
  allowedRegimes: string[];
  requireAiConfirmation: boolean;
  requiredIndicators: string[];
}

export interface BacktestRun {
  _id: string;
  segment: string;
  window?: number;
  status: string;
  metrics?: Metrics;
  warnings?: string[];
  error?: string;
  equityCurve?: { t: number; equity: number }[];
  trades?: unknown[];
  candles?: number;
  params?: unknown;
}

export interface Backtest {
  _id: string;
  name?: string;
  strategyKey: string;
  symbol: string;
  timeframe: string;
  type: 'SIMPLE' | 'WALK_FORWARD';
  createdAt: string;
  runs: BacktestRun[];
}

export interface HealthComponent {
  status: 'ok' | 'degraded' | 'down' | 'disabled';
  detail?: unknown;
}

export interface SystemHealth {
  status: string;
  time: string;
  uptimeSec: number;
  trading: { mode: Mode; liveTradingEnabledByEnv: boolean; liveModeActive: boolean; tradingEnabled: boolean; emergencyShutdown: boolean; circuitBreaker: { open: boolean; trips: CircuitTrip[] } };
  components: Record<string, HealthComponent>;
}
