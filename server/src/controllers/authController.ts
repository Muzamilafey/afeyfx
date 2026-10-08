import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { User } from '../models/User';
import { AuthService } from '../services/AuthService';
import { EmailTokenService } from '../services/EmailTokenService';
import { googleAuthService } from '../services/GoogleAuthService';
import { mailService } from '../services/MailService';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { appUrl, githubAuthService } from '../services/GitHubAuthService';

const GH_STATE_COOKIE = 'afx_gh_state';

const REFRESH_COOKIE = 'afx_rt';
const cookieOpts = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict' as const,
  path: '/api/auth',
  maxAge: env.JWT_REFRESH_TTL_DAYS * 86_400_000,
});

const code6 = z.string().regex(/^\d{6}$/);

export const schemas = {
  register: z.object({ email: z.string().email().max(200), name: z.string().min(1).max(100), password: z.string().min(12).max(200) }),
  login: z.object({ email: z.string().email(), password: z.string().min(1).max(200), portal: z.enum(['trader', 'admin']).default('trader') }),
  google: z.object({ credential: z.string().min(20).max(5000) }),
  verify2fa: z.object({ challengeToken: z.string().min(10), code: code6, method: z.enum(['totp', 'email']).default('totp') }),
  challenge: z.object({ challengeToken: z.string().min(10) }),
  verifyEmail: z.object({ uid: z.string().regex(/^[a-f0-9]{24}$/i), token: z.string().min(20).max(200) }),
  code: z.object({ code: code6 }),
  disable2fa: z.object({ password: z.string().max(200).optional(), code: code6 }),
  secondFactor: z.object({ totp: z.string().optional(), emailCode: z.string().optional() }),
  actionCode: z.object({ context: z.string().max(80).optional() }),
  password: z.object({ currentPassword: z.string().max(200).optional(), newPassword: z.string().min(12).max(200) }),
};

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent') });

type SessionUser = Parameters<typeof AuthService.issueTokens>[0] & { toJSON(): unknown };

async function sendSession(req: Request, res: Response, user: SessionUser) {
  const { accessToken, refreshToken } = await AuthService.issueTokens(user, meta(req));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts());
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return res.json({ accessToken, user: user.toJSON() });
}

