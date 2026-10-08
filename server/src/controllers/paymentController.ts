import type { Request, Response } from 'express';
import { z } from 'zod';
import { PaymentModel, PAYMENT_STATUSES } from '../models/PaymentTransaction';
import { paymentService } from '../payments/PaymentService';
import { AuthService } from '../services/AuthService';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

const money = z.number().positive().max(1_000_000).refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'At most 2 decimal places');
const name = z.string().trim().min(1).max(60).regex(/^[\p{L} .'-]+$/u, 'Letters only');

export const paymentSchemas = {
  deposit: z.object({ amount: money, phone: z.string().min(9).max(16), idempotencyKey: z.string().min(8).max(100) }),
  payout: z.object({
    amount: money,
    phone: z.string().min(9).max(16),
    firstName: name,
    lastName: name,
    idempotencyKey: z.string().min(8).max(100),
    totp: z.string().max(10).optional(),
    emailCode: z.string().max(10).optional(),
  }),
  config: z
    .object({
      depositsEnabled: z.boolean(),
      payoutsEnabled: z.boolean(),
      realTradingEnabled: z.boolean(),
      environment: z.enum(['sandbox', 'production', 'simulated']),
      consumerKey: z.string().max(200),
      consumerSecret: z.string().max(200),
      passkey: z.string().max(500),
      securityCredential: z.string().max(2000),
      clearSecrets: z.array(z.enum(['consumerKey', 'consumerSecret', 'passkey', 'securityCredential'])),
      rotateCallbackToken: z.boolean(),
      shortcode: z.string().regex(/^\d{0,10}$/),
      transactionType: z.enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline']),
      partyB: z.string().regex(/^\d{0,10}$/),
      accountReference: z.string().max(12),
      b2cShortcode: z.string().regex(/^\d{0,10}$/),
      initiatorName: z.string().max(60),
      b2cCommandId: z.enum(['BusinessPayment', 'SalaryPayment', 'PromotionPayment']),
      callbackIps: z.array(z.string().regex(/^[0-9a-fA-F:.]{3,45}$/)).max(50),
      depositRate: z.number().positive().max(100_000),
      payoutRate: z.number().positive().max(100_000),
      minDepositUsd: z.number().min(1).max(1_000_000),
      maxDepositUsd: z.number().min(1).max(1_000_000),
      minPayoutUsd: z.number().min(1).max(1_000_000),
      maxPayoutUsd: z.number().min(1).max(1_000_000),
      dailyPayoutLimitUsd: z.number().min(1).max(10_000_000),
      payoutFeePct: z.number().min(0).max(0.2),
      payoutFeeFixedUsd: z.number().min(0).max(1_000),
      autoApproveBelowUsd: z.number().min(0).max(1_000_000),
      payoutsToDepositPhonesOnly: z.boolean(),
      totp: z.string().optional(),
      emailCode: z.string().optional(),
    })
    .partial(),
  reject: z.object({ note: z.string().trim().min(3).max(300), totp: z.string().optional(), emailCode: z.string().optional() }),
  resolve: z.object({ outcome: z.enum(['COMPLETED', 'FAILED']), note: z.string().trim().min(3).max(300), receipt: z.string().trim().regex(/^[A-Z0-9]{6,20}$/).optional(), totp: z.string().optional(), emailCode: z.string().optional() }),
};

const me = (req: Request) => req.user!.id;

/** Trader-facing payments: their own deposits and withdrawals only. */
export const paymentController = {
  async config(_req: Request, res: Response) {
    res.json(await paymentService.publicConfig());
  },

  async list(req: Request, res: Response) {
    const q: Record<string, unknown> = { user: me(req) };
    if (req.query.type === 'DEPOSIT' || req.query.type === 'PAYOUT') q.type = req.query.type;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const docs = await PaymentModel.find(q).sort({ createdAt: -1 }).limit(limit);
    res.json({ payments: docs.map((d) => paymentService.view(d)) });
  },

  async get(req: Request, res: Response) {
    const t = await PaymentModel.findOne({ _id: req.params.id, user: me(req) });
    if (!t) throw new AppError(404, 'Transaction not found');
    res.json({ payment: paymentService.view(t) });
  },

  async deposit(req: Request, res: Response) {
    const b = req.body as z.infer<typeof paymentSchemas.deposit>;
    const t = await paymentService.createDeposit(me(req), { amountUsd: b.amount, phone: b.phone, idempotencyKey: b.idempotencyKey });
    await audit(req, { action: 'DEPOSIT_REQUESTED', resourceId: t._id.toString(), details: { amount: b.amount, reference: t.reference, status: t.status } });
    res.status(201).json({ payment: paymentService.view(t) });
  },

  async payout(req: Request, res: Response) {
    const b = req.body as z.infer<typeof paymentSchemas.payout>;
    if (!(await AuthService.verifyMoneyMovement(me(req), { totp: b.totp, emailCode: b.emailCode }))) {
      await audit(req, { action: 'PAYOUT_CONFIRMATION_FAILED', success: false });
      throw new AppError(401, 'Enter the confirmation code to withdraw', 'INVALID_2FA');
    }
    const t = await paymentService.createPayout(me(req), { amountUsd: b.amount, phone: b.phone, firstName: b.firstName, lastName: b.lastName, idempotencyKey: b.idempotencyKey });
    await audit(req, { action: 'PAYOUT_REQUESTED', resourceId: t._id.toString(), details: { amount: b.amount, reference: t.reference, status: t.status } });
    res.status(201).json({ payment: paymentService.view(t) });
  },

  async cancel(req: Request, res: Response) {
    const t = await paymentService.cancelPayout(me(req), String(req.params.id));
    await audit(req, { action: 'PAYOUT_CANCELLED', resourceId: String(req.params.id) });
    res.json({ payment: t && paymentService.view(t) });
  },
};

/** Admin payments console. Mutations that move money or change credentials are protected actions. */
export const adminPaymentController = {
  async getConfig(_req: Request, res: Response) {
    res.json(await paymentService.adminConfig());
  },

  async updateConfig(req: Request, res: Response) {
    const { totp: _t, emailCode: _e, ...body } = req.body as Record<string, unknown>;
    const cfg = await paymentService.updateConfig(body, req.user!.id);
    const changed = Object.keys(body).map((k) => (/(key|secret|passkey|credential)/i.test(k) ? `${k} (changed)` : k));
    await audit(req, { action: 'PAYMENT_CONFIG_UPDATED', details: { fields: changed, depositsEnabled: cfg.depositsEnabled, payoutsEnabled: cfg.payoutsEnabled, realTradingEnabled: cfg.realTradingEnabled, environment: cfg.environment } });
    res.json(cfg);
  },

  async test(req: Request, res: Response) {
    const r = await paymentService.testConnection();
    await audit(req, { action: 'PAYMENT_CONNECTION_TEST', success: r.ok });
    res.json(r);
  },

  async stats(_req: Request, res: Response) {
    res.json(await paymentService.stats());
  },

  async list(req: Request, res: Response) {
    const q: Record<string, unknown> = {};
    if (req.query.type === 'DEPOSIT' || req.query.type === 'PAYOUT') q.type = req.query.type;
    if (typeof req.query.status === 'string' && (PAYMENT_STATUSES as readonly string[]).includes(req.query.status)) q.status = req.query.status;
    if (typeof req.query.q === 'string' && /^[\w-]{3,40}$/.test(req.query.q)) q.$or = [{ reference: req.query.q }, { receipt: req.query.q.toUpperCase() }, { phone: { $regex: `${req.query.q}$` } }];
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const docs = await PaymentModel.find(q).sort({ createdAt: -1 }).limit(limit).populate('user', 'email name');
    res.json({ payments: docs.map((d) => paymentService.adminView(d as never)) });
  },

  async approve(req: Request, res: Response) {
    const t = await paymentService.send(String(req.params.id), req.user!.id);
    await audit(req, { action: 'PAYOUT_APPROVED', resourceId: String(req.params.id), details: { reference: t?.reference, status: t?.status } });
    res.json({ payment: t && paymentService.adminView(t as never) });
  },

  async reject(req: Request, res: Response) {
    const t = await paymentService.reject(req.user!.id, String(req.params.id), req.body.note);
    await audit(req, { action: 'PAYOUT_REJECTED', resourceId: String(req.params.id), details: { reference: t?.reference, note: req.body.note } });
    res.json({ payment: t && paymentService.adminView(t as never) });
  },

  async resolve(req: Request, res: Response) {
    const b = req.body as z.infer<typeof paymentSchemas.resolve>;
    const t = await paymentService.resolve(req.user!.id, String(req.params.id), b.outcome, b.note, b.receipt);
    await audit(req, { action: 'PAYMENT_RESOLVED', resourceId: String(req.params.id), details: { reference: t?.reference, outcome: b.outcome, receipt: b.receipt, note: b.note } });
    res.json({ payment: t && paymentService.adminView(t as never) });
  },

  async requery(req: Request, res: Response) {
    const t = await paymentService.confirmDeposit(String(req.params.id));
    if (!t) throw new AppError(404, 'Transaction not found');
    res.json({ payment: paymentService.adminView(t as never) });
  },
};

/**
 * Daraja callbacks (public). Always answer quickly with the format Daraja expects; the secret
 * path token (and optional IP allow-list) is checked first, and nothing is trusted beyond that.
 */
export const mpesaCallbackController = {
  stk: callback((b) => paymentService.handleStkCallback(b)),
  b2cResult: callback((b) => paymentService.handleB2cResult(b)),
  b2cTimeout: callback((b) => paymentService.handleB2cTimeout(b)),
};

function callback(handle: (body: unknown) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    if (!(await paymentService.verifyCallback(String(req.params.token), req.ip))) {
      logger.warn({ ip: req.ip, path: req.path.replace(/\/[^/]+$/, '/***') }, 'Rejected M-Pesa callback');
      return res.status(403).json({ ResultCode: 1, ResultDesc: 'Rejected' });
    }
    await handle(req.body);
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  };
}
