import { env } from '../config/env';
import { BinanceAdapter } from './BinanceAdapter';
import { BybitAdapter } from './BybitAdapter';
import { CoinbaseAdapter } from './CoinbaseAdapter';
import type { AdapterOptions } from './CcxtAdapter';
import type { ExchangeAdapter } from './ExchangeAdapter';

export const SUPPORTED_EXCHANGES = ['binance', 'bybit', 'coinbase'] as const;
export type SupportedExchange = (typeof SUPPORTED_EXCHANGES)[number];

export function createAdapter(name: string, opts: AdapterOptions): ExchangeAdapter {
  switch (name) {
    case 'binance':
      return new BinanceAdapter(opts);
    case 'bybit':
      return new BybitAdapter(opts);
    case 'coinbase':
      return new CoinbaseAdapter(opts);
    default:
      throw new Error(`Unsupported exchange: ${name}`);
  }
}

function envCredentials(name: string): AdapterOptions {
  switch (name) {
    case 'binance':
      return { testnet: env.BINANCE_TESTNET, credentials: env.BINANCE_API_KEY ? { apiKey: env.BINANCE_API_KEY, secret: env.BINANCE_API_SECRET } : undefined };
    case 'bybit':
      return { testnet: env.BYBIT_TESTNET, credentials: env.BYBIT_API_KEY ? { apiKey: env.BYBIT_API_KEY, secret: env.BYBIT_API_SECRET } : undefined };
    case 'coinbase':
      return { testnet: false, credentials: env.COINBASE_API_KEY ? { apiKey: env.COINBASE_API_KEY, secret: env.COINBASE_API_SECRET } : undefined };
    default:
      return { testnet: true };
  }
}

/**
 * Registry of adapter instances. Public (market-data) adapters never hold credentials;
 * private adapters are created from env or from encrypted DB credentials (see ExchangeCredentialService).
 */
class ExchangeRegistry {
  private publicAdapters = new Map<string, ExchangeAdapter>();
  private privateAdapters = new Map<string, ExchangeAdapter>();

  public(name: string): ExchangeAdapter {
    let a = this.publicAdapters.get(name);
    if (!a) {
      a = createAdapter(name, { testnet: false });
      this.publicAdapters.set(name, a);
    }
    return a;
  }

  /** Private (authenticated) adapter for trading. Falls back to env credentials. */
  private(name: string): ExchangeAdapter {
    let a = this.privateAdapters.get(name);
    if (!a) {
      a = createAdapter(name, envCredentials(name));
      this.privateAdapters.set(name, a);
    }
    return a;
  }

  setPrivate(name: string, adapter: ExchangeAdapter) {
    this.privateAdapters.set(name, adapter);
  }

  set(name: string, adapter: ExchangeAdapter) {
    this.publicAdapters.set(name, adapter);
    this.privateAdapters.set(name, adapter);
  }

  clear() {
    this.publicAdapters.clear();
    this.privateAdapters.clear();
  }

  async closeAll() {
    await Promise.allSettled([...this.publicAdapters.values(), ...this.privateAdapters.values()].map((a) => a.close()));
  }
}

export const exchangeRegistry = new ExchangeRegistry();
