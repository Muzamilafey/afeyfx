import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { User } from '../models/User';
import { PortfolioModel } from '../models/Portfolio';
import { PositionModel } from '../models/Position';
import { TradeModel } from '../models/Trade';
import { PaymentModel } from '../models/PaymentTransaction';
import { BrokerConnectionModel } from '../models/BrokerConnection';
import { portfolioService } from '../portfolio/PortfolioService';
import { paymentService } from '../payments/PaymentService';
import { brokerConnections } from '../brokers/services/BrokerConnectionService';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';
import { z } from 'zod';
import { RefreshToken } from '../models/RefreshToken';
import { AuthService, validatePasswordStrength } from '../services/AuthService';
import { accountBlock, accountStatus } from '../services/AccountStatus';
import { notifyAccountEvent } from '../services/AccountNotices';
import { disconnectUser } from '../websocket/socket';

const reason = z.string().trim().min(3, 'Give a reason (shown to the user where appropriate)').max(500);
export const adminTraderSchemas = {
  suspend: z.object({ days: z.number().int().min(1).max(365), reason }),
  reason: z.object({ reason }),
  remove: z.object({ reason, confirm: z.literal('DELETE'), totp: z.string().optional(), emailCode: z.string().optional() }),
  restore: z.object({ totp: z.string().optional(), emailCode: z.string().optional() }),
  resetPassword: z.object({ password: z.string().min(12).max(200), totp: z.string().optional(), emailCode: z.string().optional() }),
};

type Status = 'active' | 'suspended' | 'disabled' | 'deleted';
const statusOf = (u: { active?: boolean | null; suspendedUntil?: Date | null; deletedAt?: Date | null }): Status => {
  const b = accountBlock(u);
  return !b ? 'active' : b.code === 'ACCOUNT_SUSPENDED' ? 'suspended' : b.code === 'ACCOUNT_DISABLED' ? 'disabled' : 'deleted';
};

/** Load the target account; administrators can never moderate themselves. */
async function target(req: Request) {
  const id = String(req.params.id);
  if (!/^[0-9a-f]{24}$/.test(id)) throw new AppError(404, 'Trader not found');
  if (id === req.user!.id) throw new AppError(400, 'You cannot do this to your own account', 'SELF_ACTION');
  const u = await User.findById(id).select('+passwordHash');
  if (!u) throw new AppError(404, 'Trader not found');
  return u;
}

