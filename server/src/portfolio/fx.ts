import { marketDataCache } from '../marketData/MarketDataCache';
import { FOREX_VENUE } from '../marketData/instruments';

/** Account currency is USD; USDT/USDC/USD-quoted pairs need no conversion. */
const USD_LIKE = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD']);

const mid = (symbol: string) => {
  const t = marketDataCache.getTicker(FOREX_VENUE, symbol)?.data;
  return t && t.bid > 0 && t.ask > 0 ? (t.bid + t.ask) / 2 : null;
};

/**
 * USD value of one unit of `currency`, from live forex quotes (USD/XXX or XXX/USD).
 * Returns null when no fresh-enough quote exists: callers must refuse to trade (fail closed).
 */
export function usdPer(currency: string): number | null {
  if (USD_LIKE.has(currency)) return 1;
  const direct = mid(`${currency}/USD`);
  if (direct) return direct;
  const inverse = mid(`USD/${currency}`);
  if (inverse) return 1 / inverse;
  return null;
}

export const quoteOf = (symbol: string) => symbol.split('/')[1] ?? 'USD';
