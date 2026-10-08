import { env } from '../config/env';
import { getClaudeService, type MarketAnalysisInput } from '../ai/ClaudeService';
import { decide } from '../ai/DecisionService';
import { marketDataCache } from '../marketData/MarketDataCache';
import { Market } from '../models/Market';
import { PositionModel } from '../models/Position';
import { RiskEventModel } from '../models/RiskEvent';
import { SignalModel } from '../models/Signal';
import { StrategyModel } from '../models/Strategy';
import { portfolioService } from '../portfolio/PortfolioService';
import { circuitBreaker } from '../risk/CircuitBreaker';
import { correlation, returns, RiskEngine } from '../risk/RiskEngine';
import { marketRegimeService } from '../services/analysis/MarketRegimeService';
import { tradingState } from '../services/TradingState';
import { createStrategy } from '../strategies/registry';
import { TIMEFRAME_MS, type Timeframe } from '../types';
import { eventBus } from '../utils/eventBus';
import { errorMessage, logger } from '../utils/logger';
import { positionManager } from './PositionManager';
import { checkLiveOrder } from './LiveTradingGuard';

export interface ScanOutcome {
  strategy: string;
  symbol: string;
  timeframe: string;
  action: string;
  decision?: 'EXECUTE' | 'REJECT';
  reasons?: string[];
  signalId?: string;
  skipped?: string;
}

/** Stages from which a strategy may trade in each mode. LIVE requires explicit human approval. */
const MODE_STAGES: Record<'PAPER' | 'LIVE', string[]> = {
  PAPER: ['PAPER', 'APPROVED', 'LIVE'],
  LIVE: ['LIVE'],
};

/**
 * Orchestrates: Market Data -> Strategy -> AI Analysis -> Risk Engine -> Execution.
 * Any missing input, error or uncertainty results in NO TRADE.
 */
export class TradingEngine {
  private running = false;
  private scanning = false;
  lastScanAt = 0;
  lastError?: string;

  get isRunning() {
    return this.running;
  }

  start() {
    this.running = true;
  }

  stop() {
    this.running = false;
  }

  /** Run one scan over all enabled strategies (called by the job scheduler on candle close). */
  async scanAll(): Promise<ScanOutcome[]> {
    if (!this.running || this.scanning) return [];
    this.scanning = true;
    const out: ScanOutcome[] = [];
    try {
      const mode = tradingState.get().mode;
      const strategies = await StrategyModel.find({ enabled: true, stage: { $in: MODE_STAGES[mode] as never } });
      for (const s of strategies) {
        if (s.key === 'arbitrage') continue; // handled by ArbitrageService (multi-venue)
        for (const symbol of s.symbols) {
          for (const tf of s.timeframes) {
            try {
              out.push(await this.scan(s.key, symbol, tf as Timeframe));
            } catch (err) {
              this.lastError = errorMessage(err);
              logger.error({ err: this.lastError, strategy: s.key, symbol, tf }, 'Scan failed');
              out.push({ strategy: s.key, symbol, timeframe: tf, action: 'ERROR', skipped: this.lastError });
            }
          }
        }
      }
      this.lastScanAt = Date.now();
    } finally {
      this.scanning = false;
    }
    return out;
  }

