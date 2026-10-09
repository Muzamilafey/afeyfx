import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { reloadEnv } from '../src/config/env';
import { BrokerConnectionModel } from '../src/models/BrokerConnection';
import { AIAnalysisModel } from '../src/models/AIAnalysis';
import { OrderModel } from '../src/models/Order';
import { PositionModel } from '../src/models/Position';
import { User } from '../src/models/User';
import { brokerRegistry } from '../src/brokers/services/BrokerRegistry';
import { DerivConnectionAdapter } from '../src/brokers/deriv/DerivConnectionAdapter';
import { derivMarket } from '../src/brokers/deriv/DerivMarketService';
import { ClaudeService, setClaudeService } from '../src/ai/ClaudeService';
import type { DerivAnalysis } from '../src/ai/schemas';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { encrypt } from '../src/utils/crypto';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser } from './helpers/api';

const app = createApp();

/** A steady up-trend of CLOSED candles ending at the last full bar (real-looking, gently noisy). */
function candles(granularity: number, count: number) {
  const step = granularity;
  const lastOpen = Math.floor(Date.now() / 1000 / step) * step - step; // last closed bar
  return Array.from({ length: count }, (_, k) => {
    const i = k;
    const base = 100 + i * 0.05 + Math.sin(i / 3) * 0.15;
    return { epoch: lastOpen - (count - 1 - i) * step, open: base - 0.02, high: base + 0.2, low: base - 0.2, close: base + 0.02 };
  });
}

function fakeDeriv(balance = 10_000) {
  const sent: Record<string, unknown>[] = [];
  let lastPrice = 0;
  const rpc = async (m: Record<string, unknown>) => {
    sent.push(m);
    if (m.balance) return { balance: { balance, currency: 'USD', loginid: 'VRTC1' } };
    if (m.active_symbols) return { active_symbols: [{ underlying_symbol: 'R_100', display_name: 'Volatility 100 Index', market: 'synthetic_index', pip: 0.01, exchange_is_open: 1, is_trading_suspended: 0 }] };
    if (m.contracts_for) return { contracts_for: { available: [
      { contract_type: 'MULTUP', contract_category: 'multiplier', multiplier_range: [40, 100, 200], min_stake: 1, max_stake: 2000 },
      { contract_type: 'MULTDOWN', contract_category: 'multiplier', multiplier_range: [40, 100, 200], min_stake: 1, max_stake: 2000 },
      { contract_type: 'CALL', contract_category: 'callput', expiry_type: 'intraday', min_contract_duration: '15s', max_contract_duration: '1d' },
    ] } };
    if (m.ticks_history) {
      const c = candles(Number(m.granularity), Math.min(Number(m.count), 400));
      if (Number(m.granularity) === 60) lastPrice = c.at(-1)!.close;
      return { candles: c };
    }
    if (m.ticks) return { tick: { symbol: m.ticks, quote: lastPrice || 120, epoch: Math.floor(Date.now() / 1000) }, subscription: { id: 'sub1' } };
    if (m.proposal) return { proposal: { id: 'P1', ask_price: m.amount, spot: lastPrice } };
    if (m.buy) return { buy: { contract_id: 501, buy_price: 1, transaction_id: 9 } };
    if (m.proposal_open_contract) return { proposal_open_contract: { contract_id: 501, contract_type: 'MULTUP', underlying_symbol: 'R_100', buy_price: 1, entry_spot: lastPrice, is_sold: 0 } };
    if (m.portfolio) return { portfolio: { contracts: [] } };
    return {};
  };
  return { sent, rpc };
}

const ai = (o: Partial<DerivAnalysis> = {}): DerivAnalysis => ({
  symbol: 'R_100',
  timeframe: '1m',
  regime: 'TRENDING_UP',
  assessment: 'BULLISH',
  summary: 'EMA20 above EMA50 with rising MACD.',
  entryConditions: ['Close above EMA20'],
  invalidationConditions: ['Close below EMA50'],
  exitConditions: ['MACD turns negative'],
  confidence: 0.62,
  confidenceExplanation: 'Subjective score, not calibrated; synthetic index has no proven edge.',
  riskReward: { available: false, ratio: null, basis: 'n/a' },
  keyLevels: { support: [110], resistance: [125] },
  avoidTrading: false,
  reasonsToAvoid: [],
  dataQualityWarnings: [],
  strategyNotes: [],
  ...o,
});
let aiReply: DerivAnalysis = ai();
const claude = () => new ClaudeService(async () => ({ content: [{ type: 'text', text: JSON.stringify(aiReply) }], stop_reason: 'end_turn', model: 'test-model' }) as never);

