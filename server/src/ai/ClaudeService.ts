import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { AIAnalysisModel } from '../models/AIAnalysis';
import { tradingState } from '../services/TradingState';
import { eventBus } from '../utils/eventBus';
import { errorMessage, logger } from '../utils/logger';
import {
  MarketAnalysisJsonSchema,
  MarketAnalysisSchema,
  StrategyReviewJsonSchema,
  StrategyReviewSchema,
  type AIMarketAnalysis,
  type AIStrategyReview,
} from './schemas';
import { MARKET_ANALYST_SYSTEM, STRATEGY_REVIEWER_SYSTEM } from './prompts';

export interface MarketAnalysisInput {
  symbol: string;
  timeframe: string;
  price: number;
  bid?: number;
  ask?: number;
  spreadPct?: number;
  volume24h?: number;
  indicators: Record<string, unknown>;
  regime: { regime: string; reason: string; metrics?: Record<string, unknown> };
  volatility?: number;
  recentCandles: { t: string; o: number; h: number; l: number; c: number; v: number }[];
  orderBook?: { bidDepth: number; askDepth: number; imbalance: number; topLevels: number };
  openPositions: { symbol: string; direction: string; entryPrice: number; unrealizedPnl: number }[];
  strategySignal?: { strategy: string; action: string; confidence: number; reason: string; stopLoss?: number; takeProfit?: number };
  news?: { title: string; source: string; publishedAt: string; sentiment?: string }[];
  dataAgeMs?: number;
}

export interface AIResult<T> {
  status: 'OK' | 'ERROR' | 'REFUSED' | 'DISABLED';
  data?: T;
  error?: string;
  analysisId?: string;
  model?: string;
  latencyMs?: number;
}

/** Models that accept the server-side `fallbacks: "default"` parameter. */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

type CreateFn = (params: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[]; stop_reason: string | null; model: string; usage?: unknown }>;

/**
 * Claude integration. Claude only ever produces structured analysis; this service has no access
 * to exchange adapters or the execution layer and therefore cannot place orders.
 */
export class ClaudeService {
  private create: CreateFn | null;

  constructor(create?: CreateFn) {
    if (create) this.create = create;
    else if (env.ANTHROPIC_API_KEY) {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
      this.create = (p) => client.beta.messages.create(p as never) as never;
    } else this.create = null;
  }

  get available() {
    return !!this.create && tradingState.get().ai.enabled;
  }

  private async call(system: string, user: string, schema: object, maxTokens = env.AI_MAX_TOKENS) {
    const model = tradingState.get().ai.model || env.AI_MODEL;
    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: env.AI_EFFORT, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    };
    if (FALLBACK_MODELS.has(model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    const started = Date.now();
    const res = await this.create!(params);
    const latencyMs = Date.now() - started;
    if (res.stop_reason === 'refusal') return { refused: true as const, latencyMs, model: res.model, usage: res.usage };
    if (res.stop_reason === 'max_tokens') throw new Error('AI response truncated (max_tokens)');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    return { refused: false as const, json: JSON.parse(text) as unknown, latencyMs, model: res.model, usage: res.usage };
  }

  async analyzeMarket(input: MarketAnalysisInput): Promise<AIResult<AIMarketAnalysis>> {
    if (!this.available) {
      return { status: 'DISABLED', error: 'AI analysis disabled or ANTHROPIC_API_KEY not configured' };
    }
    const inputSummary = { symbol: input.symbol, timeframe: input.timeframe, price: input.price, regime: input.regime.regime, strategySignal: input.strategySignal };
    try {
      const r = await this.call(MARKET_ANALYST_SYSTEM, `Analyze this market snapshot and return your assessment.\n\n${JSON.stringify(input)}`, MarketAnalysisJsonSchema);
      if (r.refused) {
        const doc = await AIAnalysisModel.create({ kind: 'MARKET', symbol: input.symbol, timeframe: input.timeframe, model: r.model, status: 'REFUSED', inputSummary, latencyMs: r.latencyMs, usage: r.usage });
        return { status: 'REFUSED', error: 'Model declined the request', analysisId: doc._id.toString(), model: r.model };
      }
      const parsed = MarketAnalysisSchema.safeParse(r.json);
      if (!parsed.success) throw new Error(`AI output failed validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      if (parsed.data.symbol !== input.symbol) throw new Error('AI output symbol mismatch');
      const d = parsed.data;
      const doc = await AIAnalysisModel.create({
        kind: 'MARKET',
        symbol: input.symbol,
        timeframe: input.timeframe,
        model: r.model,
        signal: d.signal,
        confidence: d.confidence,
        marketRegime: d.marketRegime,
        newsSentiment: d.newsSentiment,
        newsCount: input.news?.length ?? 0,
        riskLevel: d.riskLevel,
        reason: d.reason,
        output: d,
        inputSummary,
        status: 'OK',
        latencyMs: r.latencyMs,
        usage: r.usage,
      });
      eventBus.publish('ai-analysis', doc.toJSON());
      return { status: 'OK', data: d, analysisId: doc._id.toString(), model: r.model, latencyMs: r.latencyMs };
    } catch (err) {
      const msg = errorMessage(err);
      logger.warn({ component: 'ai', err: msg }, 'AI analysis failed');
      const doc = await AIAnalysisModel.create({ kind: 'MARKET', symbol: input.symbol, timeframe: input.timeframe, status: 'ERROR', error: msg, inputSummary }).catch(() => null);
      return { status: 'ERROR', error: msg, analysisId: doc?._id.toString() };
    }
  }

  /** Strategy review: produces PROPOSALS only. Callers store them as StrategyVersion(PROPOSED). */
  async reviewStrategy(payload: Record<string, unknown>): Promise<AIResult<AIStrategyReview>> {
    if (!this.available) return { status: 'DISABLED', error: 'AI analysis disabled or ANTHROPIC_API_KEY not configured' };
    try {
      const r = await this.call(STRATEGY_REVIEWER_SYSTEM, `Review this strategy's performance and propose improvements.\n\n${JSON.stringify(payload)}`, StrategyReviewJsonSchema);
      if (r.refused) return { status: 'REFUSED', error: 'Model declined the request' };
      const parsed = StrategyReviewSchema.safeParse(r.json);
      if (!parsed.success) throw new Error('AI output failed validation');
      const doc = await AIAnalysisModel.create({ kind: 'STRATEGY_REVIEW', model: r.model, output: parsed.data, reason: parsed.data.summary, status: 'OK', latencyMs: r.latencyMs, usage: r.usage, inputSummary: { strategy: payload.strategyKey } });
      return { status: 'OK', data: parsed.data, analysisId: doc._id.toString(), model: r.model, latencyMs: r.latencyMs };
    } catch (err) {
      return { status: 'ERROR', error: errorMessage(err) };
    }
  }
}

let instance: ClaudeService | null = null;
export const getClaudeService = () => (instance ??= new ClaudeService());
export const setClaudeService = (s: ClaudeService | null) => {
  instance = s;
};
