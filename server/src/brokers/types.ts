/**
 * Live broker execution layer for traders' REAL accounts.
 *
 * By default REAL-account orders fill internally at the real market price. An admin can route an
 * asset class (crypto / forex / metals) to an external broker instead (Deriv, OANDA, ...). Each
 * broker is an adapter implementing this interface; adding a broker = adding one adapter.
 *
 * Adapter rules:
 *  - Opens must be idempotent on `clientRef`, and after an ambiguous failure (timeout, dropped
 *    connection) the adapter must be able to `lookup` whether the position was opened.
 *  - Results come from the broker's own response (fill price, P&L) - never assumed.
 *  - Adapters expose NO deposit, withdrawal or transfer capability of any kind.
 */
export type BrokerId = 'deriv' | 'oanda';
export type Direction = 'LONG' | 'SHORT';

export interface BrokerOpenRequest {
  symbol: string;
  direction: Direction;
  /** Position size in base units (exposure = units x price). */
  units: number;
  /** Investment (exposure) in USD. */
  investmentUsd: number;
  stopLoss?: number;
  takeProfit?: number;
  /** Our idempotency key. */
  clientRef: string;
  /** Latest quote, used for sizing and sanity checks. */
  price: number;
}

export interface BrokerFill {
  status: 'FILLED' | 'REJECTED';
  brokerRef?: string;
  /** Average fill price. */
  price?: number;
  units?: number;
  /** Broker costs in USD not already reflected in the fill price / P&L. */
  feeUsd?: number;
  rejectReason?: string;
  raw?: unknown;
}

export interface BrokerCloseResult {
  status: 'CLOSED' | 'REJECTED';
  /** Realized P&L in USD as reported by the broker (net of its costs). */
  pnlUsd?: number;
  price?: number;
  rejectReason?: string;
  raw?: unknown;
}

export interface BrokerPositionStatus {
  open: boolean;
  pnlUsd?: number;
  closePrice?: number;
  raw?: unknown;
}

export interface BrokerTestResult {
  ok: boolean;
  message: string;
  balance?: number;
  currency?: string;
  account?: string;
  demo?: boolean;
}

export interface BrokerAdapter {
  readonly id: BrokerId;
  readonly name: string;
  configured(): boolean;
  supports(symbol: string): boolean;
  open(req: BrokerOpenRequest): Promise<BrokerFill>;
  close(brokerRef: string, ctx: { symbol: string; clientRef: string }): Promise<BrokerCloseResult>;
  status(brokerRef: string): Promise<BrokerPositionStatus>;
  /** After an ambiguous open: find the position opened for `clientRef`, if any. */
  lookup(clientRef: string, req: BrokerOpenRequest, since: number): Promise<BrokerFill | null>;
  openRefs(): Promise<string[]>;
  test(): Promise<BrokerTestResult>;
}

/** An error where the broker's answer is unknown (the request may or may not have executed). */
export class BrokerAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerAmbiguousError';
  }
}
