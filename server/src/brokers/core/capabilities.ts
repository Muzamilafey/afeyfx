import type { BrokerProvider, Capability } from './types';

/**
 * Provider capability registry: what each integration implements, how it was tested, and what
 * is known about availability. "tested" is honest: 'mock' = automated tests against mocked
 * broker responses; 'demo' = verified against a real broker demo account (recorded at runtime
 * by connection tests in the BrokerCapability collection). Nothing here is "production-ready"
 * until it has been verified on a demo account.
 */
export type ImplStatus = 'implemented' | 'unsupported' | 'not_implemented';

export interface CapabilityInfo {
  status: ImplStatus;
  tested: 'mock' | 'none';
  note?: string;
}

export interface ProviderInfo {
  provider: BrokerProvider;
  name: string;
  kind: string;
  connectMethod: string;
  demoSupport: boolean;
  docs: string;
  /** Eligibility facts as verified (or not) at implementation time. */
  eligibility: { kenya: 'verified' | 'unverified' | 'restricted'; note: string };
  /** Overall readiness of the integration. */
  readiness: 'awaiting-demo-verification' | 'demo-verified' | 'production-ready';
  capabilities: Record<Capability, CapabilityInfo>;
}

const cap = (status: ImplStatus, tested: 'mock' | 'none' = status === 'implemented' ? 'mock' : 'none', note?: string): CapabilityInfo => ({ status, tested, note });

