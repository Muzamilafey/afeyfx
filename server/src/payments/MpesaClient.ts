import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

/**
 * Safaricom Daraja (M-Pesa) API client.
 *  - Deposits: Lipa na M-Pesa Online (STK Push) + STK Push Query (authoritative status check)
 *  - Payouts:  B2C v3 payment request (result delivered asynchronously to ResultURL)
 *
 * Errors are classified: `definite` means M-Pesa received and refused the request (safe to treat
 * as failed). Anything else (network error, timeout, 5xx) is ambiguous - the money may or may not
 * have moved - and callers must NOT assume failure.
 */
export interface DarajaCredentials {
  environment: 'sandbox' | 'production';
  consumerKey: string;
  consumerSecret: string;
  shortcode?: string;
  passkey?: string;
  transactionType?: string;
  partyB?: string;
  accountReference?: string;
  b2cShortcode?: string;
  initiatorName?: string;
  securityCredential?: string;
  b2cCommandId?: string;
}

export interface StkPushInput {
  amountKes: number;
  phone: string;
  reference: string;
  callbackUrl: string;
  description?: string;
}
export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  customerMessage?: string;
}
export type StkQueryState = 'SUCCESS' | 'FAILED' | 'PENDING';
export interface StkQueryResult {
  state: StkQueryState;
  resultCode?: string;
  resultDesc?: string;
}
export interface B2cInput {
  amountKes: number;
  phone: string;
  originatorConversationId: string;
  resultUrl: string;
  timeoutUrl: string;
  remarks: string;
}
export interface B2cResult {
  conversationId?: string;
  originatorConversationId: string;
}

export class MpesaError extends Error {
  constructor(
    message: string,
    public definite: boolean,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'MpesaError';
  }
}

