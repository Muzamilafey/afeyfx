import { ArbitrageStrategy } from './ArbitrageStrategy';
import { BreakoutStrategy } from './BreakoutStrategy';
import { MeanReversionStrategy } from './MeanReversionStrategy';
import { MomentumStrategy } from './MomentumStrategy';
import type { BaseStrategy } from './Strategy';
import { TrendFollowingStrategy } from './TrendFollowingStrategy';
import { VwapStrategy } from './VwapStrategy';

type Factory = (params?: Record<string, number>) => BaseStrategy;

export const STRATEGY_FACTORIES: Record<string, Factory> = {
  'trend-following': (p) => new TrendFollowingStrategy(p),
  momentum: (p) => new MomentumStrategy(p),
  'mean-reversion': (p) => new MeanReversionStrategy(p),
  breakout: (p) => new BreakoutStrategy(p),
  vwap: (p) => new VwapStrategy(p),
  arbitrage: (p) => new ArbitrageStrategy(p),
};

export function createStrategy(key: string, params?: Record<string, number>): BaseStrategy {
  const f = STRATEGY_FACTORIES[key];
  if (!f) throw new Error(`Unknown strategy: ${key}`);
  return f(params);
}

export const listStrategyKeys = () => Object.keys(STRATEGY_FACTORIES);
