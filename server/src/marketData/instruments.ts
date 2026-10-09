import { env } from '../config/env';

/**
 * Tradable instrument catalogue for the trader terminal.
 *  - crypto: spot pairs streamed from the crypto exchange (DEFAULT_EXCHANGE, via CCXT + WebSocket)
 *  - forex / metals: streamed from the forex venue ('oanda', OANDA v20 pricing API)
 * The system strategy engine trades only MARKET_SYMBOLS; this list is for traders' DEMO/REAL accounts.
 */
export type InstrumentCategory = 'crypto' | 'forex' | 'metals';
export const FOREX_VENUE = 'oanda';

export interface Instrument {
  symbol: string;
  base: string;
  quote: string;
  category: InstrumentCategory;
  venue: string;
  name: string;
  pricePrecision: number;
  /** Decimal places for position size (units). */
  amountPrecision: number;
  /** Venue instrument id (OANDA uses EUR_USD). */
  venueId: string;
  /** Forex / metals: units per 1.00 standard lot (EUR/USD 100,000 EUR; XAU/USD 100 oz). */
  contractSize?: number;
  /** Forex / metals: size of one pip in price terms (0.0001; 0.01 for JPY pairs; metals per convention). */
  pipSize?: number;
}

/** Standard lot specifications (as used by MT4/MT5 brokers). Lots step by 0.01 (a micro lot). */
export const LOT_STEP = 0.01;
export const MAX_LOTS = 100;
const METAL_SPEC: Record<string, { contractSize: number; pipSize: number }> = { XAU: { contractSize: 100, pipSize: 0.1 }, XAG: { contractSize: 5000, pipSize: 0.01 }, XPT: { contractSize: 100, pipSize: 0.1 }, XPD: { contractSize: 100, pipSize: 0.1 } };
function lotSpec(base: string, quote: string) {
  return METAL_SPEC[base] ?? { contractSize: 100_000, pipSize: quote === 'JPY' ? 0.01 : 0.0001 };
}

const CURRENCY_NAMES: Record<string, string> = {
  EUR: 'Euro', USD: 'US Dollar', GBP: 'British Pound', JPY: 'Japanese Yen', CHF: 'Swiss Franc', AUD: 'Australian Dollar', CAD: 'Canadian Dollar', NZD: 'New Zealand Dollar',
  ZAR: 'South African Rand', MXN: 'Mexican Peso', SGD: 'Singapore Dollar', HKD: 'Hong Kong Dollar', NOK: 'Norwegian Krone', SEK: 'Swedish Krona', TRY: 'Turkish Lira', PLN: 'Polish Zloty', CNH: 'Chinese Yuan',
  XAU: 'Gold', XAG: 'Silver', XPT: 'Platinum', XPD: 'Palladium',
};

/** Majors, minors (crosses) and the most liquid exotics available on OANDA. */
export const FOREX_PAIRS = [
  // majors
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'NZD/USD',
  // euro crosses
  'EUR/GBP', 'EUR/JPY', 'EUR/CHF', 'EUR/AUD', 'EUR/CAD', 'EUR/NZD',
  // pound crosses
  'GBP/JPY', 'GBP/CHF', 'GBP/AUD', 'GBP/CAD', 'GBP/NZD',
  // other crosses
  'AUD/JPY', 'AUD/CAD', 'AUD/CHF', 'AUD/NZD', 'CAD/JPY', 'CAD/CHF', 'CHF/JPY', 'NZD/JPY', 'NZD/CAD', 'NZD/CHF',
  // exotics
  'USD/ZAR', 'USD/MXN', 'USD/SGD', 'USD/HKD', 'USD/NOK', 'USD/SEK', 'USD/TRY', 'USD/PLN', 'USD/CNH', 'EUR/TRY', 'EUR/NOK', 'EUR/SEK', 'EUR/PLN',
] as const;
export const METAL_PAIRS = ['XAU/USD', 'XAG/USD', 'XPT/USD', 'XPD/USD'] as const;
export const DEFAULT_CRYPTO_PAIRS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'ADA/USDT', 'DOGE/USDT', 'LTC/USDT', 'AVAX/USDT', 'DOT/USDT', 'LINK/USDT', 'TRX/USDT', 'BCH/USDT', 'ATOM/USDT', 'NEAR/USDT', 'UNI/USDT', 'XLM/USDT', 'TON/USDT'];