type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
let fetchImpl: FetchFn = (url, init) => fetch(url, init);
/** Test hook. */
export function setMpesaFetch(f: FetchFn | null) {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

export const DARAJA_BASE = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' } as const;

/** Daraja timestamps are East Africa Time (UTC+3), formatted YYYYMMDDHHmmss. */
export function darajaTimestamp(d = new Date()) {
  return new Date(d.getTime() + 3 * 3_600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** Normalise Kenyan mobile numbers (07.., 01.., +2547.., 2547..) to 2547XXXXXXXX / 2541XXXXXXXX. */
export function normalizeKenyanPhone(input: string): string | null {
  const d = String(input ?? '').replace(/[\s()+-]/g, '');
  let n = d;
  if (/^0[17]\d{8}$/.test(d)) n = `254${d.slice(1)}`;
  else if (/^[17]\d{8}$/.test(d)) n = `254${d}`;
  return /^254[17]\d{8}$/.test(n) ? n : null;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
export function clearMpesaTokenCache() {
  tokenCache.clear();
}

const TIMEOUT_MS = 20_000;

export class DarajaClient {
  constructor(private c: DarajaCredentials) {}

  private get base() {
    return DARAJA_BASE[this.c.environment];
  }

  private async call(path: string, init: { method: string; headers: Record<string, string>; body?: string }) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${this.base}${path}`, { ...init, signal: ctl.signal });
    } catch (err) {
      throw new MpesaError(`M-Pesa request failed: ${(err as Error).message}`, false);
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, ok: res.ok, json };
  }

  async token(): Promise<string> {
    const key = `${this.c.environment}:${this.c.consumerKey}`;
    const hit = tokenCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.token;
    const basic = Buffer.from(`${this.c.consumerKey}:${this.c.consumerSecret}`).toString('base64');
    const r = await this.call('/oauth/v1/generate?grant_type=client_credentials', { method: 'GET', headers: { Authorization: `Basic ${basic}` } });
    const token = r.json.access_token as string | undefined;
    if (!r.ok || !token) throw new MpesaError(`M-Pesa authentication failed (HTTP ${r.status})`, r.status >= 400 && r.status < 500, { status: r.status });
    const ttl = Number(r.json.expires_in ?? 3599) * 1000;
    tokenCache.set(key, { token, expiresAt: Date.now() + Math.max(60_000, ttl - 60_000) });
    return token;
  }

  private async post(path: string, body: Record<string, unknown>) {
    const token = await this.token();
    return this.call(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  private stkPassword(timestamp: string) {
    if (!this.c.shortcode || !this.c.passkey) throw new MpesaError('STK Push shortcode/passkey not configured', true);
    return Buffer.from(`${this.c.shortcode}${this.c.passkey}${timestamp}`).toString('base64');
  }

  async stkPush(i: StkPushInput): Promise<StkPushResult> {
    const ts = darajaTimestamp();
    const r = await this.post('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: this.c.shortcode,
      Password: this.stkPassword(ts),
      Timestamp: ts,
      TransactionType: this.c.transactionType ?? 'CustomerPayBillOnline',
      Amount: Math.round(i.amountKes),
      PartyA: i.phone,
      PartyB: this.c.partyB || this.c.shortcode,
      PhoneNumber: i.phone,
      CallBackURL: i.callbackUrl,
      AccountReference: (this.c.accountReference || i.reference).slice(0, 12),
      TransactionDesc: (i.description ?? 'Deposit').slice(0, 13),
    });
    if (r.ok && String(r.json.ResponseCode) === '0' && r.json.CheckoutRequestID) {
      return { merchantRequestId: String(r.json.MerchantRequestID ?? ''), checkoutRequestId: String(r.json.CheckoutRequestID), customerMessage: r.json.CustomerMessage as string | undefined };
    }
    // An STK push that did not return a CheckoutRequestID cannot be completed by the customer.
    throw new MpesaError(String(r.json.errorMessage ?? r.json.ResponseDescription ?? `STK Push failed (HTTP ${r.status})`), r.status < 500, { status: r.status, code: r.json.errorCode ?? r.json.ResponseCode });
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    const ts = darajaTimestamp();
    const r = await this.post('/mpesa/stkpushquery/v1/query', { BusinessShortCode: this.c.shortcode, Password: this.stkPassword(ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId });
    const errorCode = String(r.json.errorCode ?? '');
    // "The transaction is being processed" while the customer has not answered yet.
    if (errorCode === '500.001.1001' || /being processed/i.test(String(r.json.errorMessage ?? ''))) return { state: 'PENDING', resultDesc: String(r.json.errorMessage ?? '') };
    if (!r.ok || r.json.ResultCode === undefined) throw new MpesaError(String(r.json.errorMessage ?? `STK query failed (HTTP ${r.status})`), false, { status: r.status, code: errorCode });
    const code = String(r.json.ResultCode);
    return { state: code === '0' ? 'SUCCESS' : 'FAILED', resultCode: code, resultDesc: String(r.json.ResultDesc ?? '') };
  }

  async b2c(i: B2cInput): Promise<B2cResult> {
    if (!this.c.b2cShortcode || !this.c.initiatorName || !this.c.securityCredential) throw new MpesaError('B2C shortcode/initiator/security credential not configured', true);
    const r = await this.post('/mpesa/b2c/v3/paymentrequest', {
      OriginatorConversationID: i.originatorConversationId,
      InitiatorName: this.c.initiatorName,
      SecurityCredential: this.c.securityCredential,
      CommandID: this.c.b2cCommandId ?? 'BusinessPayment',
      Amount: Math.round(i.amountKes),
      PartyA: this.c.b2cShortcode,
      PartyB: i.phone,
      Remarks: i.remarks.slice(0, 100),
      QueueTimeOutURL: i.timeoutUrl,
      ResultURL: i.resultUrl,
      Occassion: 'Withdrawal',
    });
    if (r.ok && String(r.json.ResponseCode) === '0') return { conversationId: r.json.ConversationID as string | undefined, originatorConversationId: String(r.json.OriginatorConversationID ?? i.originatorConversationId) };
    // 4xx / non-zero ResponseCode: refused before any money moved. 5xx: ambiguous.
    throw new MpesaError(String(r.json.errorMessage ?? r.json.ResponseDescription ?? `B2C request failed (HTTP ${r.status})`), r.status < 500, { status: r.status, code: r.json.errorCode ?? r.json.ResponseCode });
  }
}

/**
 * Local test double used when the admin selects the "simulated" environment (development only;
 * refused in production). It drives the same callback handlers as the real API. Phone numbers
 * ending in 000 simulate a customer cancelling (deposit) or a failed payout.
 */
export class SimulatedMpesa {
  constructor(
    private onStkCallback: (body: unknown) => Promise<unknown>,
    private onB2cResult: (body: unknown) => Promise<unknown>,
    private delayMs = 3_000,
  ) {}

  private later(fn: () => Promise<unknown>) {
    setTimeout(() => void fn().catch((err) => logger.error({ err: (err as Error).message }, 'Simulated M-Pesa callback failed')), this.delayMs).unref?.();
  }

  async stkPush(i: StkPushInput): Promise<StkPushResult> {
    const merchantRequestId = `sim-${randomUUID().slice(0, 8)}`;
    const checkoutRequestId = `ws_CO_SIM_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const cancel = i.phone.endsWith('000');
    this.later(() =>
      this.onStkCallback({
        Body: {
          stkCallback: cancel
            ? { MerchantRequestID: merchantRequestId, CheckoutRequestID: checkoutRequestId, ResultCode: 1032, ResultDesc: 'Request cancelled by user' }
            : {
                MerchantRequestID: merchantRequestId,
                CheckoutRequestID: checkoutRequestId,
                ResultCode: 0,
                ResultDesc: 'The service request is processed successfully.',
                CallbackMetadata: { Item: [{ Name: 'Amount', Value: Math.round(i.amountKes) }, { Name: 'MpesaReceiptNumber', Value: `SIM${randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()}` }, { Name: 'TransactionDate', Value: Number(darajaTimestamp()) }, { Name: 'PhoneNumber', Value: Number(i.phone) }] },
              },
        },
      }),
    );
    return { merchantRequestId, checkoutRequestId, customerMessage: 'Simulated: success. Request accepted for processing' };
  }

  async stkQuery(): Promise<StkQueryResult> {
    return { state: 'SUCCESS', resultCode: '0', resultDesc: 'Simulated confirmation' };
  }

  async b2c(i: B2cInput): Promise<B2cResult> {
    const conversationId = `AG_SIM_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const fail = i.phone.endsWith('000');
    this.later(() =>
      this.onB2cResult({
        Result: fail
          ? { ResultType: 0, ResultCode: 2001, ResultDesc: 'The initiator information is invalid.', OriginatorConversationID: i.originatorConversationId, ConversationID: conversationId, TransactionID: '' }
          : {
              ResultType: 0,
              ResultCode: 0,
              ResultDesc: 'The service request is processed successfully.',
              OriginatorConversationID: i.originatorConversationId,
              ConversationID: conversationId,
              TransactionID: `SIM${randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()}`,
              ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: Math.round(i.amountKes) }] },
            },
      }),
    );
    return { conversationId, originatorConversationId: i.originatorConversationId };
  }
}
