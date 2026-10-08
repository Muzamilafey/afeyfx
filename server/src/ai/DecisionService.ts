import type { RiskEvaluation } from '../risk/RiskEngine';
import type { AIMarketAnalysis } from './schemas';
import type { StrategySignal } from '../strategies/Strategy';

export interface DecisionInput {
  strategySignal: StrategySignal;
  strategyValidation: { valid: boolean; reasons: string[] };
  ai: { required: boolean; status: 'OK' | 'ERROR' | 'REFUSED' | 'DISABLED'; analysis?: AIMarketAnalysis; minConfidence: number; requireAgreement: boolean };
  minStrategyConfidence: number;
  risk: RiskEvaluation;
}

export interface DecisionCheck {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  detail: string;
}

export interface Decision {
  decision: 'EXECUTE' | 'REJECT';
  checks: DecisionCheck[];
  reasons: string[];
}

/**
 * Final go/no-go gate (pure function). EXECUTE only when every critical check passes:
 * strategy signal + validation, AI agreement/confidence (when AI is in use), and the risk
 * engine's approval (which covers liquidity, spread, slippage, expected profit, exposure, limits).
 * AI can only VETO a trade; it can never create one or override the risk engine.
 */
export function decide(input: DecisionInput): Decision {
  const checks: DecisionCheck[] = [];
  const s = input.strategySignal;
  const entry = s.action === 'LONG' || s.action === 'SHORT';
  checks.push({ name: 'strategy-signal', status: entry ? 'PASS' : 'FAIL', detail: `${s.action} @ ${s.confidence.toFixed(2)}` });
  checks.push({ name: 'strategy-confidence', status: s.confidence >= input.minStrategyConfidence ? 'PASS' : 'FAIL', detail: `${s.confidence.toFixed(2)} (min ${input.minStrategyConfidence})` });
  checks.push({ name: 'strategy-validation', status: input.strategyValidation.valid ? 'PASS' : 'FAIL', detail: input.strategyValidation.reasons.join('; ') || 'valid' });

  const ai = input.ai;
  if (!ai.required) {
    checks.push({ name: 'ai-analysis', status: 'SKIPPED', detail: 'AI confirmation not required for this strategy' });
  } else if (ai.status === 'DISABLED') {
    checks.push({ name: 'ai-analysis', status: 'SKIPPED', detail: 'AI disabled by configuration' });
  } else if (ai.status !== 'OK' || !ai.analysis) {
    // AI is enabled but failed/refused -> fail closed.
    checks.push({ name: 'ai-analysis', status: 'FAIL', detail: `AI ${ai.status}` });
  } else {
    const a = ai.analysis;
    checks.push({ name: 'ai-agreement', status: !ai.requireAgreement || a.signal === s.action ? 'PASS' : 'FAIL', detail: `AI ${a.signal} vs strategy ${s.action}` });
    checks.push({ name: 'ai-confidence', status: a.confidence >= ai.minConfidence ? 'PASS' : 'FAIL', detail: `${a.confidence.toFixed(2)} (min ${ai.minConfidence})` });
    checks.push({ name: 'ai-data-quality', status: a.dataQualityConcerns.length === 0 ? 'PASS' : 'FAIL', detail: a.dataQualityConcerns.join('; ') || 'no concerns' });
    checks.push({ name: 'ai-regime', status: a.marketRegime !== 'ABNORMAL' ? 'PASS' : 'FAIL', detail: a.marketRegime });
  }

  const byName = new Map(input.risk.checks.map((c) => [c.name, c]));
  const riskPart = (name: string, label: string) => {
    const c = byName.get(name);
    checks.push({ name: label, status: !c ? 'SKIPPED' : c.passed ? 'PASS' : 'FAIL', detail: c?.detail ?? 'not evaluated' });
  };
  riskPart('liquidity', 'liquidity');
  riskPart('spread', 'spread');
  riskPart('expected-profit', 'expected-profit');
  checks.push({ name: 'risk-engine', status: input.risk.approved ? 'PASS' : 'FAIL', detail: input.risk.approved ? `size ${input.risk.positionSize}` : input.risk.reasons.join('; ') });

  const failed = checks.filter((c) => c.status === 'FAIL');
  return { decision: failed.length ? 'REJECT' : 'EXECUTE', checks, reasons: failed.map((f) => `${f.name}: ${f.detail}`) };
}
