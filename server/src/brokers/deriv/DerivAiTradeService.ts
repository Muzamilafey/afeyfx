import type { DerivAnalysis } from '../../ai/schemas';
import type { BrokerConnectionDoc } from '../../models/BrokerConnection';
import { AIAnalysisModel } from '../../models/AIAnalysis';
import { OrderModel } from '../../models/Order';
import { AppError } from '../../utils/errors';
import { brokerOrders } from '../services/BrokerOrderService';
import { brokerMarketData } from '../services/BrokerDataServices';
import { derivAnalysis } from './DerivAnalysisService';
import { DERIV_GRANULARITIES, derivMarket } from './DerivMarketService';

/** An AI analysis can be acted on only while it is this fresh. */
export const AI_TRADE_MAX_AGE_MS = 5 * 60_000;
/** Below this subjective score the AI's direction is not acted on. */
export const AI_TRADE_MIN_CONFIDENCE = 0.55;
/** Stop / target distances in ATRs (deterministic, never taken from the model). */
const STOP_ATR = 1.5;
const TARGET_ATR = 3;

export interface AiTradeOptions {
  product: 'multiplier' | 'rise_fall';
  multiplier?: number;
  duration?: number;
  durationUnit?: 't' | 's' | 'm' | 'h' | 'd';
}

/** Rise/Fall default: five bars of the analysed timeframe. */
function defaultDuration(timeframe: string): { duration: number; durationUnit: 'm' | 'h' } {
  const minutes = (DERIV_GRANULARITIES[timeframe] * 5) / 60;
  return minutes < 60 ? { duration: minutes, durationUnit: 'm' } : { duration: Math.min(Math.round(minutes / 60), 24), durationUnit: 'h' };
}

/**
 * "Trade with AI": turns a fresh, validated AI analysis into ONE order the user confirms with a click.
 *
 * - The direction comes from the AI, but only if the AI did not advise against trading, its score is
 *   above the minimum, fresh market data is not stale and the deterministic indicator reading does
 *   not point the other way.
 * - Stop, target and stake are NOT taken from the model: stop/target come from ATR and the stake is
 *   sized by the server-side risk engine from the account's risk limits, which has the final say.
 * - The plan is always recomputed on the server; the browser only sends the analysis id.
 * - Each analysis can produce at most one order (idempotency key derived from it).
 * - Real accounts additionally need every live-trading gate (server switch, admin, per-account
 *   confirmation); demo accounts work immediately.
 */