async function derivConn(email: string, environment: 'demo' | 'real' = 'demo') {
  const u = (await User.findOne({ email }))!;
  return BrokerConnectionModel.create({ user: u._id, provider: 'deriv', accountId: environment === 'demo' ? 'VRTC1' : 'CR1', environment, currency: 'USD', status: 'CONNECTED', tokenType: 'oauth', accessTokenEnc: encrypt('tok'), tradingEnabled: true, label: 'Deriv' });
}

let fake: ReturnType<typeof fakeDeriv>;
beforeAll(connectTestDb);
afterAll(async () => {
  brokerRegistry.setFactory('deriv', null);
  setClaudeService(null);
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearDb();
  await brokerRegistry.dropAll();
  derivMarket.clearCache();
  tradingState.reset();
  tradingState.update({ ai: { ...tradingState.get().ai, enabled: true } });
  circuitBreaker.resetAll();
  process.env.LIVE_TRADING_ENABLED = 'false';
  reloadEnv();
  fake = fakeDeriv();
  brokerRegistry.setFactory('deriv', (c) => new DerivConnectionAdapter({ accountId: c.accountId!, environment: c.environment as 'demo' | 'real', token: 't', tokenType: 'oauth' }, fake.rpc));
  aiReply = ai();
  setClaudeService(claude());
});

const buys = () => fake.sent.filter((m) => m.buy).length;
async function analyze(t: { auth: Record<string, string> }, id: string) {
  const r = await request(app).post(`/api/deriv/accounts/${id}/analyze`).set(t.auth).send({ symbol: 'R_100', timeframe: '1m' });
  expect(r.status).toBe(200);
  return r.body;
}

describe('Deriv AI analyst', () => {
  it('returns indicators, a rule-based reading and a validated AI analysis from real candles — and never trades', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await derivConn('t@x.io');
    const b = await analyze(t, c.id);
    expect(b.dataQuality).toMatchObject({ stale: false, sufficient: true });
    expect(b.rules.assessment).not.toBe('BEARISH');
    expect(b.ai).toMatchObject({ status: 'OK', data: { assessment: 'BULLISH' } });
    expect(b.disclaimer).toMatch(/not calibrated/);
    expect(await AIAnalysisModel.countDocuments({ kind: 'DERIV_ANALYSIS', status: 'OK' })).toBe(1);
    expect(buys()).toBe(0);
  });

  it('rejects invented price levels and a symbol mismatch', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await derivConn('t@x.io');
    aiReply = ai({ keyLevels: { support: [1], resistance: [9999] } });
    expect((await analyze(t, c.id)).ai.status).toBe('ERROR');
    aiReply = ai({ symbol: 'R_50' });
    expect((await analyze(t, c.id)).ai.status).toBe('ERROR');
  });
});

