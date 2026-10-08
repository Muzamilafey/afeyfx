import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import '../src/models';
import { decide, type DecisionInput } from '../src/ai/DecisionService';
import { ClaudeService } from '../src/ai/ClaudeService';
import { tradingState } from '../src/services/TradingState';
import { RiskEngine } from '../src/risk/RiskEngine';
import { AIAnalysisModel } from '../src/models/AIAnalysis';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';

const risk = (approved = true) =>
  new RiskEngine().evaluate({
    mode: 'PAPER', symbol: 'BTC/USDT', direction: 'LONG', entryPrice: 100, stopLoss: approved ? 98 : 101, takeProfit: 105, feeRate: 0.001, expectedSlippagePct: 0.0005,
    account: { equity: 10_000, available: 10_000, dayStartEquity: 10_000, weekStartEquity: 10_000 }, openPositions: [],
    market: { bid: 99.99, ask: 100.01, availableLiquidity: 1000, dataAgeMs: 10, maxDataAgeMs: 30_000, minAmount: 0.001 }, circuitBreaker: { open: false, reasons: [] },
  });
const aiOk = (over = {}) => ({ symbol: 'BTC/USDT', signal: 'LONG' as const, confidence: 0.82, marketRegime: 'TRENDING_UP' as const, riskLevel: 'MEDIUM' as const, reason: 'r', keyRisks: [], dataQualityConcerns: [], newsSentiment: 'NONE' as const, ...over });
const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  strategySignal: { action: 'LONG', confidence: 0.75, price: 100, stopLoss: 98, takeProfit: 105, reason: 's', indicators: { price: 100 }, regime: 'TRENDING_UP' },
  strategyValidation: { valid: true, reasons: [] },
  ai: { required: true, status: 'OK', analysis: aiOk(), minConfidence: 0.65, requireAgreement: true },
  minStrategyConfidence: 0.5,
  risk: risk(),
  ...over,
});

describe('AI decision rules (section 11)', () => {
  it('EXECUTE when AI LONG 0.82, strategy LONG 0.75, risk/liquidity/spread/expected profit PASS', () => {
    const d = decide(input());
    expect(d.decision).toBe('EXECUTE');
    for (const n of ['liquidity', 'spread', 'expected-profit', 'risk-engine', 'ai-agreement']) expect(d.checks.find((c) => c.name === n)!.status).toBe('PASS');
  });
  it('REJECT when AI disagrees with the strategy', () => expect(decide(input({ ai: { ...input().ai, analysis: aiOk({ signal: 'SHORT' }) } })).decision).toBe('REJECT'));
  it('REJECT when AI says HOLD', () => expect(decide(input({ ai: { ...input().ai, analysis: aiOk({ signal: 'HOLD' }) } })).decision).toBe('REJECT'));
  it('REJECT when AI confidence is too low', () => expect(decide(input({ ai: { ...input().ai, analysis: aiOk({ confidence: 0.5 }) } })).decision).toBe('REJECT'));
  it('REJECT when AI flags data-quality concerns', () => expect(decide(input({ ai: { ...input().ai, analysis: aiOk({ dataQualityConcerns: ['stale'] }) } })).decision).toBe('REJECT'));
  it('REJECT (fail closed) when AI is enabled but errors or refuses', () => {
    expect(decide(input({ ai: { ...input().ai, status: 'ERROR', analysis: undefined } })).decision).toBe('REJECT');
    expect(decide(input({ ai: { ...input().ai, status: 'REFUSED', analysis: undefined } })).decision).toBe('REJECT');
  });
  it('AI can never override the risk engine', () => {
    const d = decide(input({ risk: risk(false), ai: { ...input().ai, analysis: aiOk({ confidence: 0.99 }) } }));
    expect(d.decision).toBe('REJECT');
    expect(d.reasons.join()).toMatch(/risk-engine/);
  });
  it('REJECT on invalid strategy validation or weak strategy confidence', () => {
    expect(decide(input({ strategyValidation: { valid: false, reasons: ['x'] } })).decision).toBe('REJECT');
    expect(decide(input({ strategySignal: { ...input().strategySignal, confidence: 0.3 } })).decision).toBe('REJECT');
  });
  it('AI disabled by configuration is skipped, other checks still apply', () => {
    const d = decide(input({ ai: { ...input().ai, status: 'DISABLED', analysis: undefined } }));
    expect(d.decision).toBe('EXECUTE');
    expect(d.checks.find((c) => c.name === 'ai-analysis')!.status).toBe('SKIPPED');
  });
});

describe('ClaudeService', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await clearDb();
    tradingState.reset();
    tradingState.update({ ai: { ...tradingState.get().ai, enabled: true } });
  });

  const input = { symbol: 'BTC/USDT', timeframe: '1h', price: 100, indicators: {}, regime: { regime: 'TRENDING_UP', reason: '' }, recentCandles: [], openPositions: [] };
  const reply = (obj: unknown, stop = 'end_turn') => async () => ({ content: [{ type: 'thinking', text: '' }, { type: 'text', text: JSON.stringify(obj) }], stop_reason: stop, model: 'claude-opus-5-5' });

  it('returns validated structured analysis and persists it', async () => {
    let params: Record<string, unknown> = {};
    const svc = new ClaudeService(async (p) => {
      params = p;
      return reply(aiOk())();
    });
    const r = await svc.analyzeMarket(input);
    expect(r.status).toBe('OK');
    expect(r.data!.signal).toBe('LONG');
    expect(await AIAnalysisModel.countDocuments({ status: 'OK' })).toBe(1);
    expect((params.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params).not.toHaveProperty('tools'); // Claude is given no tools - it cannot act
  });

  it('rejects malformed or mismatched output (ERROR, not a signal)', async () => {
    expect((await new ClaudeService(reply({ ...aiOk(), confidence: 7 })).analyzeMarket(input)).status).toBe('ERROR');
    expect((await new ClaudeService(reply({ ...aiOk(), symbol: 'ETH/USDT' })).analyzeMarket(input)).status).toBe('ERROR');
    expect((await new ClaudeService(async () => ({ content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn', model: 'm' })).analyzeMarket(input)).status).toBe('ERROR');
  });

  it('passes news headlines to Claude as data', async () => {
    let user = '';
    const svc = new ClaudeService(async (p) => {
      user = JSON.stringify(p.messages);
      return reply({ ...aiOk(), newsSentiment: 'BULLISH' })();
    });
    const r = await svc.analyzeMarket({ ...input, news: [{ title: 'Bitcoin ETF inflows', source: 'x', publishedAt: new Date().toISOString() }] });
    expect(user).toContain('Bitcoin ETF inflows');
    expect(r.data!.newsSentiment).toBe('BULLISH');
    expect((await AIAnalysisModel.findById(r.analysisId))!.newsCount).toBe(1);
  });

  it('handles refusals and truncation', async () => {
    expect((await new ClaudeService(reply({}, 'refusal')).analyzeMarket(input)).status).toBe('REFUSED');
    expect((await new ClaudeService(reply(aiOk(), 'max_tokens')).analyzeMarket(input)).status).toBe('ERROR');
  });

  it('is DISABLED when AI is turned off', async () => {
    tradingState.update({ ai: { ...tradingState.get().ai, enabled: false } });
    expect((await new ClaudeService(reply(aiOk())).analyzeMarket(input)).status).toBe('DISABLED');
  });

  it('the AI module has no access to exchanges or the execution layer', () => {
    const dir = path.join(__dirname, '..', 'src', 'ai');
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src).not.toMatch(/from '\.\.\/(exchanges|execution)\//);
    }
  });
});
