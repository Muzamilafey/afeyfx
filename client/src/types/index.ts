export type Mode = 'PAPER' | 'LIVE' | 'REAL';
export type AccountType = 'DEMO' | 'REAL';
export type MarketCategory = 'crypto' | 'forex' | 'metals';
export type Role = 'admin' | 'trader' | 'viewer';

export interface User {
  _id: string;
  email: string;
  name: string;
  role: Role;
  twoFactorEnabled: boolean;
  emailOtpEnabled?: boolean;
  emailVerified?: boolean;
  passwordSet?: boolean;
  googleId?: string;
  githubId?: string;
  avatarUrl?: string;
  lastLoginAt?: string;
  active: boolean;
}

export type SecondFactor = 'totp' | 'email';

export interface AuthConfig {
  googleEnabled: boolean;
  googleRedirectEnabled: boolean;
  githubEnabled: boolean;
  signupEnabled: boolean;
  emailEnabled: boolean;
  requireEmailVerification: boolean;
}

export interface DemoAccount extends Portfolio {
  type: AccountType;
}
export type TraderAccount = DemoAccount;

export interface Features {
  email: boolean;
  googleSignIn: boolean;
  githubSignIn: boolean;
  ai: boolean;
  telegram: boolean;
  news: boolean;
  forex: boolean;
  deposits: boolean;
  payouts: boolean;
  realTrading: boolean;
  realAccount: boolean;
  derivConnect?: boolean;
  mt5Connect?: boolean;
}

export type PaymentStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'REJECTED' | 'CANCELLED' | 'UNCERTAIN';
export interface Payment {
  id: string;
  user: string;
  reference: string;
  type: 'DEPOSIT' | 'PAYOUT';
  method: string;
  status: PaymentStatus;
  amount: number;
  fee: number;
  net: number;
  amountKes: number;
  rate: number;
  phone: string;
  receipt: string | null;
  message: string | null;
  createdAt: string;
  completedAt: string | null;
  // admin view
  userEmail?: string;
  firstName?: string;
  lastName?: string;
  provider?: string;
  resultCode?: string;
  resultDesc?: string;
  knownDestination?: boolean;
  credited?: boolean;
  held?: boolean;
  refunded?: boolean;
  reviewNote?: string;
}

export interface PaymentPublicConfig {
  currency: string;
  methods: { id: string; name: string; instant: boolean }[];
  deposits: { enabled: boolean; minUsd: number; maxUsd: number; rate: number };
  payouts: { enabled: boolean; minUsd: number; maxUsd: number; dailyLimitUsd: number; rate: number; feePct: number; feeFixedUsd: number; depositPhonesOnly: boolean };
  realTradingEnabled: boolean;
  sandbox: boolean;
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
  category?: MarketCategory;
  name?: string;
  base?: string;
  quote?: string;
  pricePrecision?: number;
  marketOpen?: boolean;
  /** Forex & metals: units per standard lot and pip size (price terms). */
  contractSize?: number;
  pipSize?: number;
  /** USD per 1 unit of the quote currency (1 for USD/USDT quotes). */
  quoteUsd?: number | null;
  /** Commission per side as a fraction of notional. */
  feeRate?: number;
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
  /** Forex/metals positions opened in lots. */
  lots?: number;
  contractSize?: number;
  entryPrice: number;
  currentPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPnl: number;
  realizedPnl: number;
  strategyKey?: string;
  openedAt: string;
  exchange?: string;
  /** USD per quote-currency unit at entry (1 for USD/USDT pairs). */
  quoteRate?: number;
  broker?: string;
}

export interface Trade {
  _id: string;
  mode: Mode;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strategyKey?: string;
  timeframe?: string;
  amount: number;
  lots?: number;
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
  quoteRate?: number;
  broker?: string;
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