describe('Trade with AI (one click, risk engine still decides)', () => {
  it('demo: preview shows a server-built, risk-sized plan; the click buys once; a second click is a duplicate', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await derivConn('t@x.io');
    const a = await analyze(t, c.id);
    const pv = await request(app).post(`/api/deriv/accounts/${c.id}/ai-trade/preview`).set(t.auth).send({ analysisId: a.ai.analysisId });
    expect(pv.status).toBe(200);
    const plan = pv.body.plan;
    expect(plan).toMatchObject({ environment: 'demo', assessment: 'BULLISH', canExecute: true, blockers: [] });
    expect(plan.order).toMatchObject({ side: 'buy', product: 'multiplier', multiplier: 40 }); // lowest offered multiplier
    expect(plan.order.stopLoss).toBeLessThan(plan.price); // ATR stop below price for a buy
    expect(plan.order.stake).toBeGreaterThan(0);
    expect(plan.risk.maxLoss).toBeLessThanOrEqual(50.01); // 0.5% of 10,000
    expect(buys()).toBe(0); // preview never buys

    const ex = await request(app).post(`/api/deriv/accounts/${c.id}/ai-trade`).set(t.auth).send({ analysisId: a.ai.analysisId });
    expect(ex.status).toBe(201);
    expect(ex.body.order).toMatchObject({ status: 'FILLED', mode: 'DEMO', strategyKey: 'ai-analyst' });
    expect(buys()).toBe(1);
    expect(await PositionModel.countDocuments({ connection: c._id, status: 'OPEN' })).toBe(1);
    const again = await request(app).post(`/api/deriv/accounts/${c.id}/ai-trade`).set(t.auth).send({ analysisId: a.ai.analysisId });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(buys()).toBe(1);
  });

  it('rise/fall uses a duration of five bars and SELL for a bearish call is blocked when indicators disagree', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await derivConn('t@x.io');
    const a = await analyze(t, c.id);
    const pv = await request(app).post(`/api/deriv/accounts/${c.id}/ai-trade/preview`).set(t.auth).send({ analysisId: a.ai.analysisId, product: 'rise_fall' });
    expect(pv.body.plan.order).toMatchObject({ product: 'rise_fall', duration: 5, durationUnit: 'm' });
    aiReply = ai({ assessment: 'BEARISH', regime: 'TRENDING_DOWN' });
    const b = await analyze(t, c.id);
    const pv2 = await request(app).post(`/api/deriv/accounts/${c.id}/ai-trade/preview`).set(t.auth).send({ analysisId: b.ai.analysisId });
    if (b.rules.assessment === 'BULLISH') expect(pv2.body.plan.blockers.join(' ')).toMatch(/other way/);
  });

  it('does not trade when the AI says avoid / NEUTRAL / low score, when the analysis is old, or is someone else\'s', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const o = await makeUser(app, 'o@x.io', 'trader');
    const c = await derivConn('t@x.io');
    const oc = await derivConn('o@x.io');
    for (const [over, re] of [[{ avoidTrading: true, reasonsToAvoid: ['Choppy'] }, /advises not to trade/], [{ assessment: 'NEUTRAL' }, /NEUTRAL/], [{ confidence: 0.3 }, /below the minimum/]] as const) {
      aiReply = ai(over as Partial<DerivAnalysis>);
      const a = await analyze(t, c.id);
      const r = await request(app).post(`/api/deriv/accounts/${c.id}/ai-trade`).set(t.auth).send({ analysisId: a.ai.analysisId });
      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(re);
    }
    aiReply = ai();
    const a = await analyze(t, c.id);
    await AIAnalysisModel.collection.updateOne({ _id: new (await import('mongoose')).Types.ObjectId(a.ai.analysisId) }, { $set: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    expect((await request(app).post(`/api/deriv/accounts/${c.id}/ai-trade`).set(t.auth).send({ analysisId: a.ai.analysisId })).body.error.message).toMatch(/min old/);
    const fresh = await analyze(t, c.id);
    expect((await request(app).post(`/api/deriv/accounts/${oc.id}/ai-trade`).set(o.auth).send({ analysisId: fresh.ai.analysisId })).status).toBe(404);
    expect((await request(app).post(`/api/deriv/accounts/${c.id}/ai-trade`).set(o.auth).send({ analysisId: fresh.ai.analysisId })).status).toBe(404);
    expect(buys()).toBe(0);
    expect(await OrderModel.countDocuments()).toBe(0);
  });

  it('a REAL account is refused by the risk engine while live trading is off (nothing is bought)', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    const c = await derivConn('t@x.io', 'real');
    const a = await analyze(t, c.id);
    const r = await request(app).post(`/api/deriv/accounts/${c.id}/ai-trade`).set(t.auth).send({ analysisId: a.ai.analysisId });
    expect(r.status).toBe(422);
    expect(r.body.order.status).toBe('REJECTED');
    expect(r.body.order.rejectReason).toMatch(/LIVE_TRADING_ENABLED|live/i);
    expect(buys()).toBe(0);
  });
});
