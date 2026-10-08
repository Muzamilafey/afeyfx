import { isLiveTradingEnabledByEnv } from '../config/env';
import { circuitBreaker } from '../risk/CircuitBreaker';
import { tradingState } from '../services/TradingState';
import { LiveTradingDisabledError } from '../utils/errors';

export type OrderIntent = 'OPEN' | 'REDUCE';

export interface GuardResult {
  allowed: boolean;
  reasons: string[];
}

/**
 * The last line of defence before a real order reaches an exchange. Called by the execution
 * service AND inside every exchange adapter's createOrder (defence in depth).
 *
 * Real orders are refused unless ALL of the following hold:
 *  1. LIVE_TRADING_ENABLED=true in the process environment (hard kill switch; not settable via UI)
 *  2. trading mode is LIVE
 *  3. live mode was explicitly activated by an authorized admin after a passing preflight
 *  4. for position-opening orders: no emergency shutdown, trading not stopped, circuit breaker closed
 *
 * Risk-reducing orders (closing positions) are still permitted while the circuit breaker is open,
 * so exposure can always be reduced - but never when the env kill switch is off.
 */
export function checkLiveOrder(intent: OrderIntent): GuardResult {
  const reasons: string[] = [];
  const s = tradingState.get();
  if (!isLiveTradingEnabledByEnv()) reasons.push('LIVE_TRADING_ENABLED is not true');
  if (s.mode !== 'LIVE') reasons.push('Trading mode is not LIVE');
  if (!s.liveModeActive) reasons.push('Live mode has not been activated by an authorized user');
  if (intent === 'OPEN') {
    if (s.emergencyShutdown) reasons.push('Emergency shutdown is active');
    if (!s.tradingEnabled) reasons.push('New trades are stopped');
    if (!circuitBreaker.canOpenNewPositions()) reasons.push(`Circuit breaker open (${circuitBreaker.reasons().join('; ')})`);
  }
  return { allowed: reasons.length === 0, reasons };
}

export function assertLiveOrderAllowed(intent: OrderIntent): void {
  const r = checkLiveOrder(intent);
  if (!r.allowed) throw new LiveTradingDisabledError(r.reasons.join('; '));
}
