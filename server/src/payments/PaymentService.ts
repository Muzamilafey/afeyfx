import crypto from 'crypto';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { PaymentConfigModel, type PaymentConfigDoc } from '../models/PaymentConfig';
import { PaymentModel, type PaymentDoc, type PaymentStatus } from '../models/PaymentTransaction';
import { SystemEventModel } from '../models/SystemEvent';
import { User } from '../models/User';
import { portfolioService } from '../portfolio/PortfolioService';
import { notificationService } from '../notifications/NotificationService';
import { emailHtml, mailService } from '../services/MailService';
import { AppError } from '../utils/errors';
import { decrypt, encrypt, mask, randomToken } from '../utils/crypto';
import { eventBus } from '../utils/eventBus';
import { errorMessage, logger } from '../utils/logger';
import { DarajaClient, MpesaError, SimulatedMpesa, normalizeKenyanPhone, type B2cInput, type B2cResult, type StkPushInput, type StkPushResult, type StkQueryResult } from './MpesaClient';

/**
 * Real-money M-Pesa deposits and payouts for traders' REAL accounts.
 *
 * Money-safety rules:
 *  - A deposit is credited exactly once, and only after M-Pesa confirms it (callback AND, for the
 *    real API, an STK Push Query - callbacks are unsigned, so they are never trusted alone).
 *  - Payout funds are held (debited) atomically when requested, so they cannot also be traded.
 *  - Held funds are refunded exactly once, and only on a DEFINITE failure. Ambiguous outcomes
 *    (timeouts, network errors, missing results) become UNCERTAIN for an admin to resolve
 *    against the M-Pesa statement - never auto-refunded, which could pay out twice.
 *  - Payouts need admin approval unless they are at or below the admin's auto-approve threshold
 *    AND go to a phone that already made a successful deposit.
 */

interface Provider {
  stkPush(i: StkPushInput): Promise<StkPushResult>;
  stkQuery(checkoutRequestId: string): Promise<StkQueryResult>;
  b2c(i: B2cInput): Promise<B2cResult>;
}

export type PayoutInput = { amountUsd: number; phone: string; firstName: string; lastName: string; idempotencyKey: string };
export type DepositInput = { amountUsd: number; phone: string; idempotencyKey: string };

const FRIENDLY: Record<string, string> = {
  '1032': 'Cancelled on the phone',
  '1037': 'No response from the phone (timed out)',
  '1': 'Insufficient M-Pesa balance',
  '2001': 'Wrong M-Pesa PIN',
  '1001': 'Another M-Pesa transaction is in progress on this phone',
  '1019': 'The request expired',
};

const cents = (usd: number) => Math.round(usd * 100);
const usd = (c: number) => c / 100;
const OPEN_STATUSES: PaymentStatus[] = ['PENDING', 'PROCESSING', 'UNCERTAIN'];

function publicBaseUrl() {
  return (env.API_PUBLIC_URL || env.APP_URL || env.CLIENT_ORIGIN.split(',')[0]).trim().replace(/\/+$/, '');
}

function newReference() {
  return String(crypto.randomInt(100_000_000, 999_999_999)) + String(crypto.randomInt(100, 999));
}

