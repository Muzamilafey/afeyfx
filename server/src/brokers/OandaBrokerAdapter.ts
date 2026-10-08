import { OANDA_BASE } from '../marketData/OandaClient';
import { WithdrawalForbiddenError } from '../utils/errors';
import { errorMessage } from '../utils/logger';
import { BrokerAmbiguousError, type BrokerAdapter, type BrokerCloseResult, type BrokerFill, type BrokerOpenRequest, type BrokerPositionStatus, type BrokerTestResult } from './types';

/**
 * OANDA v20 execution adapter (forex & metals). Market orders are fill-or-kill with stop loss /
 * take profit attached on fill, tagged with our idempotency key as the client id, so an
 * ambiguous request can be looked up (`/trades/@<clientRef>`) before anything is retried.
 * Only the account summary, orders and trades endpoints are reachable (path allow-list).
 */
export interface OandaBrokerConfig {
  token: string;
  accountId: string;
  environment: 'practice' | 'live';
}

type Http = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
const ALLOWED_PATHS = [/^\/v3\/accounts\/[^/]+\/summary$/, /^\/v3\/accounts\/[^/]+\/orders$/, /^\/v3\/accounts\/[^/]+\/trades\/[^/]+(\/close)?$/, /^\/v3\/accounts\/[^/]+\/openTrades$/];

const precisionOf = (symbol: string) => (symbol.endsWith('/JPY') || symbol.startsWith('XAU') ? 3 : symbol.startsWith('XA') || symbol.startsWith('XP') ? 3 : 5);

export class OandaBrokerAdapter implements BrokerAdapter {
  readonly id = 'oanda' as const;
  readonly name = 'OANDA';

  constructor(
    private cfg: OandaBrokerConfig,
    private http: Http = (url, init) => fetch(url, init),
  ) {}

  configured() {
    return !!this.cfg.token && !!this.cfg.accountId;
  }

  supports(symbol: string) {
    const [b, q] = symbol.split('/');
    return /^[A-Z]{3}$/.test(b ?? '') && /^[A-Z]{3}$/.test(q ?? '') && !['USDT', 'USDC'].includes(q);
  }

  private async req(method: string, path: string, body?: unknown) {
    if (!ALLOWED_PATHS.some((r) => r.test(path.split('?')[0]))) throw new WithdrawalForbiddenError(`OANDA endpoint ${path}`);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    let r;
    try {
      r = await this.http(`${OANDA_BASE[this.cfg.environment]}${path}`, { method, headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json', 'Accept-Datetime-Format': 'UNIX' }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    } catch (err) {
      throw new BrokerAmbiguousError(`OANDA request failed: ${errorMessage(err)}`);
    } finally {
      clearTimeout(t);
    }
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status >= 500) throw new BrokerAmbiguousError(`OANDA HTTP ${r.status}`);
    return { ok: r.ok, status: r.status, json };
  }

  private acct() {
    return `/v3/accounts/${encodeURIComponent(this.cfg.accountId)}`;
  }

  async open(q: BrokerOpenRequest): Promise<BrokerFill> {
    const units = Math.floor(q.units);
    if (units < 1) return { status: 'REJECTED', rejectReason: 'Position too small for OANDA (minimum 1 unit)' };
    const p = precisionOf(q.symbol);
    const order: Record<string, unknown> = {
      type: 'MARKET',
      instrument: q.symbol.replace('/', '_'),
      units: String(q.direction === 'LONG' ? units : -units),
      timeInForce: 'FOK',
      positionFill: 'OPEN_ONLY',
      clientExtensions: { id: q.clientRef.slice(0, 128) },
      tradeClientExtensions: { id: q.clientRef.slice(0, 128) },
    };
    if (q.stopLoss) order.stopLossOnFill = { price: q.stopLoss.toFixed(p) };
    if (q.takeProfit) order.takeProfitOnFill = { price: q.takeProfit.toFixed(p) };
    const r = await this.req('POST', `${this.acct()}/orders`, { order });
    const fill = r.json.orderFillTransaction as { price?: string; tradeOpened?: { tradeID: string; units: string }; halfSpreadCost?: string } | undefined;
    if (r.ok && fill?.tradeOpened) return { status: 'FILLED', brokerRef: fill.tradeOpened.tradeID, price: Number(fill.price), units: Math.abs(Number(fill.tradeOpened.units)), feeUsd: 0, raw: fill };
    const cancel = r.json.orderCancelTransaction as { reason?: string } | undefined;
    return { status: 'REJECTED', rejectReason: cancel?.reason ?? String(r.json.errorMessage ?? `OANDA HTTP ${r.status}`), raw: r.json };
  }

  async close(brokerRef: string): Promise<BrokerCloseResult> {
    const r = await this.req('PUT', `${this.acct()}/trades/${encodeURIComponent(brokerRef)}/close`, { units: 'ALL' });
    const fill = r.json.orderFillTransaction as { price?: string; pl?: string } | undefined;
    if (r.ok && fill) return { status: 'CLOSED', pnlUsd: Number(fill.pl), price: Number(fill.price), raw: fill };
    const st = await this.status(brokerRef); // already closed by SL/TP?
    if (!st.open) return { status: 'CLOSED', pnlUsd: st.pnlUsd, price: st.closePrice, raw: st.raw };
    return { status: 'REJECTED', rejectReason: String(r.json.errorMessage ?? `OANDA HTTP ${r.status}`), raw: r.json };
  }

  async status(brokerRef: string): Promise<BrokerPositionStatus> {
    const r = await this.req('GET', `${this.acct()}/trades/${encodeURIComponent(brokerRef)}`);
    const t = r.json.trade as { state?: string; realizedPL?: string; averageClosePrice?: string; unrealizedPL?: string } | undefined;
    if (!r.ok || !t) throw new BrokerAmbiguousError(String(r.json.errorMessage ?? `OANDA HTTP ${r.status}`));
    const open = t.state === 'OPEN';
    return { open, pnlUsd: Number(open ? t.unrealizedPL : t.realizedPL), closePrice: open ? undefined : Number(t.averageClosePrice), raw: t };
  }

  async lookup(clientRef: string): Promise<BrokerFill | null> {
    const r = await this.req('GET', `${this.acct()}/trades/@${encodeURIComponent(clientRef.slice(0, 128))}`);
    const t = r.json.trade as { id: string; price: string; initialUnits: string } | undefined;
    if (!r.ok || !t) return null;
    return { status: 'FILLED', brokerRef: t.id, price: Number(t.price), units: Math.abs(Number(t.initialUnits)), feeUsd: 0, raw: t };
  }

  async openRefs() {
    const r = await this.req('GET', `${this.acct()}/openTrades`);
    return ((r.json.trades ?? []) as { id: string }[]).map((t) => t.id);
  }

  async test(): Promise<BrokerTestResult> {
    try {
      const r = await this.req('GET', `${this.acct()}/summary`);
      const a = r.json.account as { balance?: string; currency?: string; id?: string } | undefined;
      if (!r.ok || !a) return { ok: false, message: String(r.json.errorMessage ?? `OANDA HTTP ${r.status}`) };
      if (a.currency !== 'USD') return { ok: false, message: `OANDA account currency is ${a.currency}; a USD account is required`, currency: a.currency };
      return { ok: true, message: `Connected to OANDA ${this.cfg.environment} account ${a.id}`, balance: Number(a.balance), currency: a.currency, account: a.id, demo: this.cfg.environment === 'practice' };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }
}