/** End every session of the user right away (refresh tokens, cached status, live sockets). */
async function endSessions(userId: string) {
  await RefreshToken.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  accountStatus.invalidate(userId);
  disconnectUser(userId);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Read-only view of traders for administrators: accounts, positions, trades, payments and broker
 * connections. Nothing here can trade, move money or change a trader's account. Secrets never
 * leave the server (broker views are masked; payment views are the admin views already used by the
 * payments queue).
 */
export const adminTraderController = {
  async list(req: Request, res: Response) {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const filter: Record<string, unknown> = { role: { $in: ['trader', 'admin'] } };
    const st = String(req.query.status ?? '');
    if (st === 'deleted') filter.deletedAt = { $ne: null };
    else if (st !== 'all') filter.deletedAt = null;
    if (q) filter.$or = [{ email: new RegExp(escapeRe(q), 'i') }, { name: new RegExp(escapeRe(q), 'i') }];
    const users = await User.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    const ids = users.map((u) => u._id);
    const [portfolios, openCounts, tradeStats, deposits] = await Promise.all([
      PortfolioModel.find({ owner: { $in: ids }, mode: { $in: ['PAPER', 'REAL'] } }).lean(),
      PositionModel.aggregate<{ _id: { user: Types.ObjectId; mode: string }; n: number }>([{ $match: { user: { $in: ids }, status: 'OPEN' } }, { $group: { _id: { user: '$user', mode: '$mode' }, n: { $sum: 1 } } }]),
      TradeModel.aggregate<{ _id: { user: Types.ObjectId; mode: string }; n: number; pnl: number; wins: number; last: Date }>([
        { $match: { user: { $in: ids } } },
        { $group: { _id: { user: '$user', mode: '$mode' }, n: { $sum: 1 }, pnl: { $sum: '$netPnl' }, wins: { $sum: { $cond: [{ $gt: ['$netPnl', 0] }, 1, 0] } }, last: { $max: '$closedAt' } } },
      ]),
      PaymentModel.aggregate<{ _id: { user: Types.ObjectId; type: string }; cents: number }>([{ $match: { user: { $in: ids }, status: 'COMPLETED' } }, { $group: { _id: { user: '$user', type: '$type' }, cents: { $sum: '$amountCents' } } }]),
    ]);
    const key = (u: unknown, m: string) => `${String(u)}:${m}`;
    const pf = new Map(portfolios.map((p) => [key(p.owner, p.mode), p]));
    const open = new Map(openCounts.map((o) => [key(o._id.user, o._id.mode), o.n]));
    const ts = new Map(tradeStats.map((t) => [key(t._id.user, t._id.mode), t]));
    const pay = new Map(deposits.map((d) => [key(d._id.user, d._id.type), d.cents / 100]));
    const acct = (id: unknown, mode: 'PAPER' | 'REAL') => {
      const p = pf.get(key(id, mode));
      const t = ts.get(key(id, mode));
      return {
        exists: !!p,
        balance: p ? round2(p.balance) : 0,
        equity: p ? round2(p.equity) : 0,
        openPositions: open.get(key(id, mode)) ?? 0,
        trades: t?.n ?? 0,
        netPnl: round2(t?.pnl ?? 0),
        winRate: t?.n ? t.wins / t.n : null,
        lastTradeAt: t?.last ?? null,
      };
    };
    res.json({
      traders: users.map((u) => ({
        id: u._id.toString(),
        email: u.email,
        name: u.name,
        role: u.role,
        active: u.active !== false,
        status: statusOf(u),
        suspendedUntil: u.suspendedUntil ?? null,
        statusReason: u.statusReason ?? null,
        deletedAt: u.deletedAt ?? null,
        emailVerified: !!u.emailVerified,
        twoFactorEnabled: !!u.twoFactorEnabled,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt ?? null,
        demo: acct(u._id, 'PAPER'),
        real: { ...acct(u._id, 'REAL'), deposited: round2(pay.get(key(u._id, 'DEPOSIT')) ?? 0), withdrawn: round2(pay.get(key(u._id, 'PAYOUT')) ?? 0) },
      })),
    });
  },

  async get(req: Request, res: Response) {
    const id = String(req.params.id);
    if (!/^[0-9a-f]{24}$/.test(id)) throw new AppError(404, 'Trader not found');
    const u = await User.findById(id);
    if (!u) throw new AppError(404, 'Trader not found');
    const account = async (mode: 'PAPER' | 'REAL') => {
      const exists = await PortfolioModel.exists({ mode, owner: u._id });
      return exists ? portfolioService.view(await portfolioService.revalue(mode, id)) : null;
    };
    const [demo, real, openPositions, trades, payments, conns] = await Promise.all([
      account('PAPER'),
      account('REAL'),
      PositionModel.find({ user: u._id, status: 'OPEN' }).sort({ openedAt: -1 }).limit(200).lean(),
      TradeModel.find({ user: u._id }).sort({ closedAt: -1 }).limit(100).lean(),
      PaymentModel.find({ user: u._id }).sort({ createdAt: -1 }).limit(100),
      BrokerConnectionModel.find({ user: u._id }).sort({ createdAt: 1 }),
    ]);
    await audit(req, { action: 'ADMIN_VIEWED_TRADER', resource: 'user', resourceId: id });
    res.json({
      user: { ...u.toJSON(), status: statusOf(u) },
      accounts: { DEMO: demo, REAL: real },
      openPositions,
      trades,
      payments: payments.map((p) => paymentService.adminView(p as never)),
      brokerConnections: conns.map((c) => brokerConnections.view(c)),
    });
  },

  // ------------------------------------------------------------------ account management

  /** Temporarily block sign-in and all activity until a date. Open positions stay open. */
  async suspend(req: Request, res: Response) {
    const u = await target(req);
    if (u.deletedAt) throw new AppError(409, 'This account is deleted', 'ACCOUNT_DELETED');
    const b = req.body as z.infer<typeof adminTraderSchemas.suspend>;
    u.suspendedUntil = new Date(Date.now() + b.days * 86_400_000);
    u.set({ statusReason: b.reason, statusChangedAt: new Date(), statusChangedBy: req.user!.id });
    await u.save();
    await endSessions(u._id.toString());
    await audit(req, { action: 'TRADER_SUSPENDED', resource: 'user', resourceId: u._id.toString(), details: { days: b.days, until: u.suspendedUntil, reason: b.reason } });
    void notifyAccountEvent(u, 'Account suspended', `Your AfeyFX account is suspended until ${u.suspendedUntil.toISOString().slice(0, 16).replace('T', ' ')} UTC. Reason: ${b.reason}`);
    res.json({ user: { ...u.toJSON(), status: statusOf(u) } });
  },

  async unsuspend(req: Request, res: Response) {
    const u = await target(req);
    u.set({ suspendedUntil: undefined, statusReason: undefined, statusChangedAt: new Date(), statusChangedBy: req.user!.id });
    await u.save();
    accountStatus.invalidate(u._id.toString());
    await audit(req, { action: 'TRADER_UNSUSPENDED', resource: 'user', resourceId: u._id.toString() });
    res.json({ user: { ...u.toJSON(), status: statusOf(u) } });
  },

  /** Block the account indefinitely (until an administrator enables it again). */
  async disable(req: Request, res: Response) {
    const u = await target(req);
    if (u.deletedAt) throw new AppError(409, 'This account is deleted', 'ACCOUNT_DELETED');
    const b = req.body as z.infer<typeof adminTraderSchemas.reason>;
    u.set({ active: false, statusReason: b.reason, statusChangedAt: new Date(), statusChangedBy: req.user!.id });
    await u.save();
    await endSessions(u._id.toString());
    await audit(req, { action: 'TRADER_DISABLED', resource: 'user', resourceId: u._id.toString(), details: { reason: b.reason } });
    void notifyAccountEvent(u, 'Account disabled', `Your AfeyFX account has been disabled. Reason: ${b.reason}`);
    res.json({ user: { ...u.toJSON(), status: statusOf(u) } });
  },

  async enable(req: Request, res: Response) {
    const u = await target(req);
    if (u.deletedAt) throw new AppError(409, 'Restore the deleted account instead', 'ACCOUNT_DELETED');
    u.set({ active: true, statusReason: undefined, statusChangedAt: new Date(), statusChangedBy: req.user!.id });
    await u.save();
    accountStatus.invalidate(u._id.toString());
    await audit(req, { action: 'TRADER_ENABLED', resource: 'user', resourceId: u._id.toString() });
    res.json({ user: { ...u.toJSON(), status: statusOf(u) } });
  },

  /**
   * Soft delete: the account can no longer be used, but every trade, payment and audit record is
   * kept. Refused while money or positions are still open, so nothing is left in limbo.
   */
  async remove(req: Request, res: Response) {
    const u = await target(req);
    if (u.deletedAt) return res.json({ user: { ...u.toJSON(), status: statusOf(u) } });
    const b = req.body as z.infer<typeof adminTraderSchemas.remove>;
    const [open, pendingPayments, real] = await Promise.all([
      PositionModel.countDocuments({ user: u._id, status: 'OPEN' }),
      PaymentModel.countDocuments({ user: u._id, status: { $in: ['PENDING', 'PROCESSING', 'UNCERTAIN'] } }),
      PortfolioModel.findOne({ mode: 'REAL', owner: u._id }).lean(),
    ]);
    const blockers: string[] = [];
    if (open) blockers.push(`${open} open position(s)`);
    if (pendingPayments) blockers.push(`${pendingPayments} unfinished payment(s)`);
    if (real && real.balance > 0.01) blockers.push(`a real-money balance of $${real.balance.toFixed(2)} (pay it out first)`);
    if (blockers.length) throw new AppError(409, `Cannot delete this account yet: ${blockers.join(', ')}.`, 'ACCOUNT_HAS_FUNDS');
    u.set({ deletedAt: new Date(), active: false, statusReason: b.reason, statusChangedAt: new Date(), statusChangedBy: req.user!.id });
    await u.save();
    await BrokerConnectionModel.updateMany({ user: u._id }, { $set: { tradingEnabled: false, liveEnabled: false } });
    await endSessions(u._id.toString());
    await audit(req, { action: 'TRADER_DELETED', resource: 'user', resourceId: u._id.toString(), details: { reason: b.reason, email: u.email } });
    return res.json({ user: { ...u.toJSON(), status: statusOf(u) } });
  },

  async restore(req: Request, res: Response) {
    const u = await target(req);
    if (!u.deletedAt) return res.json({ user: { ...u.toJSON(), status: statusOf(u) } });
    u.set({ deletedAt: undefined, active: true, suspendedUntil: undefined, statusReason: undefined, statusChangedAt: new Date(), statusChangedBy: req.user!.id });
    await u.save();
    accountStatus.invalidate(u._id.toString());
    await audit(req, { action: 'TRADER_RESTORED', resource: 'user', resourceId: u._id.toString() });
    return res.json({ user: { ...u.toJSON(), status: statusOf(u) } });
  },

  /**
   * Set a new temporary password (e.g. the user forgot theirs). All sessions end, failed-login
   * locks are cleared, and the user is asked to choose their own password after signing in.
   * The password is never stored or logged in plain text and is not returned.
   */
  async resetPassword(req: Request, res: Response) {
    const u = await target(req);
    if (u.deletedAt) throw new AppError(409, 'This account is deleted', 'ACCOUNT_DELETED');
    const b = req.body as z.infer<typeof adminTraderSchemas.resetPassword>;
    validatePasswordStrength(b.password);
    u.passwordHash = await AuthService.hashPassword(b.password);
    u.set({ passwordSet: true, mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: undefined });
    await u.save();
    await endSessions(u._id.toString());
    await audit(req, { action: 'TRADER_PASSWORD_RESET', resource: 'user', resourceId: u._id.toString() });
    void notifyAccountEvent(u, 'Password reset by an administrator', 'An administrator set a temporary password for your AfeyFX account. Sign in with it and choose a new password under Account.');
    res.json({ ok: true, user: { ...u.toJSON(), status: statusOf(u) } });
  },
};
