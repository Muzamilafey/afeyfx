import { env, isLiveTradingEnabledByEnv } from '../../config/env';
import type { BrokerConnectionDoc } from '../../models/BrokerConnection';
import { PositionModel } from '../../models/Position';
import { circuitBreaker } from '../../risk/CircuitBreaker';
import { tradingState } from '../../services/TradingState';
import type { BrokerAccountInfo, BrokerOrderRequest, InstrumentSpec, Side } from '../core/types';
import { brokerMarketData } from './BrokerDataServices';

/**
 * Server-side risk checks and position sizing for an order on a user's broker account.
 * Every check must pass; anything missing or uncertain is a rejection (fail closed).
 * Limits are configurable per connection (conservative defaults: 0.5% risk per trade, 2% daily /
 * 5% weekly drawdown, 1x leverage). These are configuration values, not a guarantee of safety.
 */
export interface RiskCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface BrokerRiskInput {
  conn: BrokerConnectionDoc;
  account: BrokerAccountInfo;
  instrument: InstrumentSpec | null;
  req: BrokerOrderRequest;
  /** Planned stop / target as PRICES (used for sizing and validation). */
  stopPrice?: number;
  takeProfitPrice?: number;
  /** When true, the volume/stake was chosen by the user and is only validated (not sized). */
  userSized: boolean;
}

export interface BrokerRiskResult {
  approved: boolean;
  reasons: string[];
  checks: RiskCheckResult[];
  /** Final order (with volume/stake and SL/TP amounts filled in). */
  order: BrokerOrderRequest;
  maxLoss: number;
  exposure: number;
  leverage: number;
  quote: { bid: number; ask: number; ageMs: number } | null;
}

const floorStep = (v: number, step: number) => Math.floor(v / step + 1e-9) * step;