export const authController = {
  /** Public, non-sensitive auth configuration for the login screen. */
  config(_req: Request, res: Response) {
    res.json({ githubEnabled: !!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET, signupEnabled: env.ALLOW_PUBLIC_SIGNUP, googleClientId: env.GOOGLE_CLIENT_ID || null, googleEnabled: googleAuthService.enabled, emailEnabled: mailService.configured || env.NODE_ENV !== 'production', requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION });
  },

  async register(req: Request, res: Response) {
    // First account = admin (bootstrap). Afterwards, public sign-up creates TRADER accounts
    // (personal demo account; trading unlocks after email verification) when ALLOW_PUBLIC_SIGNUP=true.
    const user = await AuthService.register(req.body.email, req.body.name, req.body.password, 'trader', { publicSignup: true });
    await audit(req, { action: 'USER_REGISTERED', resource: 'user', resourceId: user._id.toString() });
    return sendSession(req, res, user);
  },

  async login(req: Request, res: Response) {
    try {
      const r = await AuthService.login(req.body.email, req.body.password, req.body.portal);
      await audit(req, { action: 'LOGIN_PASSWORD_OK', resource: 'user', resourceId: r.user._id.toString(), details: { requires2fa: r.requires2fa } });
      if (r.requires2fa) return res.json({ requires2fa: true, challengeToken: r.challengeToken, methods: r.methods });
      return sendSession(req, res, r.user as SessionUser);
    } catch (err) {
      await audit(req, { action: 'LOGIN_FAILED', success: false, details: { email: req.body.email } });
      throw err;
    }
  },

  /** "Continue with Google" - verifies a Google ID token; 2FA still applies. */
  async google(req: Request, res: Response) {
    try {
      const r = await AuthService.googleLogin(req.body.credential);
      await audit(req, { action: r.linked ? 'GOOGLE_LINKED' : 'LOGIN_GOOGLE_OK', resource: 'user', resourceId: r.user._id.toString(), details: { requires2fa: r.requires2fa } });
      if (r.requires2fa) return res.json({ requires2fa: true, challengeToken: r.challengeToken, methods: r.methods, created: r.created });
      return sendSession(req, res, r.user as SessionUser);
    } catch (err) {
      await audit(req, { action: 'LOGIN_GOOGLE_FAILED', success: false, details: { reason: (err as Error).message } });
      throw err;
    }
  },

  /** Step 1 of "Continue with GitHub": CSRF state in an httpOnly cookie, then redirect to GitHub. */
  githubStart(_req: Request, res: Response) {
    if (!githubAuthService.enabled) return res.redirect(302, `${appUrl()}/login#error=GITHUB_DISABLED`);
    const state = crypto.randomBytes(32).toString('base64url');
    // SameSite=Lax so the cookie survives the top-level redirect back from github.com.
    res.cookie(GH_STATE_COOKIE, state, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/api/auth/github', maxAge: 10 * 60_000 });
    return res.redirect(302, githubAuthService.authorizeUrl(state));
  },

  /** Step 2: verify state, exchange the code server-side, then hand the session to the SPA (never via the URL). */
  async githubCallback(req: Request, res: Response) {
    const fail = (code: string) => res.redirect(302, `${appUrl()}/login#error=${encodeURIComponent(code)}`);
    const expected = req.cookies?.[GH_STATE_COOKIE];
    res.clearCookie(GH_STATE_COOKIE, { path: '/api/auth/github' });
    const state = String(req.query.state ?? '');
    const code = String(req.query.code ?? '');
    if (!expected || !state || expected.length !== state.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(state))) {
      await audit(req, { action: 'LOGIN_GITHUB_FAILED', success: false, details: { reason: 'state mismatch' } });
      return fail('OAUTH_STATE');
    }
    if (!code || req.query.error) return fail('GITHUB_CANCELLED');
    try {
      const r = await AuthService.oauthLogin('github', await githubAuthService.identify(code));
      await audit(req, { action: r.linked ? 'GITHUB_LINKED' : 'LOGIN_GITHUB_OK', resource: 'user', resourceId: r.user._id.toString(), details: { requires2fa: r.requires2fa, created: r.created } });
      if (r.requires2fa) {
        // URL fragments are never sent to servers or in Referer headers; the token is 5-minute, 2FA-only.
        return res.redirect(302, `${appUrl()}/auth/callback#challenge=${encodeURIComponent(r.challengeToken)}&methods=${r.methods.join(',')}`);
      }
      const { refreshToken } = await AuthService.issueTokens(r.user, meta(req));
      res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts());
      await User.updateOne({ _id: r.user._id }, { $set: { lastLoginAt: new Date() } });
      return res.redirect(302, `${appUrl()}/auth/callback`);
    } catch (err) {
      await audit(req, { action: 'LOGIN_GITHUB_FAILED', success: false, details: { reason: (err as Error).message } });
      return fail(err instanceof AppError ? err.code : 'GITHUB_FAILED');
    }
  },

  async sendLoginCode(req: Request, res: Response) {
    await AuthService.sendLoginEmailCode(req.body.challengeToken);
    res.json({ ok: true });
  },

  async verify2fa(req: Request, res: Response) {
    try {
      const user = await AuthService.verify2faChallenge(req.body.challengeToken, req.body.code, req.body.method);
      await audit(req, { action: 'LOGIN_2FA_OK', resource: 'user', resourceId: user._id.toString(), details: { method: req.body.method } });
      return sendSession(req, res, user);
    } catch (err) {
      await audit(req, { action: 'LOGIN_2FA_FAILED', success: false, details: { method: req.body.method } });
      throw err;
    }
  },

  async verifyEmail(req: Request, res: Response) {
    const user = await EmailTokenService.verifyEmail(req.body.uid, req.body.token);
    await audit(req, { action: 'EMAIL_VERIFIED', resource: 'user', resourceId: user._id.toString() });
    res.json({ ok: true, email: user.email });
  },

  async resendVerification(req: Request, res: Response) {
    const user = await User.findById(req.user!.id);
    if (!user) throw new AppError(404, 'User not found');
    if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    await EmailTokenService.sendVerification(user);
    return res.json({ ok: true });
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
    await audit(req, { action: '2FA_ENABLED', details: { method: 'totp' } });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return res.json({ ok: true, message: '2FA enabled. Please sign in again.' });
  },

  async disable2fa(req: Request, res: Response) {
    await AuthService.disable2fa(req.user!.id, req.body.password, req.body.code);
    await audit(req, { action: '2FA_DISABLED', details: { method: 'totp' } });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return res.json({ ok: true });
  },

  /** Send a single-use code by email (protected actions, or to enable email 2FA). */
  async sendActionCode(req: Request, res: Response) {
    await AuthService.sendActionEmailCode(req.user!.id, req.body.context);
    res.json({ ok: true });
  },

  async enableEmail2fa(req: Request, res: Response) {
    await AuthService.enableEmail2fa(req.user!.id, req.body.code);
    await audit(req, { action: '2FA_ENABLED', details: { method: 'email' } });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.json({ ok: true, message: 'Email 2FA enabled. Please sign in again.' });
  },

  async disableEmail2fa(req: Request, res: Response) {
    await AuthService.disableEmail2fa(req.user!.id, req.body);
    await audit(req, { action: '2FA_DISABLED', details: { method: 'email' } });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.json({ ok: true });
  },

  async setPassword(req: Request, res: Response) {
    await AuthService.setPassword(req.user!.id, req.body.newPassword, req.body.currentPassword);
    await audit(req, { action: 'PASSWORD_CHANGED' });
    res.json({ ok: true });
  },
};
