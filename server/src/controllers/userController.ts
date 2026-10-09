import { accountStatus } from '../services/AccountStatus';
import { disconnectUser } from '../websocket/socket';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { User } from '../models/User';
import { RefreshToken } from '../models/RefreshToken';
import { AuthService } from '../services/AuthService';
import { EmailTokenService } from '../services/EmailTokenService';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';

export const userSchemas = {
  create: z.object({ email: z.string().email(), name: z.string().min(1).max(100), password: z.string().min(12).max(200), role: z.enum(['admin', 'trader', 'viewer']).default('viewer') }),
  verifyEmail: z.object({ verified: z.boolean() }),
  verifySelf: z.object({ password: z.string().max(200).optional() }),
  update: z.object({ role: z.enum(['admin', 'trader', 'viewer']).optional(), active: z.boolean().optional(), name: z.string().min(1).max(100).optional(), emailVerified: z.boolean().optional() }),
};

export const userController = {
  async list(_req: Request, res: Response) {
    res.json({ users: (await User.find().sort({ createdAt: 1 })).map((u) => u.toJSON()) });
  },
  async create(req: Request, res: Response) {
    const u = await AuthService.register(req.body.email, req.body.name, req.body.password, req.body.role);
    if (u.role !== req.body.role) {
      u.role = req.body.role;
      await u.save();
    }
    await audit(req, { action: 'USER_CREATED', resource: 'user', resourceId: u._id.toString(), details: { role: u.role } });
    res.status(201).json({ user: u.toJSON() });
  },
  async resendVerification(req: Request, res: Response) {
    const u = await User.findById(req.params.id);
    if (!u) throw new AppError(404, 'User not found');
    if (u.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    await EmailTokenService.sendVerification(u);
    await audit(req, { action: 'VERIFICATION_RESENT', resource: 'user', resourceId: u._id.toString() });
    return res.json({ ok: true });
  },
  /** Admin marks another user's email as verified (or not) without an email round-trip. */
  async verifyEmail(req: Request, res: Response) {
    const verified = (req.body as { verified: boolean }).verified;
    if (req.params.id === req.user!.id && !verified) throw new AppError(400, 'You cannot un-verify your own email');
    const u = await User.findById(req.params.id);
    if (!u) throw new AppError(404, 'User not found');
    u.emailVerified = verified;
    if (verified) u.emailVerifiedAt = new Date();
    else u.emailOtpEnabled = false; // email codes need a verified inbox
    await u.save();
    // Removing verification ends that user's sessions; granting it does not need to.
    if (!verified) await RefreshToken.updateMany({ user: u._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit(req, { action: verified ? 'EMAIL_VERIFIED_BY_ADMIN' : 'EMAIL_UNVERIFIED_BY_ADMIN', resource: 'user', resourceId: u._id.toString(), details: { email: u.email } });
    res.json({ user: u.toJSON() });
  },

  /**
   * An admin verifies their OWN email (e.g. before SMTP is configured). Only needs the admin role
   * (not a verified email - that is what this grants), plus the account password as proof that the
   * person at the keyboard owns the account.
   */
  async verifySelf(req: Request, res: Response) {
    const u = await User.findById(req.user!.id);
    if (!u) throw new AppError(404, 'User not found');
    if (u.emailVerified) return res.json({ user: u.toJSON(), alreadyVerified: true });
    if (u.passwordSet && !(await AuthService.verifyPassword(u._id.toString(), (req.body as { password?: string }).password ?? ''))) {
      await audit(req, { action: 'EMAIL_SELF_VERIFY_FAILED', resource: 'user', resourceId: u._id.toString(), success: false });
      throw new AppError(401, 'Password is incorrect', 'INVALID_CREDENTIALS');
    }
    u.emailVerified = true;
    u.emailVerifiedAt = new Date();
    await u.save();
    await audit(req, { action: 'EMAIL_SELF_VERIFIED_BY_ADMIN', resource: 'user', resourceId: u._id.toString(), details: { email: u.email } });
    return res.json({ user: u.toJSON() });
  },

  async update(req: Request, res: Response) {
    if (req.params.id === req.user!.id && (req.body.role || req.body.active === false)) throw new AppError(400, 'You cannot change your own role or deactivate yourself');
    const set: Record<string, unknown> = { ...req.body };
    if (req.body.emailVerified === true) set.emailVerifiedAt = new Date();
    if (req.body.emailVerified === false) set.emailOtpEnabled = false; // email codes need a verified inbox
    const u = await User.findByIdAndUpdate(req.params.id, { $set: set }, { returnDocument: 'after' });
    if (!u) throw new AppError(404, 'User not found');
    if (req.body.active === false || req.body.role || req.body.emailVerified === false) await RefreshToken.updateMany({ user: u._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    accountStatus.invalidate(u._id.toString());
    if (req.body.active === false) disconnectUser(u._id.toString());
    await audit(req, { action: 'USER_UPDATED', resource: 'user', resourceId: u._id.toString(), details: req.body });
    res.json({ user: u.toJSON() });
  },
};