const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, 5)}****${p.slice(-3)}` : p);

/** Keep only what is useful for support and safe to store: never credentials. */
function sanitizeEvent(kind: string, data: unknown) {
  const clean = JSON.parse(JSON.stringify(data ?? {}, (k, v) => (/(password|secret|credential|token|passkey)/i.test(k) ? '[REDACTED]' : v)));
  return { at: new Date(), kind, data: clean };
}

export class PaymentService {
  private simulated = new SimulatedMpesa(
    (b) => this.handleStkCallback(b),
    (b) => this.handleB2cResult(b),
  );
  private providerOverride: Provider | null = null;

  /** Test hook: replace the M-Pesa provider. */
  setProvider(p: Provider | null) {
    this.providerOverride = p;
  }
  /** Test hook: change the simulated provider's callback delay. */
  setSimulatedDelay(ms: number) {
    this.simulated = new SimulatedMpesa((b) => this.handleStkCallback(b), (b) => this.handleB2cResult(b), ms);
  }

  // ---------------------------------------------------------------- configuration

  async config(): Promise<PaymentConfigDoc> {
    let c = await PaymentConfigModel.findOne({ key: 'mpesa' });
    if (!c) c = await PaymentConfigModel.findOneAndUpdate({ key: 'mpesa' }, { $setOnInsert: { key: 'mpesa', callbackToken: randomToken(24) } }, { upsert: true, new: true });
    if (!c!.callbackToken) {
      c!.callbackToken = randomToken(24);
      await c!.save();
    }
    return c!;
  }

  private secret(enc?: string | null) {
    if (!enc) return '';
    try {
      return decrypt(enc);
    } catch {
      return '';
    }
  }

  depositsConfigured(c: PaymentConfigDoc) {
    if (c.environment === 'simulated') return env.NODE_ENV !== 'production';
    return !!(c.consumerKeyEnc && c.consumerSecretEnc && c.shortcode && c.passkeyEnc);
  }

  payoutsConfigured(c: PaymentConfigDoc) {
    if (c.environment === 'simulated') return env.NODE_ENV !== 'production';
    return !!(c.consumerKeyEnc && c.consumerSecretEnc && c.b2cShortcode && c.initiatorName && c.securityCredentialEnc);
  }

  callbackUrls(c: PaymentConfigDoc) {
    const b = `${publicBaseUrl()}/api/payments/mpesa`;
    return { stk: `${b}/stk/${c.callbackToken}`, b2cResult: `${b}/b2c/result/${c.callbackToken}`, b2cTimeout: `${b}/b2c/timeout/${c.callbackToken}` };
  }

  private provider(c: PaymentConfigDoc): Provider {
    if (this.providerOverride) return this.providerOverride;
    if (c.environment === 'simulated') {
      if (env.NODE_ENV === 'production') throw new AppError(409, 'The simulated M-Pesa provider is not allowed in production', 'PAYMENTS_MISCONFIGURED');
      return this.simulated;
    }
    return new DarajaClient({
      environment: c.environment as 'sandbox' | 'production',
      consumerKey: this.secret(c.consumerKeyEnc),
      consumerSecret: this.secret(c.consumerSecretEnc),
      shortcode: c.shortcode ?? undefined,
      passkey: this.secret(c.passkeyEnc),
      transactionType: c.transactionType ?? undefined,
      partyB: c.partyB ?? undefined,
      accountReference: c.accountReference ?? undefined,
      b2cShortcode: c.b2cShortcode ?? undefined,
      initiatorName: c.initiatorName ?? undefined,
      securityCredential: this.secret(c.securityCredentialEnc),
      b2cCommandId: c.b2cCommandId ?? undefined,
    });
  }

  /** What traders need to render the deposit and withdrawal screens. No credentials. */
  async publicConfig() {
    const c = await this.config();
    return {
      currency: 'USD',
      methods: [{ id: 'MPESA', name: 'M-Pesa', instant: true }],
      deposits: { enabled: c.depositsEnabled && this.depositsConfigured(c), minUsd: usd(c.minDepositCents), maxUsd: usd(c.maxDepositCents), rate: c.depositRate },
      payouts: {
        enabled: c.payoutsEnabled && this.payoutsConfigured(c),
        minUsd: usd(c.minPayoutCents),
        maxUsd: usd(c.maxPayoutCents),
        dailyLimitUsd: usd(c.dailyPayoutLimitCents),
        rate: c.payoutRate,
        feePct: c.payoutFeePct,
        feeFixedUsd: usd(c.payoutFeeFixedCents),
        depositPhonesOnly: c.payoutsToDepositPhonesOnly,
      },
      realTradingEnabled: c.realTradingEnabled && env.MARKET_DATA_SOURCE !== 'simulated',
      sandbox: c.environment !== 'production',
    };
  }

  /** Admin view: settings plus which secrets are set (masked); secrets themselves never leave the server. */
  async adminConfig() {
    const c = await this.config();
    const base = publicBaseUrl();
    return {
      depositsEnabled: c.depositsEnabled,
      payoutsEnabled: c.payoutsEnabled,
      realTradingEnabled: c.realTradingEnabled,
      environment: c.environment,
      shortcode: c.shortcode ?? '',
      transactionType: c.transactionType,
      partyB: c.partyB ?? '',
      accountReference: c.accountReference ?? '',
      b2cShortcode: c.b2cShortcode ?? '',
      initiatorName: c.initiatorName ?? '',
      b2cCommandId: c.b2cCommandId,
      callbackIps: c.callbackIps ?? [],
      depositRate: c.depositRate,
      payoutRate: c.payoutRate,
      minDepositUsd: usd(c.minDepositCents),
      maxDepositUsd: usd(c.maxDepositCents),
      minPayoutUsd: usd(c.minPayoutCents),
      maxPayoutUsd: usd(c.maxPayoutCents),
      dailyPayoutLimitUsd: usd(c.dailyPayoutLimitCents),
      payoutFeePct: c.payoutFeePct,
      payoutFeeFixedUsd: usd(c.payoutFeeFixedCents),
      autoApproveBelowUsd: usd(c.autoApproveBelowCents),
      payoutsToDepositPhonesOnly: c.payoutsToDepositPhonesOnly,
      secrets: {
        consumerKey: c.consumerKeyEnc ? mask(this.secret(c.consumerKeyEnc)) : '',
        consumerSecret: !!c.consumerSecretEnc,
        passkey: !!c.passkeyEnc,
        securityCredential: !!c.securityCredentialEnc,
      },
      status: {
        depositsConfigured: this.depositsConfigured(c),
        payoutsConfigured: this.payoutsConfigured(c),
        callbackBaseIsHttps: base.startsWith('https://'),
        simulatedAllowed: env.NODE_ENV !== 'production',
        simulatedMarketData: env.MARKET_DATA_SOURCE === 'simulated',
      },
      callbackUrls: this.callbackUrls(c),
      updatedAt: c.updatedAt,
    };
  }

  async updateConfig(input: Record<string, unknown>, adminId: string) {
    const c = await this.config();
    const num = (k: string) => (input[k] === undefined ? undefined : Number(input[k]));
    if (input.environment === 'simulated' && env.NODE_ENV === 'production') throw new AppError(400, 'The simulated provider cannot be used in production', 'VALIDATION_ERROR');
    for (const k of ['depositsEnabled', 'payoutsEnabled', 'realTradingEnabled', 'payoutsToDepositPhonesOnly'] as const) if (input[k] !== undefined) c.set(k, input[k] === true);
    for (const k of ['environment', 'shortcode', 'transactionType', 'partyB', 'accountReference', 'b2cShortcode', 'initiatorName', 'b2cCommandId'] as const) if (input[k] !== undefined) c.set(k, String(input[k]).trim());
    if (Array.isArray(input.callbackIps)) c.callbackIps = (input.callbackIps as string[]).map((s) => s.trim()).filter(Boolean);
    // Secrets: a non-empty value replaces the stored one; empty/omitted keeps it. `clearSecrets` removes.
    const secretMap = { consumerKey: 'consumerKeyEnc', consumerSecret: 'consumerSecretEnc', passkey: 'passkeyEnc', securityCredential: 'securityCredentialEnc' } as const;
    for (const [k, field] of Object.entries(secretMap)) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) c.set(field, encrypt(v.trim()));
    }
    for (const k of (input.clearSecrets as string[] | undefined) ?? []) if (k in secretMap) c.set(secretMap[k as keyof typeof secretMap], undefined);
    if (input.rotateCallbackToken === true) c.callbackToken = randomToken(24);

    const rate = (k: 'depositRate' | 'payoutRate') => {
      const v = num(k);
      if (v !== undefined) c[k] = v;
    };
    rate('depositRate');
    rate('payoutRate');
    const centsField = { minDepositUsd: 'minDepositCents', maxDepositUsd: 'maxDepositCents', minPayoutUsd: 'minPayoutCents', maxPayoutUsd: 'maxPayoutCents', dailyPayoutLimitUsd: 'dailyPayoutLimitCents', payoutFeeFixedUsd: 'payoutFeeFixedCents', autoApproveBelowUsd: 'autoApproveBelowCents' } as const;
    for (const [k, field] of Object.entries(centsField)) {
      const v = num(k);
      if (v !== undefined) c.set(field, cents(v));
    }
    if (num('payoutFeePct') !== undefined) c.payoutFeePct = num('payoutFeePct')!;

    if (!(c.depositRate > 0 && c.payoutRate > 0)) throw new AppError(400, 'Exchange rates must be positive', 'VALIDATION_ERROR');
    if (c.minDepositCents > c.maxDepositCents) throw new AppError(400, 'Minimum deposit exceeds the maximum', 'VALIDATION_ERROR');
    if (c.minPayoutCents > c.maxPayoutCents) throw new AppError(400, 'Minimum withdrawal exceeds the maximum', 'VALIDATION_ERROR');
    if (c.maxPayoutCents > c.dailyPayoutLimitCents) throw new AppError(400, 'Maximum withdrawal exceeds the daily limit', 'VALIDATION_ERROR');
    if (c.payoutFeePct < 0 || c.payoutFeePct > 0.2) throw new AppError(400, 'Withdrawal fee must be between 0% and 20%', 'VALIDATION_ERROR');
    if (c.depositsEnabled && !this.depositsConfigured(c)) throw new AppError(400, 'Deposits need the consumer key/secret, shortcode and passkey first', 'VALIDATION_ERROR');
    if (c.payoutsEnabled && !this.payoutsConfigured(c)) throw new AppError(400, 'Withdrawals need the consumer key/secret, B2C shortcode, initiator name and security credential first', 'VALIDATION_ERROR');
    c.updatedBy = adminId as never;
    await c.save();
    return this.adminConfig();
  }

  /** Admin "test connection": fetch an OAuth token from Daraja with the stored credentials. */
  async testConnection() {
    const c = await this.config();
    if (c.environment === 'simulated') return { ok: true, message: 'Simulated provider (development only) - no connection needed' };
    const client = this.provider(c);
    if (!(client instanceof DarajaClient)) return { ok: true, message: 'Custom provider' };
    try {
      await client.token();
      return { ok: true, message: `Connected to Daraja ${c.environment}` };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  /** Callbacks are unsigned: require the secret path token and (optionally) a source-IP allow-list. */
  async verifyCallback(token: string, ip: string | undefined) {
    const c = await this.config();
    const a = Buffer.from(String(token ?? ''));
    const b = Buffer.from(c.callbackToken ?? '');
    const tokenOk = a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
    const ipOk = !c.callbackIps?.length || (!!ip && c.callbackIps.includes(ip.replace(/^::ffff:/, '')));
    return tokenOk && ipOk;
  }

  // ---------------------------------------------------------------- quotes and views

  payoutQuote(c: PaymentConfigDoc, amountCents: number) {
    const fee = Math.round(amountCents * c.payoutFeePct) + c.payoutFeeFixedCents;
    const net = amountCents - fee;
    return { feeCents: fee, netCents: net, amountKes: Math.floor((net * c.payoutRate) / 100) };
  }

  view(t: PaymentDoc) {
    return {
      id: t._id.toString(),
      user: t.user.toString(),
      reference: t.reference,
      type: t.type,
      method: 'M-Pesa',
      status: t.status,
      amount: usd(t.amountCents),
      fee: usd(t.feeCents ?? 0),
      net: usd(t.amountCents - (t.type === 'PAYOUT' ? (t.feeCents ?? 0) : 0)),
      amountKes: t.amountKes,
      rate: t.rate,
      phone: maskPhone(t.phone),
      receipt: t.receipt ?? null,
      message: t.status === 'FAILED' || t.status === 'REJECTED' ? (t.resultCode && FRIENDLY[t.resultCode]) || t.resultDesc || t.reviewNote || null : t.status === 'UNCERTAIN' ? 'Being checked by our payments team' : null,
      createdAt: t.createdAt,
      completedAt: t.completedAt ?? null,
    };
  }

  adminView(t: PaymentDoc & { user: unknown }) {
    const u = t.user as { _id?: unknown; email?: string; name?: string } | null;
    return {
      ...this.view(t as PaymentDoc),
      user: u && typeof u === 'object' && '_id' in u ? String(u._id) : String(t.user),
      userEmail: u && typeof u === 'object' ? u.email : undefined,
      phone: t.phone,
      firstName: t.firstName,
      lastName: t.lastName,
      provider: t.provider,
      resultCode: t.resultCode,
      resultDesc: t.resultDesc,
      checkoutRequestId: t.checkoutRequestId,
      originatorConversationId: t.originatorConversationId,
      conversationId: t.conversationId,
      credited: t.credited,
      held: t.held,
      refunded: t.refunded,
      knownDestination: t.knownDestination,
      reviewNote: t.reviewNote,
      reviewedAt: t.reviewedAt,
      events: t.events,
    };
  }

  private publish(t: PaymentDoc) {
    eventBus.publish('payment', this.view(t));
  }

  private async event(t: PaymentDoc, kind: string, data: unknown) {
    await PaymentModel.updateOne({ _id: t._id }, { $push: { events: sanitizeEvent(kind, data) } });
  }

  private async mailUser(userId: unknown, title: string, body: string) {
    try {
      const u = await User.findById(userId);
      if (!u?.emailVerified || !mailService.configured) return;
      await mailService.send({ to: u.email, subject: `AfeyFX: ${title}`, text: body, html: emailHtml(title, body) });
    } catch (err) {
      logger.warn({ err: errorMessage(err) }, 'Payment email failed');
    }
  }

  // ---------------------------------------------------------------- deposits

  async createDeposit(userId: string, input: DepositInput) {
    const existing = await PaymentModel.findOne({ user: userId, idempotencyKey: input.idempotencyKey });
    if (existing) return existing;
    const c = await this.config();
    if (!c.depositsEnabled || !this.depositsConfigured(c)) throw new AppError(409, 'Deposits are not available right now', 'DEPOSITS_DISABLED');
    const amountCents = cents(input.amountUsd);
    if (amountCents < c.minDepositCents || amountCents > c.maxDepositCents) throw new AppError(400, `Deposit must be between $${usd(c.minDepositCents)} and $${usd(c.maxDepositCents)}`, 'AMOUNT_OUT_OF_RANGE');
    const phone = normalizeKenyanPhone(input.phone);
    if (!phone) throw new AppError(400, 'Enter a valid Safaricom number, e.g. 0712 345 678', 'INVALID_PHONE');
    const recent = await PaymentModel.countDocuments({ user: userId, type: 'DEPOSIT', status: 'PENDING', createdAt: { $gt: new Date(Date.now() - 10 * 60_000) } });
    if (recent >= 3) throw new AppError(429, 'You have deposits waiting for confirmation. Complete them on your phone or wait a few minutes.', 'TOO_MANY_PENDING');

    const amountKes = Math.ceil((amountCents * c.depositRate) / 100);
    let t: PaymentDoc;
    try {
      t = await PaymentModel.create({ user: userId, reference: newReference(), type: 'DEPOSIT', provider: c.environment === 'simulated' && !this.providerOverride ? 'simulated' : 'daraja', status: 'PENDING', idempotencyKey: input.idempotencyKey, amountCents, amountKes, rate: c.depositRate, phone });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const dup = await PaymentModel.findOne({ user: userId, idempotencyKey: input.idempotencyKey });
        if (dup) return dup;
      }
      throw err;
    }
    try {
      const r = await this.provider(c).stkPush({ amountKes, phone, reference: t.reference, callbackUrl: this.callbackUrls(c).stk, description: 'Deposit' });
      t.merchantRequestId = r.merchantRequestId;
      t.checkoutRequestId = r.checkoutRequestId;
      t.events.push(sanitizeEvent('stk-push', r));
      await t.save();
    } catch (err) {
      const definite = err instanceof MpesaError ? err.definite : false;
      t.status = definite ? 'FAILED' : 'UNCERTAIN';
      t.resultDesc = definite ? 'M-Pesa could not start the payment. Please try again.' : 'M-Pesa did not answer in time';
      t.events.push(sanitizeEvent('stk-push-error', { message: errorMessage(err), details: (err as MpesaError).details }));
      await t.save();
      logger.warn({ err: errorMessage(err), ref: t.reference }, 'STK push failed');
      if (!definite) void notificationService.notify('PAYMENT_ATTENTION', 'Deposit needs review', `STK push for deposit ${t.reference} had no definite answer`);
    }
    this.publish(t);
    return t;
  }

  async handleStkCallback(body: unknown) {
    const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback;
    if (!cb?.CheckoutRequestID) return { ok: false, reason: 'malformed' };
    const t = await PaymentModel.findOne({ type: 'DEPOSIT', checkoutRequestId: String(cb.CheckoutRequestID) });
    if (!t) {
      await SystemEventModel.create({ type: 'PAYMENT_ORPHAN_CALLBACK', level: 'warn', component: 'mpesa', message: 'STK callback for an unknown request', details: sanitizeEvent('stk-callback', cb) }).catch(() => undefined);
      return { ok: false, reason: 'unknown' };
    }
    await this.event(t, 'stk-callback', cb);
    if (t.status !== 'PENDING' && t.status !== 'UNCERTAIN') return { ok: true, reason: 'already-final' };

    const code = String(cb.ResultCode);
    if (code !== '0') {
      await this.finish(t, ['PENDING', 'UNCERTAIN'], 'FAILED', { resultCode: code, resultDesc: String(cb.ResultDesc ?? '') });
      return { ok: true };
    }
    const items = ((cb.CallbackMetadata as { Item?: { Name: string; Value?: unknown }[] })?.Item ?? []).reduce<Record<string, unknown>>((m, i) => ((m[i.Name] = i.Value), m), {});
    const paid = Number(items.Amount);
    const receipt = items.MpesaReceiptNumber ? String(items.MpesaReceiptNumber) : undefined;
    if (!(paid === t.amountKes)) {
      await this.finish(t, ['PENDING'], 'UNCERTAIN', { resultCode: code, resultDesc: `Amount mismatch: expected KES ${t.amountKes}, callback says ${String(items.Amount)}` });
      void notificationService.notify('PAYMENT_ATTENTION', 'Deposit amount mismatch', `Deposit ${t.reference}: expected KES ${t.amountKes}, callback reported ${String(items.Amount)}`);
      return { ok: true };
    }
    if (receipt) await PaymentModel.updateOne({ _id: t._id, receipt: null }, { $set: { receipt } }).catch(() => undefined);
    // Unsigned callback: confirm with M-Pesa before crediting.
    await this.confirmDeposit(t._id.toString());
    return { ok: true };
  }

  /** Ask M-Pesa for the authoritative status of a deposit; credit it if paid. */
  async confirmDeposit(id: string) {
    const t = await PaymentModel.findById(id);
    if (!t || t.type !== 'DEPOSIT' || !t.checkoutRequestId || !['PENDING', 'UNCERTAIN'].includes(t.status)) return t;
    const c = await this.config();
    let q: StkQueryResult;
    try {
      q = await this.provider(c).stkQuery(t.checkoutRequestId);
    } catch (err) {
      await PaymentModel.updateOne({ _id: t._id }, { $set: { lastQueriedAt: new Date() }, $push: { events: sanitizeEvent('stk-query-error', { message: errorMessage(err) }) } });
      return t; // try again later (reconcile job)
    }
    await PaymentModel.updateOne({ _id: t._id }, { $set: { lastQueriedAt: new Date() }, $push: { events: sanitizeEvent('stk-query', q) } });
    if (q.state === 'SUCCESS') return this.creditDeposit(t);
    if (q.state === 'FAILED') {
      const callbackSaidPaid = !!(await PaymentModel.exists({ _id: t._id, receipt: { $ne: null } }));
      // A success callback contradicted by the query is suspicious: hold for review instead of failing silently.
      return this.finish(t, ['PENDING', 'UNCERTAIN'], callbackSaidPaid ? 'UNCERTAIN' : 'FAILED', { resultCode: q.resultCode, resultDesc: q.resultDesc });
    }
    return t;
  }

  private async creditDeposit(t: PaymentDoc, by?: string) {
    // Claim the credit atomically: only one caller can flip credited=false -> true.
    const claimed = await PaymentModel.findOneAndUpdate({ _id: t._id, credited: false, status: { $in: ['PENDING', 'UNCERTAIN'] } }, { $set: { status: 'COMPLETED', credited: true, completedAt: new Date(), resultCode: '0', ...(by ? { reviewedBy: by, reviewedAt: new Date() } : {}) } }, { new: true });
    if (!claimed) return PaymentModel.findById(t._id);
    const ok = await portfolioService.applyCashFlow(claimed.user.toString(), usd(claimed.amountCents));
    if (!ok) {
      logger.fatal({ ref: claimed.reference }, 'Deposit marked credited but the balance update failed');
      await SystemEventModel.create({ type: 'PAYMENT_CREDIT_FAILED', level: 'fatal', component: 'mpesa', message: `Deposit ${claimed.reference} was confirmed but the balance update failed - credit it manually`, details: { id: claimed._id.toString() } }).catch(() => undefined);
    }
    this.publish(claimed);
    void notificationService.notify('PAYMENT', 'Deposit received', `Deposit ${claimed.reference}: $${usd(claimed.amountCents).toFixed(2)} (KES ${claimed.amountKes})`);
    void this.mailUser(claimed.user, 'Deposit received', `Your M-Pesa deposit of $${usd(claimed.amountCents).toFixed(2)} (KES ${claimed.amountKes}) was credited to your real account. Transaction ${claimed.reference}${claimed.receipt ? `, M-Pesa receipt ${claimed.receipt}` : ''}.`);
    return claimed;
  }

  /** Move a transaction from one of `from` to `to` (atomic); refund held payout funds on definite failure. */
  private async finish(t: PaymentDoc, from: PaymentStatus[], to: PaymentStatus, set: Record<string, unknown> = {}) {
    const u = await PaymentModel.findOneAndUpdate({ _id: t._id, status: { $in: from } }, { $set: { status: to, ...set, ...(to === 'COMPLETED' ? { completedAt: new Date() } : {}) } }, { new: true });
    if (!u) return PaymentModel.findById(t._id);
    if (u.type === 'PAYOUT' && (to === 'FAILED' || to === 'REJECTED' || to === 'CANCELLED')) await this.refund(u);
    if (to === 'UNCERTAIN') void notificationService.notify('PAYMENT_ATTENTION', `${u.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'} needs review`, `${u.reference}: ${String(set.resultDesc ?? 'no definite result from M-Pesa')}`);
    const fresh = (await PaymentModel.findById(u._id))!;
    this.publish(fresh);
    return fresh;
  }

  private async refund(t: PaymentDoc) {
    const claimed = await PaymentModel.findOneAndUpdate({ _id: t._id, held: true, refunded: false }, { $set: { refunded: true } }, { new: true });
    if (!claimed) return;
    const ok = await portfolioService.applyCashFlow(claimed.user.toString(), usd(claimed.amountCents));
    if (!ok) await SystemEventModel.create({ type: 'PAYMENT_REFUND_FAILED', level: 'fatal', component: 'mpesa', message: `Refund of ${claimed.reference} failed - refund it manually`, details: { id: claimed._id.toString() } }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- payouts

  async createPayout(userId: string, input: PayoutInput) {
    const existing = await PaymentModel.findOne({ user: userId, idempotencyKey: input.idempotencyKey });
    if (existing) return existing;
    const c = await this.config();
    if (!c.payoutsEnabled || !this.payoutsConfigured(c)) throw new AppError(409, 'Withdrawals are not available right now', 'PAYOUTS_DISABLED');
    const amountCents = cents(input.amountUsd);
    if (amountCents < c.minPayoutCents || amountCents > c.maxPayoutCents) throw new AppError(400, `Withdrawal must be between $${usd(c.minPayoutCents)} and $${usd(c.maxPayoutCents)}`, 'AMOUNT_OUT_OF_RANGE');
    const phone = normalizeKenyanPhone(input.phone);
    if (!phone) throw new AppError(400, 'Enter a valid Safaricom number, e.g. 0712 345 678', 'INVALID_PHONE');
    const q = this.payoutQuote(c, amountCents);
    if (q.netCents <= 0 || q.amountKes < 10) throw new AppError(400, 'Amount is too small after fees', 'AMOUNT_TOO_SMALL');

    const open = await PaymentModel.countDocuments({ user: userId, type: 'PAYOUT', status: { $in: OPEN_STATUSES } });
    if (open >= 3) throw new AppError(429, 'You already have withdrawals in progress', 'TOO_MANY_PENDING');
    const since = new Date(Date.now() - 86_400_000);
    const [{ total = 0 } = {}] = await PaymentModel.aggregate<{ total: number }>([
      { $match: { user: new Types.ObjectId(userId), type: 'PAYOUT', status: { $in: ['PENDING', 'PROCESSING', 'COMPLETED', 'UNCERTAIN'] }, createdAt: { $gt: since } } },
      { $group: { _id: null, total: { $sum: '$amountCents' } } },
    ]);
    if (total + amountCents > c.dailyPayoutLimitCents) throw new AppError(400, `Daily withdrawal limit is $${usd(c.dailyPayoutLimitCents)} (remaining $${usd(Math.max(0, c.dailyPayoutLimitCents - total)).toFixed(2)})`, 'DAILY_LIMIT');
    const knownDestination = !!(await PaymentModel.exists({ user: userId, type: 'DEPOSIT', status: 'COMPLETED', phone }));
    if (c.payoutsToDepositPhonesOnly && !knownDestination) throw new AppError(400, 'Withdrawals go to the M-Pesa number you deposited from. Make a deposit from this number first.', 'UNKNOWN_DESTINATION');

    const t = await PaymentModel.create({
      user: userId,
      reference: newReference(),
      type: 'PAYOUT',
      provider: c.environment === 'simulated' && !this.providerOverride ? 'simulated' : 'daraja',
      status: 'PENDING',
      idempotencyKey: input.idempotencyKey,
      amountCents,
      feeCents: q.feeCents,
      amountKes: q.amountKes,
      rate: c.payoutRate,
      phone,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      knownDestination,
    });
    // Hold the funds: an atomic conditional debit, so the same money cannot be withdrawn twice or traded.
    const held = await portfolioService.applyCashFlow(userId, -usd(amountCents), true);
    if (!held) {
      await PaymentModel.deleteOne({ _id: t._id });
      throw new AppError(400, 'Insufficient available balance (open trades are not withdrawable)', 'INSUFFICIENT_BALANCE');
    }
    t.held = true;
    await t.save();
    this.publish(t);
    if (c.autoApproveBelowCents > 0 && amountCents <= c.autoApproveBelowCents && knownDestination) return (await this.send(t._id.toString(), null)) ?? t;
    void notificationService.notify('PAYMENT', 'Withdrawal awaiting approval', `${t.reference}: $${usd(amountCents).toFixed(2)} to ${maskPhone(phone)}`);
    return t;
  }

  /** Send an approved payout through M-Pesa B2C. */
  async send(id: string, adminId: string | null) {
    const t = await PaymentModel.findOneAndUpdate({ _id: id, type: 'PAYOUT', status: 'PENDING', held: true }, { $set: { status: 'PROCESSING', reviewedAt: new Date(), ...(adminId ? { reviewedBy: adminId } : {}) } }, { new: true });
    if (!t) throw new AppError(409, 'Only pending withdrawals can be approved', 'INVALID_STATE');
    const c = await this.config();
    const urls = this.callbackUrls(c);
    const originatorConversationId = `AFX-${t.reference}-${crypto.randomBytes(3).toString('hex')}`;
    t.originatorConversationId = originatorConversationId;
    await t.save();
    try {
      const r = await this.provider(c).b2c({ amountKes: t.amountKes, phone: t.phone, originatorConversationId, resultUrl: urls.b2cResult, timeoutUrl: urls.b2cTimeout, remarks: `Withdrawal ${t.reference}` });
      await PaymentModel.updateOne({ _id: t._id }, { $set: { conversationId: r.conversationId }, $push: { events: sanitizeEvent('b2c-request', r) } });
    } catch (err) {
      const definite = err instanceof MpesaError ? err.definite : false;
      await this.event(t, 'b2c-error', { message: errorMessage(err), details: (err as MpesaError).details });
      return this.finish(t, ['PROCESSING'], definite ? 'FAILED' : 'UNCERTAIN', { resultDesc: definite ? `M-Pesa refused the payout: ${errorMessage(err)}` : `No definite answer from M-Pesa: ${errorMessage(err)}` });
    }
    const fresh = (await PaymentModel.findById(t._id))!;
    this.publish(fresh);
    return fresh;
  }

  async handleB2cResult(body: unknown) {
    const r = (body as { Result?: Record<string, unknown> })?.Result;
    if (!r?.OriginatorConversationID && !r?.ConversationID) return { ok: false, reason: 'malformed' };
    const t = await PaymentModel.findOne({ type: 'PAYOUT', $or: [{ originatorConversationId: String(r.OriginatorConversationID ?? '') }, ...(r.ConversationID ? [{ conversationId: String(r.ConversationID) }] : [])] });
    if (!t) {
      await SystemEventModel.create({ type: 'PAYMENT_ORPHAN_CALLBACK', level: 'warn', component: 'mpesa', message: 'B2C result for an unknown request', details: sanitizeEvent('b2c-result', r) }).catch(() => undefined);
      return { ok: false, reason: 'unknown' };
    }
    await this.event(t, 'b2c-result', r);
    const code = String(r.ResultCode);
    if (code === '0') {
      const receipt = r.TransactionID ? String(r.TransactionID) : undefined;
      const done = await this.finish(t, ['PROCESSING', 'UNCERTAIN'], 'COMPLETED', { resultCode: code, resultDesc: String(r.ResultDesc ?? ''), ...(receipt ? { receipt } : {}) });
      if (done?.status === 'COMPLETED') void this.mailUser(done.user, 'Withdrawal sent', `KES ${done.amountKes} was sent to your M-Pesa number ${maskPhone(done.phone)}. Transaction ${done.reference}${receipt ? `, M-Pesa receipt ${receipt}` : ''}.`);
    } else {
      const failed = await this.finish(t, ['PROCESSING', 'UNCERTAIN'], 'FAILED', { resultCode: code, resultDesc: String(r.ResultDesc ?? '') });
      if (failed?.status === 'FAILED') void this.mailUser(failed.user, 'Withdrawal failed', `Your withdrawal ${failed.reference} could not be completed (${String(r.ResultDesc ?? 'M-Pesa error')}). The amount was returned to your account.`);
    }
    return { ok: true };
  }

  async handleB2cTimeout(body: unknown) {
    const r = (body as { Result?: Record<string, unknown> })?.Result ?? (body as Record<string, unknown>);
    const t = await PaymentModel.findOne({ type: 'PAYOUT', originatorConversationId: String(r?.OriginatorConversationID ?? '') });
    if (!t) return { ok: false, reason: 'unknown' };
    await this.event(t, 'b2c-timeout', r);
    await this.finish(t, ['PROCESSING'], 'UNCERTAIN', { resultDesc: 'M-Pesa queue timeout - check the M-Pesa statement before resolving' });
    return { ok: true };
  }

  async cancelPayout(userId: string, id: string) {
    const t = await PaymentModel.findOne({ _id: id, user: userId, type: 'PAYOUT' });
    if (!t) throw new AppError(404, 'Withdrawal not found');
    if (t.status !== 'PENDING') throw new AppError(409, 'This withdrawal is already being processed', 'INVALID_STATE');
    return this.finish(t, ['PENDING'], 'CANCELLED', { resultDesc: 'Cancelled by you' });
  }

  async reject(adminId: string, id: string, note: string) {
    const t = await PaymentModel.findOne({ _id: id, type: 'PAYOUT' });
    if (!t) throw new AppError(404, 'Withdrawal not found');
    if (t.status !== 'PENDING') throw new AppError(409, 'Only pending withdrawals can be rejected', 'INVALID_STATE');
    const r = await this.finish(t, ['PENDING'], 'REJECTED', { reviewedBy: adminId, reviewedAt: new Date(), reviewNote: note, resultDesc: note });
    void this.mailUser(t.user, 'Withdrawal declined', `Your withdrawal ${t.reference} was declined${note ? `: ${note}` : ''}. The amount was returned to your account.`);
    return r;
  }

  /**
   * Admin resolution of an UNCERTAIN transaction after checking the M-Pesa statement/portal.
   * COMPLETED credits a deposit (once) or finalises a payout; FAILED fails a deposit or refunds a payout.
   */
  async resolve(adminId: string, id: string, outcome: 'COMPLETED' | 'FAILED', note: string, receipt?: string) {
    const t = await PaymentModel.findById(id);
    if (!t) throw new AppError(404, 'Transaction not found');
    if (t.status !== 'UNCERTAIN') throw new AppError(409, 'Only transactions under review can be resolved', 'INVALID_STATE');
    if (receipt) {
      if (await PaymentModel.exists({ receipt, _id: { $ne: t._id } })) throw new AppError(409, 'That M-Pesa receipt is already linked to another transaction', 'DUPLICATE_RECEIPT');
      await PaymentModel.updateOne({ _id: t._id }, { $set: { receipt } });
    }
    await PaymentModel.updateOne({ _id: t._id }, { $set: { reviewNote: note, reviewedBy: adminId, reviewedAt: new Date() } });
    if (t.type === 'DEPOSIT') return outcome === 'COMPLETED' ? this.creditDeposit(t, adminId) : this.finish(t, ['UNCERTAIN'], 'FAILED', { resultDesc: note || 'Not received' });
    return this.finish(t, ['UNCERTAIN'], outcome, { resultDesc: note });
  }

  /**
   * Job: confirm deposits whose callback never came (STK Push Query) and flag payouts with no
   * result. Runs every minute; each pending deposit is queried at most once a minute.
   */
  async reconcilePending() {
    const now = Date.now();
    const deposits = await PaymentModel.find({ type: 'DEPOSIT', status: 'PENDING', checkoutRequestId: { $ne: null }, createdAt: { $lt: new Date(now - 60_000) }, $or: [{ lastQueriedAt: null }, { lastQueriedAt: { $lt: new Date(now - 55_000) } }] }).limit(25);
    for (const d of deposits) {
      const r = await this.confirmDeposit(d._id.toString()).catch((err) => (logger.warn({ err: errorMessage(err) }, 'Deposit reconcile failed'), null));
      if (r?.status === 'PENDING' && now - d.createdAt.getTime() > 30 * 60_000) await this.finish(d, ['PENDING'], 'UNCERTAIN', { resultDesc: 'No confirmation from M-Pesa after 30 minutes' });
    }
    const stuck = await PaymentModel.find({ type: 'PAYOUT', status: 'PROCESSING', updatedAt: { $lt: new Date(now - 30 * 60_000) } }).limit(25);
    for (const p of stuck) await this.finish(p, ['PROCESSING'], 'UNCERTAIN', { resultDesc: 'No result from M-Pesa after 30 minutes - check the M-Pesa statement' });
    return { deposits: deposits.length, stuckPayouts: stuck.length };
  }

  /** Admin dashboard figures (USD). */
  async stats() {
    const since = new Date(Date.now() - 86_400_000);
    const agg = await PaymentModel.aggregate<{ _id: { type: string; status: string }; n: number; cents: number }>([{ $match: { createdAt: { $gt: since } } }, { $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 }, cents: { $sum: '$amountCents' } } }]);
    const pick = (type: string, status: string) => agg.find((a) => a._id.type === type && a._id.status === status) ?? { n: 0, cents: 0 };
    const [pendingPayouts, review] = await Promise.all([PaymentModel.countDocuments({ type: 'PAYOUT', status: 'PENDING' }), PaymentModel.countDocuments({ status: 'UNCERTAIN' })]);
    return {
      pendingPayouts,
      needsReview: review,
      deposits24h: { count: pick('DEPOSIT', 'COMPLETED').n, amount: usd(pick('DEPOSIT', 'COMPLETED').cents) },
      payouts24h: { count: pick('PAYOUT', 'COMPLETED').n, amount: usd(pick('PAYOUT', 'COMPLETED').cents) },
      failed24h: agg.filter((a) => a._id.status === 'FAILED').reduce((s, a) => s + a.n, 0),
    };
  }
}

export const paymentService = new PaymentService();
