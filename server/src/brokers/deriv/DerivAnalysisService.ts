import { getClaudeService } from '../../ai/ClaudeService';
import type { DerivAnalysis } from '../../ai/schemas';
import type { BrokerConnectionDoc } from '../../models/BrokerConnection';
import { PositionModel } from '../../models/Position';
import { TradeModel } from '../../models/Trade';
import { MarketRegimeService, type RegimeResult } from '../../services/analysis/MarketRegimeService';
import { technicalAnalysis, type IndicatorSnapshot } from '../../services/analysis/TechnicalAnalysisService';
import { createStrategy, listStrategyKeys } from '../../strategies/registry';
import type { Candle } from '../../types';
import { DERIV_GRANULARITIES, derivMarket } from './DerivMarketService';

/** Strategies that need a single instrument's candles (arbitrage needs two venues). */
export const DERIV_STRATEGIES = () => listStrategyKeys().filter((k) => k !== 'arbitrage');

const HIGHER_TF: Record<string, string | undefined> = { '1m': '15m', '2m': '30m', '3m': '30m', '5m': '1h', '10m': '1h', '15m': '4h', '30m': '4h', '1h': '1d', '2h': '1d', '4h': '1d', '8h': '1d' };
const regimeSvc = new MarketRegimeService();
// Deriv candles carry no traded volume, so volume-based indicators are left out.
const INDICATORS = ['sma', 'ema', 'rsi', 'macd', 'bollinger', 'atr', 'adx', 'stochastic', 'supportResistance', 'volatility', 'momentum'] as const;

export interface DerivSnapshot {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  price: number;
  lastCandleAt: number | null;
  indicators: IndicatorSnapshot;
  regime: RegimeResult;
  higher?: { timeframe: string; indicators: IndicatorSnapshot; regime: RegimeResult; candles: number };
  signals: { strategy: string; action: string; confidence: number; reason: string; stopLoss?: number; takeProfit?: number }[];
  dataQuality: { warnings: string[]; stale: boolean; sufficient: boolean; marketOpen: boolean | null; candleCount: number; gaps: number };
  fetchedAt: number;
}

/** Closed candles only: Deriv's latest candle is still forming. */
export function closedOnly(candles: Candle[], granularitySec: number, now = Date.now()) {
  return candles.filter((c) => c.timestamp + granularitySec * 1000 <= now);
}

export function dataQuality(candles: Candle[], granularitySec: number, marketOpen: boolean | null, now = Date.now()) {
  const warnings: string[] = [];
  const step = granularitySec * 1000;
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) if (candles[i].timestamp - candles[i - 1].timestamp > step * 1.5) gaps++;
  const last = candles.at(-1)?.timestamp ?? null;
  // The newest CLOSED candle should have closed within ~2 bars of now.
  const stale = last === null || now - (last + step) > 2 * step + 30_000;
  const sufficient = candles.length >= 120;
  if (!sufficient) warnings.push(`Only ${candles.length} closed candles (120+ needed for reliable indicators)`);
  if (stale) warnings.push(last ? `Latest closed candle is ${Math.round((now - last - step) / 60_000)} min old` : 'No candles returned by Deriv');
  if (gaps) warnings.push(`${gaps} gap(s) in the candle series (market closures or missing data)`);
  if (marketOpen === false) warnings.push('Deriv reports this market as closed');
  warnings.push('Deriv candles carry no traded volume; volume-based indicators are not used');
  return { warnings, stale, sufficient, marketOpen, candleCount: candles.length, gaps };
}

/** Run every single-instrument strategy on the same closed candles (deterministic, no AI). */
export function strategySignals(symbol: string, timeframe: string, candles: Candle[], regime: RegimeResult) {
  const out: DerivSnapshot['signals'] = [];
  for (const key of DERIV_STRATEGIES()) {
    try {
      const s = createStrategy(key);
      if (candles.length < s.minCandles) {
        out.push({ strategy: key, action: 'HOLD', confidence: 0, reason: `Needs ${s.minCandles} candles` });
        continue;
      }
      const sig = s.generateSignal({ symbol, timeframe, candles, regime });
      out.push({ strategy: key, action: sig.action, confidence: sig.confidence, reason: sig.reason, stopLoss: sig.stopLoss, takeProfit: sig.takeProfit });
    } catch (err) {
      out.push({ strategy: key, action: 'HOLD', confidence: 0, reason: `Error: ${(err as Error).message}` });
    }
  }
  return out;
}

