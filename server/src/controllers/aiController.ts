import type { Request, Response } from 'express';
import { z } from 'zod';
import { getClaudeService } from '../ai/ClaudeService';
import { AIAnalysisModel } from '../models/AIAnalysis';
import { StrategyVersion } from '../models/StrategyVersion';
import { StrategyModel } from '../models/Strategy';
import { TradeModel } from '../models/Trade';
import { BacktestRunModel } from '../models/BacktestRun';
import { marketDataCache } from '../marketData/MarketDataCache';
import { marketRegimeService } from '../services/analysis/MarketRegimeService';
import { technicalAnalysis } from '../services/analysis/TechnicalAnalysisService';
import { PositionModel } from '../models/Position';
import { tradingState } from '../services/TradingState';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';
import { TIMEFRAMES } from '../types';
import { env } from '../config/env';

export const aiSchemas = {
  analyze: z.object({ symbol: z.string().regex(/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/), timeframe: z.enum(TIMEFRAMES).default('1h') }),
};

export const aiController = {
  status(_req: Request, res: Response) {
    const s = tradingState.get().ai;
    res.json({ enabled: s.enabled, configured: !!env.ANTHROPIC_API_KEY, available: getClaudeService().available, model: s.model, minConfidence: s.minConfidence, requireAgreement: s.requireAgreement });
  },

  /** On-demand analysis for the dashboard. Produces analysis only - never orders. */
  async analyze(req: Request, res: Response) {
    const { symbol, timeframe } = req.body as z.infer<typeof aiSchemas.analyze>;
    const candles = marketDataCache.getCandles(env.DEFAULT_EXCHANGE, symbol, timeframe);
    if (candles.length < 60) throw new AppError(409, 'Not enough candle data for analysis');
    const t = marketDataCache.getTicker(env.DEFAULT_EXCHANGE, symbol)?.data;
    const regime = marketRegimeService.detect(candles);
    const indicators = technicalAnalysis.snapshot(candles, { indicators: ['ema', 'rsi', 'macd', 'bollinger', 'atr', 'adx', 'vwap', 'volume', 'volatility', 'momentum'], vwapSessionMs: 86_400_000 });
    const open = await PositionModel.find({ status: 'OPEN', mode: tradingState.get().mode }).lean();
    const r = await getClaudeService().analyzeMarket({
      symbol,
      timeframe,
      price: candles[candles.length - 1].close,
      bid: t?.bid,
      ask: t?.ask,
      volume24h: t?.quoteVolume,
      indicators: indicators as unknown as Record<string, unknown>,
      regime: { regime: regime.regime, reason: regime.reason },
      volatility: regime.metrics.atrPct,
      recentCandles: candles.slice(-30).map((c) => ({ t: new Date(c.timestamp).toISOString(), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })),
      openPositions: open.map((p) => ({ symbol: p.symbol, direction: p.direction, entryPrice: p.entryPrice, unrealizedPnl: p.unrealizedPnl ?? 0 })),
      dataAgeMs: marketDataCache.dataAgeMs(env.DEFAULT_EXCHANGE, symbol),
    });
    res.json(r);
  },

  async list(req: Request, res: Response) {
    const q: Record<string, unknown> = {};
    if (req.query.symbol) q.symbol = String(req.query.symbol);
    if (req.query.kind) q.kind = String(req.query.kind);
    res.json({ analyses: await AIAnalysisModel.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit ?? 50), 200)).lean() });
  },

  /**
   * AI strategy review. Proposals are stored as StrategyVersion(status=PROPOSED, source=AI_PROPOSAL)
   * and must go through backtest -> out-of-sample -> paper -> human approval. Nothing is auto-applied.
   */
  async reviewStrategy(req: Request, res: Response) {
    const key = String(req.params.key);
    const s = await StrategyModel.findOne({ key }).lean();
    if (!s) throw new AppError(404, 'Strategy not found');
    const trades = await TradeModel.find({ strategyKey: key }).sort({ closedAt: -1 }).limit(200).lean();
    const winners = trades.filter((t) => (t.netPnl ?? 0) > 0).slice(0, 25);
    const losers = trades.filter((t) => (t.netPnl ?? 0) <= 0).slice(0, 25);
    const runs = await BacktestRunModel.find({ strategyKey: key, status: 'COMPLETED' }).sort({ finishedAt: -1 }).limit(5).select({ metrics: 1, segment: 1, params: 1 }).lean();
    const r = await getClaudeService().reviewStrategy({
      strategyKey: key,
      currentParams: s.params,
      allowedRegimes: s.allowedRegimes,
      stage: s.stage,
      tradeCount: trades.length,
      winners: winners.map((t) => ({ mode: t.mode, symbol: t.symbol, dir: t.direction, net: t.netPnl, ret: t.returnPct, exit: t.exitReason })),
      losers: losers.map((t) => ({ mode: t.mode, symbol: t.symbol, dir: t.direction, net: t.netPnl, ret: t.returnPct, exit: t.exitReason })),
      backtests: runs,
    });
    if (r.status === 'OK' && r.data) {
      let i = 0;
      for (const p of r.data.proposals) {
        await StrategyVersion.create({ strategyKey: key, version: `ai-${Date.now()}-${i++}`, params: p.params, source: 'AI_PROPOSAL', status: 'PROPOSED', rationale: `${p.kind}: ${p.description}\n${p.rationale}\nExpected: ${p.expectedImpact}`, createdBy: req.user!.id });
      }
    }
    await audit(req, { action: 'AI_STRATEGY_REVIEW', resource: 'strategy', resourceId: key, details: { status: r.status, proposals: r.data?.proposals.length ?? 0 } });
    res.json(r);
  },
};