  async scan(strategyKey: string, symbol: string, timeframe: Timeframe): Promise<ScanOutcome> {
    const state = tradingState.get();
    const mode = state.mode;
    const exchange = env.DEFAULT_EXCHANGE;
    const base = { strategy: strategyKey, symbol, timeframe };
    const doc = await StrategyModel.findOne({ key: strategyKey });
    if (!doc || !doc.enabled) return { ...base, action: 'HOLD', skipped: 'Strategy disabled' };
    const strategy = createStrategy(strategyKey, doc.params as Record<string, number>);
    if (doc.allowedRegimes?.length) strategy.allowedRegimes = doc.allowedRegimes as typeof strategy.allowedRegimes;

    const candles = marketDataCache.getCandles(exchange, symbol, timeframe);
    const last = candles[candles.length - 1];
    const step = TIMEFRAME_MS[timeframe];
    if (!last) return { ...base, action: 'HOLD', skipped: 'No candles' };
    // Stale-candle guard: the latest closed candle must be the previous period.
    if (Date.now() - (last.timestamp + step) > step * 1.5) return { ...base, action: 'HOLD', skipped: 'Candle data stale' };

    const regime = marketRegimeService.detect(candles);
    const open = await PositionModel.findOne({ mode, symbol, status: 'OPEN', strategyKey });
    const ctx = {
      symbol,
      timeframe,
      candles,
      regime,
      position: open ? { direction: open.direction as 'LONG' | 'SHORT', entryPrice: open.entryPrice, amount: open.amount, stopLoss: open.stopLoss ?? undefined, takeProfit: open.takeProfit ?? undefined, openedAt: open.openedAt?.getTime() ?? 0 } : undefined,
      ticker: marketDataCache.getTicker(exchange, symbol)?.data,
    };
    const sig = strategy.generateSignal(ctx);
    if (sig.action === 'HOLD') return { ...base, action: 'HOLD', reasons: [sig.reason] };

    // One signal per strategy/symbol/timeframe/candle/mode (unique index) - no duplicates.
    let signal;
    try {
      signal = await SignalModel.create({
        mode,
        strategyKey,
        strategyVersion: strategy.version,
        exchange,
        symbol,
        timeframe,
        action: sig.action,
        confidence: sig.confidence,
        price: sig.price,
        stopLoss: sig.stopLoss,
        takeProfit: sig.takeProfit,
        regime: sig.regime,
        reason: sig.reason,
        indicators: sig.indicators,
        candleTimestamp: last.timestamp,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return { ...base, action: sig.action, skipped: 'Signal already processed for this candle' };
      throw err;
    }
    eventBus.publish('signal', signal.toJSON());

    if (sig.action === 'EXIT') {
      if (open) await positionManager.close(open._id.toString(), `Strategy exit: ${sig.reason}`, 'EXIT', `sig:${signal._id.toString()}`);
      signal.decision = 'EXECUTE';
      await signal.save();
      return { ...base, action: 'EXIT', decision: 'EXECUTE', signalId: signal._id.toString() };
    }

    const reject = async (reasons: string[], riskEvaluation?: unknown, aiAnalysis?: string) => {
      signal.decision = 'REJECT';
      signal.decisionReasons = reasons;
      if (riskEvaluation) signal.riskEvaluation = riskEvaluation;
      if (aiAnalysis) signal.aiAnalysis = aiAnalysis as never;
      await signal.save();
      await RiskEventModel.create({ type: 'TRADE_REJECTED', severity: 'INFO', mode, symbol, strategyKey, message: reasons.join('; ').slice(0, 1000) }).catch(() => undefined);
      eventBus.publish('risk', { type: 'TRADE_REJECTED', symbol, strategyKey, reasons });
      return { ...base, action: sig.action, decision: 'REJECT' as const, reasons, signalId: signal._id.toString() };
    };

    // Fast fail before spending an AI call.
    if (!state.tradingEnabled || state.emergencyShutdown) return reject(['New trades are stopped']);
    if (!circuitBreaker.canOpenNewPositions()) return reject(circuitBreaker.reasons());
    if (mode === 'LIVE') {
      const g = checkLiveOrder('OPEN');
      if (!g.allowed) return reject(g.reasons);
    }

    const ticker = marketDataCache.getTicker(exchange, symbol);
    const book = marketDataCache.getOrderBook(exchange, symbol);
    if (!ticker || !book) return reject(['Missing ticker or order book - cannot assess spread/liquidity']);
    const validation = strategy.validateEntry(ctx, sig);

    // AI analysis (veto only).
    const ai = getClaudeService();
    const aiRequired = doc.requireAiConfirmation !== false;
    let aiRes: Awaited<ReturnType<typeof ai.analyzeMarket>> = { status: 'DISABLED' };
    if (aiRequired && ai.available) aiRes = await ai.analyzeMarket(await this.buildAiInput(exchange, symbol, timeframe, candles, regime, sig, strategyKey));

    // Risk evaluation with live account state.
    const portfolio = await portfolioService.revalue(mode);
    const pv = portfolioService.view(portfolio);
    const openPositions = await PositionModel.find({ mode, status: 'OPEN' });
    const market = await Market.findOne({ exchange, symbol }).lean();
    const correlations: Record<string, number> = {};
    for (const p of openPositions) {
      const other = marketDataCache.getCandles(exchange, p.symbol, timeframe).map((c) => c.close);
      if (other.length > 30) correlations[p.symbol] = correlation(returns(candles.map((c) => c.close)).slice(-100), returns(other).slice(-100));
    }
    const side = sig.action === 'LONG' ? book.data.asks : book.data.bids;
    const bandLimit = sig.price * (sig.action === 'LONG' ? 1 + state.risk.maxSlippagePct : 1 - state.risk.maxSlippagePct);
    const liquidity = side.filter((l) => (sig.action === 'LONG' ? l.price <= bandLimit : l.price >= bandLimit)).reduce((s, l) => s + l.amount, 0);
    const feeRate = market?.takerFee ?? env.PAPER_FEE_RATE;
    const entry = sig.action === 'LONG' ? ticker.data.ask : ticker.data.bid;

    const risk = new RiskEngine(state.risk).evaluate({
      mode,
      symbol,
      direction: sig.action,
      entryPrice: entry,
      stopLoss: sig.stopLoss!,
      takeProfit: sig.takeProfit,
      feeRate,
      expectedSlippagePct: mode === 'PAPER' ? env.PAPER_SLIPPAGE_PCT : state.risk.maxSlippagePct / 2,
      account: { equity: pv.equity, available: pv.available, dayStartEquity: pv.dayStartEquity, weekStartEquity: pv.weekStartEquity },
      openPositions: openPositions.map((p) => ({ symbol: p.symbol, direction: p.direction as 'LONG' | 'SHORT', notional: (p.currentPrice ?? p.entryPrice) * p.amount })),
      market: {
        bid: ticker.data.bid,
        ask: ticker.data.ask,
        availableLiquidity: liquidity,
        minAmount: market?.minAmount ?? undefined,
        amountPrecision: market?.amountPrecision ?? 6,
        dataAgeMs: marketDataCache.dataAgeMs(exchange, symbol),
        maxDataAgeMs: env.MARKET_DATA_STALE_MS,
      },
      correlations,
      circuitBreaker: { open: !circuitBreaker.canOpenNewPositions(), reasons: circuitBreaker.reasons() },
    });

    const d = decide({
      strategySignal: sig,
      strategyValidation: validation,
      ai: { required: aiRequired, status: aiRes.status, analysis: aiRes.data, minConfidence: state.ai.minConfidence, requireAgreement: state.ai.requireAgreement },
      minStrategyConfidence: 0.5,
      risk,
    });
    if (d.decision === 'REJECT') return reject(d.reasons, risk, aiRes.analysisId);

    signal.decision = 'EXECUTE';
    signal.decisionReasons = d.checks.map((c) => `${c.name}: ${c.status}`);
    signal.riskEvaluation = risk as never;
    if (aiRes.analysisId) signal.aiAnalysis = aiRes.analysisId as never;
    await signal.save();

    // Keep the strategy's stop distance but anchor it to the actual entry reference price.
    const stopDist = Math.abs(sig.price - sig.stopLoss!);
    const tpDist = sig.takeProfit ? Math.abs(sig.takeProfit - sig.price) : undefined;
    const isLong = sig.action === 'LONG';
    const res = await positionManager.open({
      mode,
      exchange,
      symbol,
      direction: sig.action,
      amount: risk.positionSize,
      stopLoss: isLong ? entry - stopDist : entry + stopDist,
      takeProfit: tpDist ? (isLong ? entry + tpDist : entry - tpDist) : undefined,
      strategyKey,
      timeframe,
      signal: signal._id.toString(),
      aiAnalysis: aiRes.analysisId,
      riskEvaluation: risk,
      idempotencyKey: `entry:${signal._id.toString()}`,
    });
    signal.order = res.order._id;
    await signal.save();
    return { ...base, action: sig.action, decision: 'EXECUTE', signalId: signal._id.toString(), reasons: res.position ? [] : [`Order ${res.order.status}: ${res.order.rejectReason ?? ''}`] };
  }

  private async buildAiInput(exchange: string, symbol: string, timeframe: string, candles: ReturnType<typeof marketDataCache.getCandles>, regime: ReturnType<typeof marketRegimeService.detect>, sig: ReturnType<ReturnType<typeof createStrategy>['generateSignal']>, strategyKey: string): Promise<MarketAnalysisInput> {
    const t = marketDataCache.getTicker(exchange, symbol)?.data;
    const b = marketDataCache.getOrderBook(exchange, symbol)?.data;
    const bidDepth = b?.bids.reduce((s, l) => s + l.amount * l.price, 0) ?? 0;
    const askDepth = b?.asks.reduce((s, l) => s + l.amount * l.price, 0) ?? 0;
    const open = await PositionModel.find({ status: 'OPEN', mode: tradingState.get().mode }).lean();
    return {
      symbol,
      timeframe,
      price: sig.price,
      bid: t?.bid,
      ask: t?.ask,
      spreadPct: t ? (t.ask - t.bid) / ((t.ask + t.bid) / 2) : undefined,
      volume24h: t?.quoteVolume,
      indicators: sig.indicators as unknown as Record<string, unknown>,
      regime: { regime: regime.regime, reason: regime.reason, metrics: regime.metrics as unknown as Record<string, unknown> },
      volatility: regime.metrics.atrPct,
      recentCandles: candles.slice(-30).map((c) => ({ t: new Date(c.timestamp).toISOString(), o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })),
      orderBook: b ? { bidDepth, askDepth, imbalance: bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0, topLevels: Math.min(b.bids.length, b.asks.length) } : undefined,
      openPositions: open.map((p) => ({ symbol: p.symbol, direction: p.direction, entryPrice: p.entryPrice, unrealizedPnl: p.unrealizedPnl ?? 0 })),
      strategySignal: { strategy: strategyKey, action: sig.action, confidence: sig.confidence, reason: sig.reason, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit },
      dataAgeMs: marketDataCache.dataAgeMs(exchange, symbol),
    };
  }
}

export const tradingEngine = new TradingEngine();
