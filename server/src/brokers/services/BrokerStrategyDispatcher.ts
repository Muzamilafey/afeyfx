import { decide, type DecisionInput } from '../../ai/DecisionService';
import { BrokerConnectionModel } from '../../models/BrokerConnection';
import { StrategyAccountAssignmentModel } from '../../models/BrokerRecords';
import { StrategyModel } from '../../models/Strategy';
import type { RiskEvaluation } from '../../risk/RiskEngine';
import { errorMessage, logger } from '../../utils/logger';
import { brokerOrders } from './BrokerOrderService';
import type { BrokerRiskResult } from './BrokerRiskService';

/**
 * Routes an approved strategy signal to the broker accounts EXPLICITLY assigned to that
 * strategy (never to "all accounts"). Each account gets its own risk evaluation; the shared
 * strategy + AI checks go through the same decide() used by the system book, with the account's
 * risk result. The AI can veto but never trades on its own: no signal → no order.
 *
 * Demo accounts accept strategies in PAPER/APPROVED/LIVE stage; real accounts require a strategy
 * a human has promoted to LIVE.
 */
export interface DispatchInput {
  strategyKey: string;
  symbol: string;
  signalId: string;
  aiAnalysisId?: string;
  decision: Omit<DecisionInput, 'risk'>;
  /** Reference entry and protective distances from the strategy. */
  direction: 'LONG' | 'SHORT';
  stopDistancePct: number;
  takeProfitDistancePct?: number;
}

function asRiskEvaluation(r: BrokerRiskResult): RiskEvaluation {
  return {
    approved: r.approved,
    reasons: r.reasons,
    checks: r.checks.map((c) => ({ ...c, critical: true })),
    positionSize: r.order.volume ?? r.order.stake ?? 0,
    notional: r.exposure,
    stopDistance: 0,
    stopDistancePct: 0,
    maxLoss: r.maxLoss,
    exposureBefore: 0,
    exposureAfter: r.exposure,
    exposureAfterPct: 0,
    leverage: r.leverage,
    dailyDrawdownPct: 0,
    weeklyDrawdownPct: 0,
    rewardRisk: 0,
    expectedProfitPct: 0,
  } as RiskEvaluation;
}

export async function dispatchSignalToAccounts(i: DispatchInput) {
  const out: { connection: string; status: string; reasons?: string[] }[] = [];
  const assignments = await StrategyAccountAssignmentModel.find({ strategyKey: i.strategyKey, enabled: true });
  if (!assignments.length) return out;
  const strategy = await StrategyModel.findOne({ key: i.strategyKey }).lean();
  for (const a of assignments) {
    const brokerSymbol = (a.symbolMap as Map<string, string> | undefined)?.get(i.symbol);
    if (!brokerSymbol) continue; // only explicitly mapped symbols
    try {
      const conn = await BrokerConnectionModel.findOne({ _id: a.connection, user: a.user });
      if (!conn || !conn.tradingEnabled) {
        out.push({ connection: String(a.connection), status: 'SKIPPED', reasons: ['Trading disabled on the account'] });
        continue;
      }
      if (conn.environment === 'real' && strategy?.stage !== 'LIVE') {
        out.push({ connection: conn._id.toString(), status: 'SKIPPED', reasons: ['Real accounts only take strategies a human promoted to LIVE'] });
        continue;
      }
      const side = i.direction === 'LONG' ? 'buy' : 'sell';
      // Build protective levels from the account's own live quote.
      const pre = await brokerOrders.evaluate(conn, { brokerSymbol, side, product: a.product as 'cfd', multiplier: a.multiplier ?? undefined, userSized: false });
      const px = pre.quote ? (side === 'buy' ? pre.quote.ask : pre.quote.bid) : 0;
      if (!px) {
        out.push({ connection: conn._id.toString(), status: 'REJECTED', reasons: ['No live quote from the broker'] });
        continue;
      }
      const stopLoss = side === 'buy' ? px * (1 - i.stopDistancePct) : px * (1 + i.stopDistancePct);
      const takeProfit = i.takeProfitDistancePct ? (side === 'buy' ? px * (1 + i.takeProfitDistancePct) : px * (1 - i.takeProfitDistancePct)) : undefined;
      const risk = await brokerOrders.evaluate(conn, { brokerSymbol, side, product: a.product as 'cfd', multiplier: a.multiplier ?? undefined, stopLoss, takeProfit, duration: a.product === 'rise_fall' ? 5 : undefined, durationUnit: a.product === 'rise_fall' ? 'm' : undefined, userSized: false });
      const d = decide({ ...i.decision, risk: asRiskEvaluation(risk) });
      if (d.decision !== 'EXECUTE') risk.approved = false;
      if (!risk.approved) risk.reasons = d.reasons.length ? d.reasons : risk.reasons;
      const r = await brokerOrders.submit({ userId: String(a.user), connectionId: conn._id.toString(), idempotencyKey: `sig:${i.signalId}`, brokerSymbol, side, product: a.product as 'cfd', multiplier: a.multiplier ?? undefined, stopLoss, takeProfit, source: 'strategy', strategyKey: i.strategyKey, signalId: i.signalId, aiAnalysisId: i.aiAnalysisId, risk });
      out.push({ connection: conn._id.toString(), status: r.order.status, reasons: r.order.rejectReason ? [r.order.rejectReason] : undefined });
    } catch (err) {
      logger.warn({ assignment: a._id.toString(), err: errorMessage(err) }, 'Broker dispatch failed');
      out.push({ connection: String(a.connection), status: 'ERROR', reasons: [errorMessage(err)] });
    }
  }
  return out;
}
