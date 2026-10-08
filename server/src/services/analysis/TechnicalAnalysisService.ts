import type { Candle } from '../../types';
import * as ind from './indicators';

export type IndicatorName =
  | 'sma'
  | 'ema'
  | 'rsi'
  | 'macd'
  | 'bollinger'
  | 'atr'
  | 'adx'
  | 'stochastic'
  | 'vwap'
  | 'obv'
  | 'volume'
  | 'supportResistance'
  | 'volatility'
  | 'momentum';

export interface IndicatorSnapshot {
  price: number;
  sma?: Record<number, number>;
  ema?: Record<number, number>;
  rsi?: number;
  macd?: { macd: number; signal: number; histogram: number; prevHistogram: number };
  bollinger?: { upper: number; middle: number; lower: number; bandwidth: number; percentB: number };
  atr?: number;
  atrPct?: number;
  adx?: { adx: number; plusDI: number; minusDI: number };
  stochastic?: { k: number; d: number };
  vwap?: number;
  obv?: { value: number; slope: number };
  volume?: { last: number; relative: number };
  supportResistance?: ind.SupportResistance;
  volatility?: number;
  momentum?: number;
}

export interface IndicatorRequest {
  indicators: IndicatorName[];
  smaPeriods?: number[];
  emaPeriods?: number[];
  rsiPeriod?: number;
  atrPeriod?: number;
  adxPeriod?: number;
  bbPeriod?: number;
  bbMult?: number;
  momentumPeriod?: number;
  vwapSessionMs?: number;
}

/**
 * Reusable indicator service. Strategies declare the indicators they need and receive a snapshot
 * computed only from the candles passed in (which must all be closed candles).
 */
export class TechnicalAnalysisService {
  calculateSMA = ind.sma;
  calculateEMA = ind.ema;
  calculateRSI = ind.rsi;
  calculateMACD = ind.macd;
  calculateATR = ind.atr;
  calculateBollingerBands = ind.bollingerBands;
  calculateADX = ind.adx;
  calculateStochastic = ind.stochastic;
  calculateVWAP = ind.vwap;
  calculateOBV = ind.obv;
  calculateVolatility = ind.volatility;
  calculateMomentum = ind.roc;
  calculateSupportResistance = ind.supportResistance;
  calculateRelativeVolume = ind.relativeVolume;

  snapshot(candles: Candle[], req: IndicatorRequest): IndicatorSnapshot {
    const closes = candles.map((c) => c.close);
    const price = closes[closes.length - 1];
    const snap: IndicatorSnapshot = { price };
    const want = new Set(req.indicators);

    if (want.has('sma')) {
      snap.sma = {};
      for (const p of req.smaPeriods ?? [20, 50]) snap.sma[p] = ind.last(ind.sma(closes, p));
    }
    if (want.has('ema')) {
      snap.ema = {};
      for (const p of req.emaPeriods ?? [20, 50]) snap.ema[p] = ind.last(ind.ema(closes, p));
    }
    if (want.has('rsi')) snap.rsi = ind.last(ind.rsi(closes, req.rsiPeriod ?? 14));
    if (want.has('macd')) {
      const m = ind.macd(closes);
      const n = closes.length;
      snap.macd = { macd: m.macd[n - 1], signal: m.signal[n - 1], histogram: m.histogram[n - 1], prevHistogram: m.histogram[n - 2] };
    }
    if (want.has('bollinger')) {
      const b = ind.bollingerBands(closes, req.bbPeriod ?? 20, req.bbMult ?? 2);
      snap.bollinger = {
        upper: ind.last(b.upper),
        middle: ind.last(b.middle),
        lower: ind.last(b.lower),
        bandwidth: ind.last(b.bandwidth),
        percentB: ind.last(b.percentB),
      };
    }
    if (want.has('atr')) {
      snap.atr = ind.last(ind.atr(candles, req.atrPeriod ?? 14));
      snap.atrPct = snap.atr / price;
    }
    if (want.has('adx')) {
      const a = ind.adx(candles, req.adxPeriod ?? 14);
      snap.adx = { adx: ind.last(a.adx), plusDI: ind.last(a.plusDI), minusDI: ind.last(a.minusDI) };
    }
    if (want.has('stochastic')) {
      const s = ind.stochastic(candles);
      snap.stochastic = { k: ind.last(s.k), d: ind.last(s.d) };
    }
    if (want.has('vwap')) snap.vwap = ind.last(ind.vwap(candles, req.vwapSessionMs));
    if (want.has('obv')) {
      const o = ind.obv(candles);
      const n = o.length;
      snap.obv = { value: o[n - 1], slope: n > 10 ? o[n - 1] - o[n - 11] : 0 };
    }
    if (want.has('volume')) {
      const rv = ind.relativeVolume(candles);
      snap.volume = { last: candles[candles.length - 1]?.volume ?? 0, relative: ind.last(rv) };
    }
    if (want.has('supportResistance')) snap.supportResistance = ind.supportResistance(candles);
    if (want.has('volatility')) snap.volatility = ind.last(ind.volatility(closes));
    if (want.has('momentum')) snap.momentum = ind.last(ind.roc(closes, req.momentumPeriod ?? 10));
    return snap;
  }
}

export const technicalAnalysis = new TechnicalAnalysisService();
