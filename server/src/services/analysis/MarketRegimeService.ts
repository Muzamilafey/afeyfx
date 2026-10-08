import type { Candle, MarketRegime } from '../../types';
import * as ind from './indicators';

export interface RegimeResult {
  regime: MarketRegime;
  /** Secondary tags, e.g. a trending market that is also high-volatility. */
  tags: MarketRegime[];
  metrics: {
    adx: number;
    plusDI: number;
    minusDI: number;
    emaFast: number;
    emaSlow: number;
    atrPct: number;
    atrPctPercentile: number;
    lastReturnZ: number;
  };
  reason: string;
}

export interface RegimeConfig {
  adxTrend: number;
  highVolPercentile: number;
  lowVolPercentile: number;
  abnormalZ: number;
  lookback: number;
}

const DEFAULTS: RegimeConfig = {
  adxTrend: 25,
  highVolPercentile: 0.9,
  lowVolPercentile: 0.1,
  abnormalZ: 6,
  lookback: 200,
};

/**
 * Detects the market regime from closed candles only.
 * Priority: ABNORMAL > HIGH_VOLATILITY > TRENDING_UP/DOWN > LOW_VOLATILITY > SIDEWAYS.
 * ABNORMAL is returned for data problems (gaps, non-positive prices) or extreme moves - strategies
 * should never trade in ABNORMAL.
 */
export class MarketRegimeService {
  constructor(private cfg: RegimeConfig = DEFAULTS) {}

  detect(candles: Candle[]): RegimeResult {
    const empty = { adx: NaN, plusDI: NaN, minusDI: NaN, emaFast: NaN, emaSlow: NaN, atrPct: NaN, atrPctPercentile: NaN, lastReturnZ: NaN };
    if (candles.length < 60) {
      return { regime: 'ABNORMAL', tags: [], metrics: empty, reason: 'Insufficient data (<60 candles)' };
    }
    if (candles.some((c) => !(c.close > 0) || !(c.high >= c.low) || c.volume < 0)) {
      return { regime: 'ABNORMAL', tags: [], metrics: empty, reason: 'Invalid candle values' };
    }
    const w = candles.slice(-this.cfg.lookback);
    const closes = w.map((c) => c.close);
    const a = ind.adx(w, 14);
    const atrArr = ind.atr(w, 14);
    const atrPctArr = atrArr.map((v, i) => v / closes[i]).filter((v) => !Number.isNaN(v));
    const atrPct = atrPctArr[atrPctArr.length - 1];
    const sorted = atrPctArr.slice().sort((x, y) => x - y);
    const percentile = sorted.length ? sorted.findIndex((v) => v >= atrPct) / sorted.length : 0.5;

    const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    const hist = rets.slice(0, -1);
    const m = hist.reduce((s, x) => s + x, 0) / hist.length;
    const sd = Math.sqrt(hist.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, hist.length - 1));
    const lastReturnZ = sd === 0 ? 0 : (rets[rets.length - 1] - m) / sd;

    const emaFast = ind.last(ind.ema(closes, 20));
    const emaSlow = ind.last(ind.ema(closes, 50));
    const metrics = {
      adx: ind.last(a.adx),
      plusDI: ind.last(a.plusDI),
      minusDI: ind.last(a.minusDI),
      emaFast,
      emaSlow,
      atrPct,
      atrPctPercentile: percentile,
      lastReturnZ,
    };

    const tags: MarketRegime[] = [];
    if (Math.abs(lastReturnZ) >= this.cfg.abnormalZ) {
      return { regime: 'ABNORMAL', tags, metrics, reason: `Extreme last-bar move (z=${lastReturnZ.toFixed(1)})` };
    }
    const highVol = percentile >= this.cfg.highVolPercentile;
    const lowVol = percentile <= this.cfg.lowVolPercentile;
    const trending = metrics.adx >= this.cfg.adxTrend;
    const up = trending && metrics.plusDI > metrics.minusDI && emaFast > emaSlow;
    const down = trending && metrics.minusDI > metrics.plusDI && emaFast < emaSlow;

    if (up) tags.push('TRENDING_UP');
    if (down) tags.push('TRENDING_DOWN');
    if (highVol) tags.push('HIGH_VOLATILITY');
    if (lowVol) tags.push('LOW_VOLATILITY');

    let regime: MarketRegime;
    let reason: string;
    if (highVol) {
      regime = 'HIGH_VOLATILITY';
      reason = `ATR% in ${(percentile * 100).toFixed(0)}th percentile`;
    } else if (up) {
      regime = 'TRENDING_UP';
      reason = `ADX ${metrics.adx.toFixed(1)} with +DI > -DI and EMA20 > EMA50`;
    } else if (down) {
      regime = 'TRENDING_DOWN';
      reason = `ADX ${metrics.adx.toFixed(1)} with -DI > +DI and EMA20 < EMA50`;
    } else if (lowVol) {
      regime = 'LOW_VOLATILITY';
      reason = `ATR% in ${(percentile * 100).toFixed(0)}th percentile`;
    } else {
      regime = 'SIDEWAYS';
      reason = `ADX ${Number.isNaN(metrics.adx) ? 'n/a' : metrics.adx.toFixed(1)} below trend threshold`;
    }
    if (!tags.includes(regime)) tags.unshift(regime);
    return { regime, tags, metrics, reason };
  }
}

export const marketRegimeService = new MarketRegimeService();