export const PROVIDERS: Record<BrokerProvider, ProviderInfo> = {
  deriv: {
    provider: 'deriv',
    name: 'Deriv',
    kind: 'Options & multipliers (forex, crypto, metals, synthetic indices)',
    connectMethod: 'OAuth 2.0 (authorization code + PKCE) — preferred; Personal Access Token + App ID as fallback',
    demoSupport: true,
    docs: 'https://developers.deriv.com/docs/',
    eligibility: { kenya: 'unverified', note: "Deriv's restricted-countries list could not be retrieved from the build environment. Confirm in Deriv's help centre that your country of residence is accepted." },
    readiness: 'awaiting-demo-verification',
    capabilities: {
      connect: cap('implemented', 'mock', 'REST account list + one-time-password WebSocket'),
      oauth: cap('implemented', 'mock', 'Authorization code + PKCE; token exchange on the server'),
      refreshAuth: cap('implemented', 'none', 'Only if Deriv issues a refresh token; otherwise re-authorization is requested (no automated test yet)'),
      revokeAuth: cap('not_implemented', 'none', 'No revocation endpoint was confirmed in the docs; tokens are deleted locally — revoke the app in Deriv settings'),
      accountInfo: cap('implemented'),
      margin: cap('unsupported', 'none', 'Options/multiplier accounts have no margin figures'),
      instruments: cap('implemented', 'mock', 'active_symbols'),
      quotes: cap('implemented', 'mock', 'ticks subscriptions (Deriv quotes are a single spot price)'),
      orderBook: cap('unsupported'),
      candles: cap('implemented', 'mock', 'ticks_history style=candles'),
      marketOrder: cap('implemented', 'mock', 'proposal → buy (Multipliers, Rise/Fall)'),
      pendingOrder: cap('unsupported', 'none', 'Contracts are bought at the current price'),
      stopLossTakeProfit: cap('implemented', 'mock', 'Multipliers limit_order (amounts in account currency)'),
      modifyOrder: cap('not_implemented', 'none', 'contract_update not implemented yet'),
      cancelOrder: cap('unsupported', 'none', 'Only deal-cancellation contracts can be cancelled; not offered'),
      closePosition: cap('implemented', 'mock', 'sell at market (when the contract is valid to sell)'),
      partialClose: cap('unsupported'),
      positions: cap('implemented', 'mock', 'portfolio + proposal_open_contract'),
      openOrders: cap('unsupported', 'none', 'No resting orders'),
      transactions: cap('implemented', 'mock', 'statement'),
      contracts: cap('implemented', 'mock', 'Contract lifecycle incl. expiry/settlement'),
      reconcile: cap('implemented'),
    },
  },
  mt5: {
    provider: 'mt5',
    name: 'MetaTrader 5 (via AfeyFX Bridge EA)',
    kind: 'Forex/CFD brokers on MT5 (e.g. Exness MT5 accounts, if the broker allows Expert Advisors)',
    connectMethod: 'Your MT5 terminal runs the AfeyFX Bridge Expert Advisor, which connects out to AfeyFX over HTTPS with an HMAC-signed protocol. Your MT5 password never leaves the terminal.',
    demoSupport: true,
    docs: 'docs/BROKERS.md#metatrader-5-bridge',
    eligibility: { kenya: 'unverified', note: 'Depends on the MT5 broker. Exness (KE) Limited states it is licensed by Kenya’s CMA; confirm that Expert Advisors and WebRequest are allowed on your account type.' },
    readiness: 'awaiting-demo-verification',
    capabilities: {
      connect: cap('implemented', 'mock', 'Terminal registration + heartbeat (mock terminal in tests; EA not compiled in CI)'),
      oauth: cap('unsupported'),
      refreshAuth: cap('unsupported'),
      revokeAuth: cap('implemented', 'none', 'Rotating/deleting the terminal secret disconnects the EA (no automated test yet)'),
      accountInfo: cap('implemented'),
      margin: cap('implemented'),
      instruments: cap('implemented', 'mock', 'Symbol specifications reported by the EA'),
      quotes: cap('implemented', 'mock', 'Quotes pushed by the EA'),
      orderBook: cap('not_implemented'),
      candles: cap('not_implemented', 'none', 'Use the platform market data for charts'),
      marketOrder: cap('implemented'),
      pendingOrder: cap('implemented', 'none', 'Limit/stop commands implemented; no automated test yet'),
      stopLossTakeProfit: cap('implemented'),
      modifyOrder: cap('implemented', 'none', 'No automated test yet'),
      cancelOrder: cap('implemented', 'none', 'No automated test yet'),
      closePosition: cap('implemented'),
      partialClose: cap('implemented', 'none', 'Close with a volume; no automated test yet'),
      positions: cap('implemented'),
      openOrders: cap('implemented', 'none', 'Reported by the EA heartbeat; no automated test yet'),
      transactions: cap('implemented', 'mock', 'Recent deals reported in heartbeats'),
      contracts: cap('unsupported'),
      reconcile: cap('implemented'),
    },
  },
};

export const implemented = (provider: BrokerProvider, c: Capability) => PROVIDERS[provider].capabilities[c].status === 'implemented';
export const capabilitySet = (provider: BrokerProvider) => new Set((Object.entries(PROVIDERS[provider].capabilities) as [Capability, CapabilityInfo][]).filter(([, v]) => v.status === 'implemented').map(([k]) => k));

/** Providers evaluated but not integrated (and why). Shown in the UI and docs. */
export const EVALUATED_PROVIDERS = [
  { name: 'Exness API (direct)', status: 'not integrated', reason: 'Exness documents an API only for "Exness trading accounts" (not standard MetaTrader accounts), with full KYC and key management. Its documentation could not be retrieved from the build environment, so no adapter was written. Exness MT5 accounts can use the MT5 bridge if Expert Advisors are allowed.' },
  { name: 'OANDA (execution)', status: 'platform routing only', reason: 'OANDA v20 is used for forex prices and optional platform-level routing. Kenyan eligibility could not be confirmed; check OANDA’s country list for your entity before connecting an account.' },
  { name: 'Other MT5 brokers', status: 'via MT5 bridge', reason: 'Any MT5 broker that allows Expert Advisors and WebRequest to your AfeyFX URL. Verify the broker’s licence and terms for your country.' },
];
