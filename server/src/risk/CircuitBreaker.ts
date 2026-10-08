export type TripCode =
  | 'DAILY_LOSS_LIMIT'
  | 'WEEKLY_LOSS_LIMIT'
  | 'STALE_MARKET_DATA'
  | 'EXCHANGE_DISCONNECTED'
  | 'ABNORMAL_SPREAD'
  | 'EXCESSIVE_SLIPPAGE'
  | 'EXCHANGE_API_ERRORS'
  | 'RISK_ENGINE_UNAVAILABLE'
  | 'DATABASE_UNAVAILABLE'
  | 'CLOCK_DRIFT'
  | 'UNEXPECTED_BALANCE_CHANGE'
  | 'RECONCILIATION_MISMATCH'
  | 'MANUAL_STOP'
  | 'EMERGENCY_SHUTDOWN';

/** Trips that clear automatically once the underlying condition recovers. Everything else needs a human. */
const AUTO_RESET: ReadonlySet<TripCode> = new Set<TripCode>([
  'STALE_MARKET_DATA',
  'EXCHANGE_DISCONNECTED',
  'ABNORMAL_SPREAD',
  'DATABASE_UNAVAILABLE',
  'CLOCK_DRIFT',
  'RISK_ENGINE_UNAVAILABLE',
]);

export interface Trip {
  code: TripCode;
  message: string;
  at: number;
  autoReset: boolean;
}

type Listener = (event: 'trip' | 'reset', trip: Trip) => void;

/**
 * Circuit breaker that stops NEW positions from being opened. Fail-closed: while any trip is
 * active, `canOpenNewPositions()` is false. Exits/stop-losses are still allowed so risk can be reduced.
 */
export class CircuitBreaker {
  private trips = new Map<TripCode, Trip>();
  private listeners: Listener[] = [];
  private apiErrors: number[] = [];

  constructor(
    private opts = { apiErrorWindowMs: 60_000, apiErrorThreshold: 5 },
  ) {}

  onChange(l: Listener) {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  trip(code: TripCode, message: string) {
    if (this.trips.has(code)) return;
    const t: Trip = { code, message, at: Date.now(), autoReset: AUTO_RESET.has(code) };
    this.trips.set(code, t);
    for (const l of this.listeners) l('trip', t);
  }

  /** Clear an auto-resettable condition when it recovers. Manual trips are ignored. */
  recover(code: TripCode) {
    const t = this.trips.get(code);
    if (t && t.autoReset) {
      this.trips.delete(code);
      for (const l of this.listeners) l('reset', t);
    }
  }

  /** Human reset (admin action). */
  reset(code: TripCode) {
    const t = this.trips.get(code);
    if (t) {
      this.trips.delete(code);
      for (const l of this.listeners) l('reset', t);
    }
  }

  resetAll() {
    for (const code of [...this.trips.keys()]) this.reset(code);
  }

  isTripped(code?: TripCode) {
    return code ? this.trips.has(code) : this.trips.size > 0;
  }

  canOpenNewPositions() {
    return this.trips.size === 0;
  }

  reasons(): string[] {
    return [...this.trips.values()].map((t) => `${t.code}: ${t.message}`);
  }

  status() {
    return { open: this.trips.size > 0, trips: [...this.trips.values()] };
  }

  /** Record an exchange API error; trips when the rolling count exceeds the threshold. */
  recordApiError(message: string) {
    const now = Date.now();
    this.apiErrors = this.apiErrors.filter((t) => now - t < this.opts.apiErrorWindowMs);
    this.apiErrors.push(now);
    if (this.apiErrors.length >= this.opts.apiErrorThreshold) {
      this.trip('EXCHANGE_API_ERRORS', `${this.apiErrors.length} API errors in ${this.opts.apiErrorWindowMs / 1000}s (last: ${message})`);
    }
  }

  checkDrawdown(dailyPct: number, weeklyPct: number, maxDaily: number, maxWeekly: number) {
    if (dailyPct >= maxDaily) this.trip('DAILY_LOSS_LIMIT', `Daily loss ${(dailyPct * 100).toFixed(2)}% >= ${(maxDaily * 100).toFixed(2)}%`);
    if (weeklyPct >= maxWeekly) this.trip('WEEKLY_LOSS_LIMIT', `Weekly loss ${(weeklyPct * 100).toFixed(2)}% >= ${(maxWeekly * 100).toFixed(2)}%`);
  }

  checkDataFreshness(ageMs: number, maxAgeMs: number, label = '') {
    if (!(ageMs >= 0) || ageMs > maxAgeMs) this.trip('STALE_MARKET_DATA', `Market data ${label} is ${Math.round(ageMs)}ms old (max ${maxAgeMs}ms)`);
    else this.recover('STALE_MARKET_DATA');
  }

  checkClockDrift(driftMs: number, maxDriftMs: number) {
    if (!Number.isFinite(driftMs) || Math.abs(driftMs) > maxDriftMs) this.trip('CLOCK_DRIFT', `Clock drift ${driftMs}ms exceeds ${maxDriftMs}ms`);
    else this.recover('CLOCK_DRIFT');
  }

  checkSpread(spreadPct: number, maxSpreadPct: number, symbol: string) {
    // Abnormal = several multiples of the per-trade limit.
    if (spreadPct > maxSpreadPct * 5) this.trip('ABNORMAL_SPREAD', `${symbol} spread ${(spreadPct * 100).toFixed(3)}%`);
  }

  checkSlippage(slippagePct: number, maxSlippagePct: number, symbol: string) {
    if (slippagePct > maxSlippagePct) this.trip('EXCESSIVE_SLIPPAGE', `${symbol} realized slippage ${(slippagePct * 100).toFixed(3)}% > ${(maxSlippagePct * 100).toFixed(3)}%`);
  }
}

export const circuitBreaker = new CircuitBreaker();
