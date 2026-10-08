import { vi } from 'vitest';

/** A ccxt-shaped fake client. Every method is a spy so tests can assert what was (not) called. */
export function fakeCcxtClient(overrides: Record<string, unknown> = {}) {
  const client: Record<string, unknown> = {
    has: { fetchPositions: false, fetchClosedOrders: true, fetchTime: true, fetchStatus: true },
    markets: {},
    precisionMode: 4,
    loadMarkets: vi.fn(async () => ({})),
    fetchTicker: vi.fn(async (symbol: string) => ({ symbol, timestamp: Date.now(), last: 100, bid: 99.9, ask: 100.1 })),
    fetchOrderBook: vi.fn(async () => ({ timestamp: Date.now(), bids: [[99.9, 5]], asks: [[100.1, 5]] })),
    fetchOHLCV: vi.fn(async () => []),
    fetchBalance: vi.fn(async () => ({ total: { USDT: 1000 }, free: { USDT: 1000 }, used: { USDT: 0 } })),
    fetchOpenOrders: vi.fn(async () => []),
    fetchClosedOrders: vi.fn(async () => []),
    createOrder: vi.fn(async (symbol: string, type: string, side: string, amount: number, _price: unknown, params: Record<string, unknown>) => ({ id: 'ex-1', clientOrderId: params?.clientOrderId, symbol, type, side, amount, filled: 0, remaining: amount, status: 'open', timestamp: Date.now() })),
    cancelOrder: vi.fn(async (id: string, symbol: string) => ({ id, symbol, status: 'canceled', amount: 1, filled: 0 })),
    fetchOrder: vi.fn(async (id: string, symbol: string) => ({ id, symbol, side: 'buy', type: 'market', amount: 1, filled: 1, remaining: 0, average: 100.1, status: 'closed', fee: { cost: 0.1, currency: 'USDT' }, timestamp: Date.now() })),
    fetchMyTrades: vi.fn(async () => []),
    fetchTime: vi.fn(async () => Date.now()),
    fetchStatus: vi.fn(async () => ({ status: 'ok' })),
    withdraw: vi.fn(async () => ({ id: 'should-never-happen' })),
    transfer: vi.fn(async () => ({ id: 'should-never-happen' })),
    sapiPostCapitalWithdrawApply: vi.fn(async () => ({ id: 'should-never-happen' })),
    ...overrides,
  };
  return client;
}