const CRYPTO_NAMES: Record<string, string> = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB', XRP: 'XRP', ADA: 'Cardano', DOGE: 'Dogecoin', LTC: 'Litecoin', AVAX: 'Avalanche', DOT: 'Polkadot', LINK: 'Chainlink', TRX: 'TRON', BCH: 'Bitcoin Cash', ATOM: 'Cosmos', NEAR: 'NEAR Protocol', UNI: 'Uniswap', XLM: 'Stellar', TON: 'Toncoin',
};

function fxPrecision(base: string, quote: string) {
  if (base === 'XAU' || base === 'XPT' || base === 'XPD') return 2;
  if (base === 'XAG') return 4;
  if (['JPY', 'HUF'].includes(quote)) return 3;
  if (['MXN', 'ZAR', 'TRY', 'NOK', 'SEK', 'CNH', 'HKD', 'PLN'].includes(quote)) return 5;
  return 5;
}

function build(): Instrument[] {
  const crypto = [...new Set([...env.MARKET_SYMBOLS.split(','), ...(env.TRADER_CRYPTO_SYMBOLS || DEFAULT_CRYPTO_PAIRS.join(',')).split(',')].map((s) => s.trim()).filter(Boolean))];
  const out: Instrument[] = crypto.map((symbol) => {
    const [base, quote] = symbol.split('/');
    return { symbol, base, quote, category: 'crypto', venue: env.DEFAULT_EXCHANGE, name: `${CRYPTO_NAMES[base] ?? base} / ${quote === 'USDT' ? 'Tether' : quote}`, pricePrecision: 2, amountPrecision: 6, venueId: symbol };
  });
  if (forexAvailable()) {
    for (const symbol of [...FOREX_PAIRS, ...METAL_PAIRS]) {
      const [base, quote] = symbol.split('/');
      out.push({ symbol, base, quote, category: METAL_PAIRS.includes(symbol as never) ? 'metals' : 'forex', venue: FOREX_VENUE, name: `${CURRENCY_NAMES[base] ?? base} / ${CURRENCY_NAMES[quote] ?? quote}`, pricePrecision: fxPrecision(base, quote), amountPrecision: 2, venueId: `${base}_${quote}`, ...lotSpec(base, quote) });
    }
  }
  return out;
}

/** Forex needs a price source: OANDA credentials, or the simulated feed in development. */
export const forexAvailable = () => env.FOREX_ENABLED && (env.MARKET_DATA_SOURCE === 'simulated' || (!!env.OANDA_API_TOKEN && !!env.OANDA_ACCOUNT_ID));

let cache: Instrument[] | null = null;
export const instruments = () => (cache ??= build());
/** Rebuild after env changes (tests). */
export const resetInstruments = () => {
  cache = null;
};
export const instrumentOf = (symbol: string) => instruments().find((i) => i.symbol === symbol);
export const venueOf = (symbol: string) => instrumentOf(symbol)?.venue ?? env.DEFAULT_EXCHANGE;
export const cryptoSymbols = () => instruments().filter((i) => i.category === 'crypto').map((i) => i.symbol);
export const forexInstruments = () => instruments().filter((i) => i.venue === FOREX_VENUE);

/** Crypto price precision depends on price level (e.g. DOGE needs more decimals than BTC). */
export function precisionFor(symbol: string, price?: number) {
  const i = instrumentOf(symbol);
  if (i && i.category !== 'crypto') return i.pricePrecision;
  if (!price) return 2;
  return price >= 1000 ? 2 : price >= 10 ? 3 : price >= 1 ? 4 : price >= 0.01 ? 5 : 6;
}

/** True during the weekly forex session (Sunday ~21:00 UTC to Friday ~21:00 UTC). */
export function forexSessionOpen(now = new Date()) {
  const d = now.getUTCDay();
  const h = now.getUTCHours();
  if (d === 6) return false;
  if (d === 5 && h >= 21) return false;
  if (d === 0 && h < 21) return false;
  return true;
}