export class BrokerRiskService {
  async evaluate(i: BrokerRiskInput): Promise<BrokerRiskResult> {
    const { conn, account, instrument } = i;
    const L = conn.riskLimits ?? ({} as NonNullable<BrokerConnectionDoc['riskLimits']>);
    const lim = { maxRiskPerTrade: L.maxRiskPerTrade ?? 0.005, maxDailyLoss: L.maxDailyLoss ?? 0.02, maxWeeklyLoss: L.maxWeeklyLoss ?? 0.05, maxLeverage: L.maxLeverage ?? 1, maxOpenPositions: L.maxOpenPositions ?? 3, maxExposurePct: L.maxExposurePct ?? 0.2, maxSpreadPct: L.maxSpreadPct ?? 0.002, maxQuoteAgeMs: L.maxQuoteAgeMs ?? 10_000, maxConsecutiveFailures: L.maxConsecutiveFailures ?? 3 };
    const checks: RiskCheckResult[] = [];
    const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
    const order: BrokerOrderRequest = { ...i.req };
    const state = tradingState.get();

    // --- authorization & switches -------------------------------------------------------------
    add('connection', conn.status === 'CONNECTED', `Connection ${conn.status}`);
    add('trading-enabled', conn.tradingEnabled === true, conn.tradingEnabled ? 'Trading enabled on this account' : 'Trading is disabled for this account');
    if (conn.environment === 'real') {
      add('live-env-switch', isLiveTradingEnabledByEnv(), isLiveTradingEnabledByEnv() ? 'LIVE_TRADING_ENABLED=true' : 'Server LIVE_TRADING_ENABLED is not true');
      add('live-user-allowed', env.BROKER_USER_LIVE_ALLOWED, env.BROKER_USER_LIVE_ALLOWED ? 'Admin allows user live trading' : 'Live trading on user broker accounts is not allowed by the admin');
      add('live-enabled', conn.liveEnabled === true, conn.liveEnabled ? 'Live trading confirmed for this account' : 'Live trading has not been confirmed for this account');
    }
    add('account-type', account.environment === conn.environment, `Broker reports ${account.environment}, connection is ${conn.environment}`);
    add('emergency', !state.emergencyShutdown && state.tradingEnabled, state.emergencyShutdown ? 'Emergency shutdown active' : state.tradingEnabled ? 'Trading allowed' : 'New trades are stopped');
    add('connection-breaker', !conn.breaker?.tripped, conn.breaker?.tripped ? `Halted: ${conn.breaker.reason}` : 'OK');
    add('failure-streak', (conn.consecutiveFailures ?? 0) < lim.maxConsecutiveFailures, `${conn.consecutiveFailures ?? 0} consecutive execution failures (max ${lim.maxConsecutiveFailures})`);
    const dbDown = circuitBreaker.isTripped('DATABASE_UNAVAILABLE');
    add('safety-records', !dbDown, dbDown ? 'Database unavailable for safety records' : 'OK');

    // --- instrument & market data -------------------------------------------------------------
    add('instrument', !!instrument && instrument.tradable, instrument ? (instrument.tradable ? `${instrument.brokerSymbol} tradable` : `${instrument.brokerSymbol} not tradable`) : `${order.brokerSymbol} is not offered on this account (sync instruments)`);
    if (instrument?.marketOpen === false) add('market-open', false, 'Market is closed');
    const q = brokerMarketData.quote(conn._id.toString(), order.brokerSymbol);
    const quoteOk = !!q && q.ageMs <= lim.maxQuoteAgeMs && q.bid > 0 && q.ask > 0;
    add('quote-fresh', quoteOk, q ? `Quote age ${q.ageMs}ms (max ${lim.maxQuoteAgeMs}ms)` : 'No live quote from the broker');
    const price = q ? (order.side === 'buy' ? q.ask : q.bid) : 0;
    const mid = q ? (q.bid + q.ask) / 2 : 0;
    const spreadPct = q && mid > 0 ? (q.ask - q.bid) / mid : Infinity;
    add('spread', spreadPct <= lim.maxSpreadPct, `Spread ${(spreadPct * 100).toFixed(4)}% (max ${(lim.maxSpreadPct * 100).toFixed(3)}%)`);
    order.referencePrice = price || order.referencePrice;

    // --- protective levels ----------------------------------------------------------------------
    const isBuy = order.side === 'buy';
    const stop = i.stopPrice;
    const tp = i.takeProfitPrice;
    if (order.product !== 'rise_fall') {
      const stopOk = !!stop && price > 0 && (isBuy ? stop < price : stop > price);
      add('stop-loss', stopOk, stop ? (stopOk ? `Stop ${stop}` : 'Stop loss is on the wrong side of the price') : 'A stop loss is required');
      if (tp !== undefined) add('take-profit', price > 0 && (isBuy ? tp > price : tp < price), 'Take profit must be beyond the entry price');
    }

    // --- drawdown & exposure --------------------------------------------------------------------
    const equity = account.equity ?? account.balance;
    const dayDd = conn.dayStartEquity ? Math.max(0, (conn.dayStartEquity - equity) / conn.dayStartEquity) : 0;
    const weekDd = conn.weekStartEquity ? Math.max(0, (conn.weekStartEquity - equity) / conn.weekStartEquity) : 0;
    add('daily-loss', dayDd < lim.maxDailyLoss, `Daily drawdown ${(dayDd * 100).toFixed(2)}% (limit ${(lim.maxDailyLoss * 100).toFixed(2)}%)`);
    add('weekly-loss', weekDd < lim.maxWeeklyLoss, `Weekly drawdown ${(weekDd * 100).toFixed(2)}% (limit ${(lim.maxWeeklyLoss * 100).toFixed(2)}%)`);
    const open = await PositionModel.find({ connection: conn._id, status: 'OPEN' }).lean();
    add('open-positions', open.length < lim.maxOpenPositions, `${open.length} open (max ${lim.maxOpenPositions})`);

    // --- sizing (in the ACCOUNT currency) -----------------------------------------------------
    // Size = the smaller of (a) the risk budget at the stop and (b) the exposure / leverage caps.
    const riskBudget = equity * lim.maxRiskPerTrade;
    const openExposure = open.reduce((s, p) => s + Number((p.brokerData as { exposure?: number } | undefined)?.exposure ?? 0), 0);
    const exposureRoom = Math.max(0, Math.min(equity * lim.maxLeverage, equity * lim.maxExposurePct - openExposure));
    let maxLoss = 0;
    let exposure = 0;
    if (order.product === 'cfd') {
      const ok = !!instrument?.tickSize && !!instrument?.tickValue && !!instrument?.volumeStep && !!instrument?.volumeMin;
      add('instrument-spec', ok, ok ? 'Contract specification available' : 'Missing tick size/value or volume limits from the broker');
      if (ok && stop && price) {
        const valuePerPriceUnitPerLot = instrument!.tickValue! / instrument!.tickSize!; // account ccy per 1.0 price move per lot
        const lossPerLot = Math.abs(price - stop) * valuePerPriceUnitPerLot;
        if (!i.userSized) order.volume = floorStep(Math.min(riskBudget / lossPerLot, exposureRoom / (price * valuePerPriceUnitPerLot)), instrument!.volumeStep!);
        const vol = order.volume ?? 0;
        const stepOk = Math.abs(vol / instrument!.volumeStep! - Math.round(vol / instrument!.volumeStep!)) < 1e-6;
        add('volume', vol >= instrument!.volumeMin! && (!instrument!.volumeMax || vol <= instrument!.volumeMax) && stepOk, `${vol} lots (min ${instrument!.volumeMin}, step ${instrument!.volumeStep}${instrument!.volumeMax ? `, max ${instrument!.volumeMax}` : ''})${!i.userSized && vol < instrument!.volumeMin! ? ' — the risk budget is smaller than the minimum lot' : ''}`);
        maxLoss = lossPerLot * vol;
        exposure = price * valuePerPriceUnitPerLot * vol;
        add('risk-per-trade', maxLoss <= riskBudget * 1.0001, `Loss at stop ${maxLoss.toFixed(2)} (budget ${riskBudget.toFixed(2)})`);
        if (account.freeMargin !== null && account.leverage) add('margin', account.freeMargin >= exposure / account.leverage, `Free margin ${account.freeMargin.toFixed(2)} vs ≈${(exposure / account.leverage).toFixed(2)} required`);
      }
    } else if (order.product === 'multiplier') {
      const m = order.multiplier ?? 0;
      add('multiplier', m > 0 && (!instrument?.multipliers?.length || instrument.multipliers.includes(m)), `Multiplier x${m}`);
      if (stop && price && m > 0) {
        const stopPct = Math.abs(price - stop) / price;
        if (!i.userSized) order.stake = Math.floor((Math.min(riskBudget / stopPct, exposureRoom) / m) * 100) / 100;
        const stake = order.stake ?? 0;
        exposure = stake * m;
        maxLoss = Math.min(stake, exposure * stopPct);
        order.stopLossAmount = Math.max(0.01, Math.round(maxLoss * 100) / 100);
        if (tp) order.takeProfitAmount = Math.max(0.01, Math.round(exposure * (Math.abs(tp - price) / price) * 100) / 100);
        add('stake', stake >= (instrument?.minStake ?? 1) && (!instrument?.maxStake || stake <= instrument.maxStake) && stake <= account.balance, `Stake ${stake.toFixed(2)} (min ${instrument?.minStake ?? 1}, balance ${account.balance.toFixed(2)})`);
        add('risk-per-trade', maxLoss <= riskBudget * 1.0001, `Loss at stop ${maxLoss.toFixed(2)} (budget ${riskBudget.toFixed(2)})`);
      }
    } else {
      // Rise/Fall: the stake is the maximum loss.
      if (!i.userSized) order.stake = Math.floor(riskBudget * 100) / 100;
      const stake = order.stake ?? 0;
      maxLoss = stake;
      exposure = stake;
      add('stake', stake >= (instrument?.minStake ?? 0.35) && stake <= account.balance, `Stake ${stake.toFixed(2)}`);
      add('risk-per-trade', maxLoss <= riskBudget * 1.0001, `Max loss ${maxLoss.toFixed(2)} (budget ${riskBudget.toFixed(2)})`);
      add('duration', !!order.duration && !!order.durationUnit, 'Contract duration set');
    }
    const leverage = equity > 0 ? exposure / equity : Infinity;
    add('leverage', leverage <= lim.maxLeverage + 1e-9, `Leverage ${leverage.toFixed(2)}x (max ${lim.maxLeverage}x)`);
    add('portfolio-exposure', equity > 0 && (openExposure + exposure) / equity <= lim.maxExposurePct + 1e-9, `Exposure after ${(((openExposure + exposure) / Math.max(equity, 1e-9)) * 100).toFixed(1)}% of equity`);

    const failed = checks.filter((c) => !c.passed);
    return { approved: failed.length === 0, reasons: failed.map((c) => `${c.name}: ${c.detail}`), checks, order, maxLoss, exposure, leverage, quote: q ? { bid: q.bid, ask: q.ask, ageMs: q.ageMs } : null };
  }
}

export const brokerRisk = new BrokerRiskService();
export type { Side };