export class DerivAnalysisService {
  async snapshot(conn: BrokerConnectionDoc, symbol: string, timeframe: string): Promise<DerivSnapshot> {
    const g = DERIV_GRANULARITIES[timeframe];
    const [main, symbols] = await Promise.all([derivMarket.candles(conn, symbol, timeframe, 400), derivMarket.symbols(conn).catch(() => [])]);
    const candles = closedOnly(main.candles.map((c) => ({ ...c, volume: 0 })), g);
    const marketOpen = symbols.find((s) => s.symbol === symbol)?.open ?? null;
    const indicators = technicalAnalysis.snapshot(candles, { indicators: [...INDICATORS], emaPeriods: [20, 50, 200], smaPeriods: [20, 50] });
    const regime = regimeSvc.detect(candles);
    let higher: DerivSnapshot['higher'];
    const htf = HIGHER_TF[timeframe];
    if (htf) {
      const h = await derivMarket.candles(conn, symbol, htf, 300).catch(() => null);
      if (h) {
        const hc = closedOnly(h.candles.map((c) => ({ ...c, volume: 0 })), DERIV_GRANULARITIES[htf]);
        if (hc.length >= 60) higher = { timeframe: htf, indicators: technicalAnalysis.snapshot(hc, { indicators: [...INDICATORS], emaPeriods: [20, 50], smaPeriods: [20] }), regime: regimeSvc.detect(hc), candles: hc.length };
      }
    }
    return {
      symbol,
      timeframe,
      candles,
      price: candles.at(-1)?.close ?? NaN,
      lastCandleAt: candles.at(-1)?.timestamp ?? null,
      indicators,
      regime,
      higher,
      signals: strategySignals(symbol, timeframe, candles, regime),
      dataQuality: dataQuality(candles, g, marketOpen),
      fetchedAt: Date.now(),
    };
  }

  /** Realized results per strategy on this account and symbol (Deriv's own P&L). */
  async strategyHistory(conn: BrokerConnectionDoc, symbol: string) {
    const rows = await TradeModel.aggregate<{ _id: string; n: number; wins: number; pnl: number }>([
      { $match: { connection: conn._id, symbol } },
      { $group: { _id: '$strategyKey', n: { $sum: 1 }, wins: { $sum: { $cond: [{ $gt: ['$netPnl', 0] }, 1, 0] } }, pnl: { $sum: '$netPnl' } } },
    ]);
    return rows.map((r) => ({ strategy: r._id ?? 'manual', trades: r.n, winRate: r.n ? r.wins / r.n : null, netPnl: Math.round(r.pnl * 100) / 100 }));
  }