export class DerivAiTradeService {
  async plan(conn: BrokerConnectionDoc, userId: string, analysisId: string, opts: AiTradeOptions) {
    if (!/^[0-9a-f]{24}$/.test(analysisId)) throw new AppError(404, 'AI analysis not found');
    const a = await AIAnalysisModel.findOne({ _id: analysisId, kind: 'DERIV_ANALYSIS', status: 'OK', 'inputSummary.user': userId });
    if (!a) throw new AppError(404, 'AI analysis not found');
    const out = a.output as DerivAnalysis;
    const blockers: string[] = [];
    const ageMs = Date.now() - new Date(a.createdAt as Date).getTime();
    if (ageMs > AI_TRADE_MAX_AGE_MS) blockers.push(`The analysis is ${Math.round(ageMs / 60_000)} min old — run a new one (max ${AI_TRADE_MAX_AGE_MS / 60_000} min)`);
    if (out.avoidTrading) blockers.push(`The AI advises not to trade: ${out.reasonsToAvoid.join('; ') || 'no reason given'}`);
    if (out.assessment === 'NEUTRAL') blockers.push('The AI sees no clear direction (NEUTRAL) — no trade');
    if (out.confidence < AI_TRADE_MIN_CONFIDENCE) blockers.push(`AI score ${out.confidence.toFixed(2)} is below the minimum ${AI_TRADE_MIN_CONFIDENCE}`);

    // Re-check the market NOW with real Deriv data (never trust the browser or an old snapshot).
    const snap = await derivAnalysis.snapshot(conn, out.symbol, out.timeframe);
    const rules = derivAnalysis.ruleBased(snap);
    if (snap.dataQuality.stale) blockers.push('Market data is stale');
    if (!snap.dataQuality.sufficient) blockers.push('Not enough price history');
    if (snap.dataQuality.marketOpen === false) blockers.push('Market is closed');
    if (snap.regime.regime === 'ABNORMAL') blockers.push(`Abnormal market: ${snap.regime.reason}`);
    if ((out.assessment === 'BULLISH' && rules.assessment === 'BEARISH') || (out.assessment === 'BEARISH' && rules.assessment === 'BULLISH')) blockers.push(`The indicators now point the other way (${rules.assessment})`);
    const atr = snap.indicators.atr;
    // Anchor stop/target to the LIVE price the risk engine will check (not the last candle close).
    const cid = conn._id.toString();
    if (!brokerMarketData.quote(cid, out.symbol)) await (await derivMarket.adapter(conn)).subscribeQuotes([out.symbol]).catch(() => undefined);
    const q = brokerMarketData.quote(cid, out.symbol);
    const price = q && q.ageMs < 30_000 ? (q.bid + q.ask) / 2 : snap.price;
    if (!atr || !(atr > 0) || !Number.isFinite(price)) blockers.push('ATR / price unavailable — cannot set a stop');

    const side: 'buy' | 'sell' = out.assessment === 'BEARISH' ? 'sell' : 'buy';
    const dir = side === 'buy' ? 1 : -1;
    const stopLoss = atr ? price - dir * STOP_ATR * atr : undefined;
    const takeProfit = atr ? price + dir * TARGET_ATR * atr : undefined;
    let multiplier = opts.multiplier;
    let duration = opts.duration;
    let durationUnit = opts.durationUnit;
    if (opts.product === 'multiplier') {
      const off = await derivMarket.offerings(conn, out.symbol);
      if (!off.multiplier.available) blockers.push(`Multipliers are not offered on ${out.symbol} for this account`);
      else if (multiplier === undefined) multiplier = off.multiplier.multipliers[0]; // lowest = least leverage
      else if (!off.multiplier.multipliers.includes(multiplier)) blockers.push(`Multiplier x${multiplier} is not offered (available: ${off.multiplier.multipliers.join(', ')})`);
    } else if (duration === undefined || durationUnit === undefined) ({ duration, durationUnit } = defaultDuration(out.timeframe));

    const order = {
      brokerSymbol: out.symbol,
      side,
      product: opts.product,
      multiplier: opts.product === 'multiplier' ? multiplier : undefined,
      stopLoss: opts.product === 'multiplier' ? stopLoss : undefined,
      takeProfit: opts.product === 'multiplier' ? takeProfit : undefined,
      duration: opts.product === 'rise_fall' ? duration : undefined,
      durationUnit: opts.product === 'rise_fall' ? durationUnit : undefined,
    };
    let risk: Awaited<ReturnType<typeof brokerOrders.evaluate>> | null = null;
    if (!blockers.length) risk = await brokerOrders.evaluate(conn, { ...order, userSized: false });
    return {
      analysisId,
      environment: conn.environment,
      accountId: conn.accountId,
      symbol: out.symbol,
      timeframe: out.timeframe,
      assessment: out.assessment,
      confidence: out.confidence,
      summary: out.summary,
      rules: { assessment: rules.assessment, reasons: rules.reasons },
      price,
      order: { ...order, stake: risk?.order.stake, stopLossAmount: risk?.order.stopLossAmount, takeProfitAmount: risk?.order.takeProfitAmount },
      risk: risk ? { approved: risk.approved, checks: risk.checks, maxLoss: risk.maxLoss, reasons: risk.reasons } : null,
      blockers,
      canExecute: !blockers.length && !!risk?.approved,
      notice: 'The AI picks the direction only. Stop/target come from ATR and the stake from your risk limits. No outcome is guaranteed — a trade can lose its full stake.',
    };
  }

  async execute(conn: BrokerConnectionDoc, userId: string, analysisId: string, opts: AiTradeOptions) {
    // An analysis that already produced an order returns that order (no second trade).
    const dup = await OrderModel.findOne({ idempotencyKey: `bk:${conn._id.toString()}:ai-${analysisId}` });
    if (dup) return { plan: null, order: dup, duplicate: true };
    const p = await this.plan(conn, userId, analysisId, opts);
    if (p.blockers.length) throw new AppError(422, `Not trading: ${p.blockers.join('; ')}`, 'AI_TRADE_BLOCKED');
    const r = await brokerOrders.submit({
      userId,
      connectionId: conn._id.toString(),
      idempotencyKey: `ai-${analysisId}`,
      brokerSymbol: p.order.brokerSymbol,
      side: p.order.side,
      product: p.order.product,
      multiplier: p.order.multiplier,
      stopLoss: p.order.stopLoss,
      takeProfit: p.order.takeProfit,
      duration: p.order.duration,
      durationUnit: p.order.durationUnit,
      source: 'manual', // the user clicked to confirm
      strategyKey: 'ai-analyst',
      aiAnalysisId: analysisId,
    });
    return { plan: p, order: r.order, duplicate: r.duplicate };
  }
}

export const derivAiTrade = new DerivAiTradeService();
