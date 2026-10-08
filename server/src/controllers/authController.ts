import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { User } from '../models/User';
import { AuthService } from '../services/AuthService';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';
import QRCode from 'qrcode';

const REFRESH_COOKIE = 'afx_rt';
const cookieOpts = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict' as const,
  path: '/api/auth',
  maxAge: env.JWT_REFRESH_TTL_DAYS * 86_400_000,
});

export const schemas = {
  register: z.object({ email: z.string().email().max(200), name: z.string().min(1).max(100), password: z.string().min(12).max(200) }),
  login: z.object({ email: z.string().email(), password: z.string().min(1).max(200) }),
  verify2fa: z.object({ challengeToken: z.string().min(10), code: z.string().regex(/^\d{6}$/) }),
  code: z.object({ code: z.string().regex(/^\d{6}$/) }),
  disable2fa: z.object({ password: z.string().min(1), code: z.string().regex(/^\d{6}$/) }),
};

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent') });

async function sendSession(req: Request, res: Response, user: Parameters<typeof AuthService.issueTokens>[0] & { toJSON(): unknown }) {
  const { accessToken, refreshToken } = await AuthService.issueTokens(user, meta(req));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts());
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return res.json({ accessToken, user: user.toJSON() });
}

export const authController = {
  async register(req: Request, res: Response) {
    // Public registration is only open to bootstrap the first (admin) account.
    if ((await User.estimatedDocumentCount()) > 0) throw new AppError(403, 'Registration is closed. Ask an admin to create your account.', 'REGISTRATION_CLOSED');
    const user = await AuthService.register(req.body.email, req.body.name, req.body.password);
    await audit(req, { action: 'USER_REGISTERED', resource: 'user', resourceId: user._id.toString() });
    return sendSession(req, res, user);
  },

  async login(req: Request, res: Response) {
    try {
      const r = await AuthService.login(req.body.email, req.body.password);
      await audit(req, { action: 'LOGIN_PASSWORD_OK', resource: 'user', resourceId: r.user._id.toString(), details: { requires2fa: r.requires2fa } });
      if (r.requires2fa) return res.json({ requires2fa: true, challengeToken: r.challengeToken });
      return sendSession(req, res, r.user);
    } catch (err) {
      await audit(req, { action: 'LOGIN_FAILED', success: false, details: { email: req.body.email } });
      throw err;
    }
  },

  async verify2fa(req: Request, res: Response) {
    try {
      const user = await AuthService.verify2faChallenge(req.body.challengeToken, req.body.code);
      await audit(req, { action: 'LOGIN_2FA_OK', resource: 'user', resourceId: user._id.toString() });
      return sendSession(req, res, user);
    } catch (err) {
      await audit(req, { action: 'LOGIN_2FA_FAILED', success: false });
      throw err;
    }
  },

  async refresh(req: Request, res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new AppError(401, 'No refresh token', 'INVALID_REFRESH');
    try {
      const r = await AuthService.refresh(token, meta(req));
      res.cookie(REFRESH_COOKIE, r.refreshToken, cookieOpts());
      return res.json({ accessToken: r.accessToken, user: r.user.toJSON() });
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw err;
    }
  },

  async logout(req: Request, res: Response) {
    await AuthService.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    await audit(req, { action: 'LOGOUT' });
    return res.json({ ok: true });
  },

  async me(req: Request, res: Response) {
    const user = await User.findById(req.user!.id);
    if (!user) throw new AppError(404, 'User not found');
    return res.json({ user: user.toJSON() });
  },

  async setup2fa(req: Request, res: Response) {
    const r = await AuthService.begin2faSetup(req.user!.id);
    const qr = await QRCode.toDataURL(r.otpauthUrl);
    await audit(req, { action: '2FA_SETUP_STARTED' });
    // The secret is shown once to the user for enrolment; it is stored encrypted at rest.
    return res.json({ secret: r.secret, otpauthUrl: r.otpauthUrl, qr });
  },

  async confirm2fa(req: Request, res: Response) {
    await AuthService.confirm2fa(req.user!.id, req.body.code);
    await audit(req, { action: '2FA_ENABLED' });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return res.json({ ok: true, message: '2FA enabled. Please sign in again.' });
  },

  async disable2fa(req: Request, res: Response) {
    await AuthService.disable2fa(req.user!.id, req.body.password, req.body.code);
    await audit(req, { action: '2FA_DISABLED' });
    return res.json({ ok: true });
  },
};