  /** Rule-based reading that is always available (and shown when AI is off). */
  ruleBased(s: DerivSnapshot) {
    const i = s.indicators;
    const ema20 = i.ema?.[20];
    const ema50 = i.ema?.[50];
    const reasons: string[] = [];
    let score = 0;
    if (ema20 && ema50) {
      if (s.price > ema20 && ema20 > ema50) (score++, reasons.push('Price above EMA20 above EMA50'));
      else if (s.price < ema20 && ema20 < ema50) (score--, reasons.push('Price below EMA20 below EMA50'));
    }
    if (i.macd) {
      if (i.macd.histogram > 0 && i.macd.histogram > i.macd.prevHistogram) (score++, reasons.push('MACD histogram positive and rising'));
      else if (i.macd.histogram < 0 && i.macd.histogram < i.macd.prevHistogram) (score--, reasons.push('MACD histogram negative and falling'));
    }
    if (i.rsi !== undefined) {
      if (i.rsi > 70) reasons.push(`RSI ${i.rsi.toFixed(1)}: overbought`);
      else if (i.rsi < 30) reasons.push(`RSI ${i.rsi.toFixed(1)}: oversold`);
    }
    if (s.higher) {
      const r = s.higher.regime.regime;
      if (r === 'TRENDING_UP') (score++, reasons.push(`Higher timeframe (${s.higher.timeframe}) trending up`));
      if (r === 'TRENDING_DOWN') (score--, reasons.push(`Higher timeframe (${s.higher.timeframe}) trending down`));
    }
    const avoid: string[] = [];
    if (s.dataQuality.stale) avoid.push('Data is stale');
    if (!s.dataQuality.sufficient) avoid.push('Not enough history');
    if (s.dataQuality.marketOpen === false) avoid.push('Market closed');
    if (s.regime.regime === 'ABNORMAL') avoid.push(`Abnormal regime: ${s.regime.reason}`);
    const longs = s.signals.filter((x) => x.action === 'LONG').length;
    const shorts = s.signals.filter((x) => x.action === 'SHORT').length;
    if (longs && shorts) avoid.push(`Strategies disagree (${longs} long, ${shorts} short)`);
    return {
      assessment: score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL',
      score,
      reasons,
      avoidTrading: avoid.length > 0,
      reasonsToAvoid: avoid,
      note: 'Rule-based reading from indicators only. It is not a forecast and has no proven edge on its own.',
    };
  }

  async analyze(conn: BrokerConnectionDoc, symbol: string, timeframe: string, opts: { ai?: boolean } = {}) {
    const s = await this.snapshot(conn, symbol, timeframe);
    const history = await this.strategyHistory(conn, symbol);
    const exposure = await PositionModel.find({ connection: conn._id, status: 'OPEN' }, { symbol: 1, direction: 1, amount: 1, entryPrice: 1, unrealizedPnl: 1, brokerData: 1 }).lean();
    const rules = this.ruleBased(s);
    let ai: { status: string; data?: DerivAnalysis; error?: string; analysisId?: string; model?: string } = { status: 'SKIPPED' };
    if (opts.ai !== false) {
      const claude = getClaudeService();
      if (!claude.available) ai = { status: 'DISABLED', error: 'AI is not configured (Admin → Integrations → Anthropic) or is switched off' };
      else {
        const recent = s.candles.slice(-60).map((c) => ({ t: new Date(c.timestamp).toISOString(), o: c.open, h: c.high, l: c.low, c: c.close }));
        ai = await claude.analyzeDeriv(
          {
            symbol,
            timeframe,
            price: s.price,
            dataTimestamp: s.lastCandleAt ? new Date(s.lastCandleAt).toISOString() : null,
            indicators: s.indicators,
            regime: { regime: s.regime.regime, reason: s.regime.reason, tags: s.regime.tags },
            higherTimeframe: s.higher ? { timeframe: s.higher.timeframe, indicators: s.higher.indicators, regime: s.higher.regime.regime } : null,
            recentCandles: recent,
            strategySignals: s.signals,
            strategyHistory: history,
            exposure: exposure.map((p) => ({ symbol: p.symbol, direction: p.direction, stake: p.amount, unrealizedPnl: p.unrealizedPnl })),
            riskLimits: conn.riskLimits,
            accountCurrency: conn.currency,
            dataQuality: s.dataQuality,
            ruleBased: rules,
          },
          { user: String(conn.user) },
        );
      }
    }
    return {
      symbol,
      timeframe,
      price: s.price,
      dataTimestamp: s.lastCandleAt,
      fetchedAt: s.fetchedAt,
      regime: s.regime,
      higher: s.higher ? { timeframe: s.higher.timeframe, regime: s.higher.regime.regime, indicators: s.higher.indicators } : null,
      indicators: s.indicators,
      signals: s.signals,
      strategyHistory: history,
      dataQuality: s.dataQuality,
      exposure: exposure.length,
      rules,
      ai,
      disclaimer: 'Analysis only. Confidence values are subjective, not calibrated probabilities. Every order still passes the server-side risk engine.',
    };
  }
}

export const derivAnalysis = new DerivAnalysisService();
