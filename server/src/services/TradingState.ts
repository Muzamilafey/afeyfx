import { env } from '../config/env';
import { DEFAULT_RISK_CONFIG, type RiskConfig } from '../risk/RiskEngine';

export interface AiSettings {
  enabled: boolean;
  model: string;
  minConfidence: number;
  /** When true, AI must agree with the strategy direction for an entry to proceed. */
  requireAgreement: boolean;
}

export interface TradingStateShape {
  mode: 'PAPER' | 'LIVE';
  liveModeActive: boolean;
  tradingEnabled: boolean;
  emergencyShutdown: boolean;
  emergencyReason?: string;
  risk: RiskConfig;
  ai: AiSettings;
  arbitrageMinNetProfitPct: number;
}

/**
 * In-memory, synchronously-readable trading state, hydrated from the Settings document at
 * startup and updated whenever an admin changes settings. Synchronous access lets safety
 * checks (LiveTradingGuard) run without I/O immediately before order submission.
 *
 * Note: the platform always boots in PAPER mode with live mode inactive, regardless of what was
 * persisted. Re-enabling LIVE after a restart requires a fresh preflight + explicit confirmation.
 */
function initial(): TradingStateShape {
  return {
    mode: 'PAPER',
    liveModeActive: false,
    tradingEnabled: true,
    emergencyShutdown: false,
    risk: {
      ...DEFAULT_RISK_CONFIG,
      maxRiskPerTrade: env.MAX_RISK_PER_TRADE,
      maxDailyLoss: env.MAX_DAILY_LOSS,
      maxWeeklyLoss: env.MAX_WEEKLY_LOSS,
      maxOpenPositions: env.MAX_OPEN_POSITIONS,
      maxPortfolioExposure: env.MAX_PORTFOLIO_EXPOSURE,
      maxLeverage: env.MAX_LEVERAGE,
      maxSpreadPct: env.MAX_SPREAD_PCT,
      maxSlippagePct: env.MAX_SLIPPAGE_PCT,
    },
    ai: { enabled: env.AI_ENABLED, model: env.AI_MODEL, minConfidence: env.AI_MIN_CONFIDENCE, requireAgreement: true },
    arbitrageMinNetProfitPct: 0.002,
  };
}

let state: TradingStateShape = initial();

export const tradingState = {
  get: (): Readonly<TradingStateShape> => state,
  update(partial: Partial<TradingStateShape>) {
    state = { ...state, ...partial };
    return state;
  },
  updateRisk(partial: Partial<RiskConfig>) {
    state = { ...state, risk: { ...state.risk, ...partial } };
    return state;
  },
  reset() {
    state = initial();
    return state;
  },
};
