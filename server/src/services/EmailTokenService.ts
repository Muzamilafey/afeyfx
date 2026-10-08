import crypto from 'crypto';
import { env } from '../config/env';
import { EmailTokenModel, type EmailTokenPurpose } from '../models/EmailToken';
import { User } from '../models/User';
import { AppError } from '../utils/errors';
import { emailHtml, mailService } from './MailService';

const CODE_TTL_MS = 10 * 60_000;
const LINK_TTL_MS = 24 * 3_600_000;
const RESEND_COOLDOWN_MS = 30_000;
const MAX_ATTEMPTS = 5;

function hmacKey() {
  return crypto.createHash('sha256').update(`email-token:${env.ENCRYPTION_KEY || env.JWT_SECRET || 'afeyfx-dev-only'}`).digest();
}
const digest = (userId: string, purpose: string, token: string) => crypto.createHmac('sha256', hmacKey()).update(`${userId}:${purpose}:${token}`).digest('hex');
const appUrl = () => (env.APP_URL || env.CLIENT_ORIGIN.split(',')[0]).replace(/\/$/, '');

async function issue(userId: string, purpose: EmailTokenPurpose, token: string, ttlMs: number) {
  const last = await EmailTokenModel.findOne({ user: userId, purpose }).sort({ createdAt: -1 });
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) throw new AppError(429, 'Please wait 30 seconds before requesting another email', 'EMAIL_COOLDOWN');
  // Only the newest token of each purpose is valid.
  await EmailTokenModel.updateMany({ user: userId, purpose, usedAt: null }, { $set: { usedAt: new Date() } });
  await EmailTokenModel.create({ user: userId, purpose, tokenHash: digest(userId, purpose, token), expiresAt: new Date(Date.now() + ttlMs) });
}

async function consume(userId: string, purpose: EmailTokenPurpose, token: string): Promise<boolean> {
  const doc = await EmailTokenModel.findOne({ user: userId, purpose, usedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  if (!doc) return false;
  if (doc.attempts >= MAX_ATTEMPTS) {
    doc.usedAt = new Date();
    await doc.save();
    return false;
  }
  const ok = crypto.timingSafeEqual(Buffer.from(doc.tokenHash, 'hex'), Buffer.from(digest(userId, purpose, token), 'hex'));
  if (!ok) {
    doc.attempts += 1;
    if (doc.attempts >= MAX_ATTEMPTS) doc.usedAt = new Date();
    await doc.save();
    return false;
  }
  // Atomic single use: a concurrent replay cannot consume the same token twice.
  const r = await EmailTokenModel.updateOne({ _id: doc._id, usedAt: null }, { $set: { usedAt: new Date() } });
  return r.modifiedCount === 1;
}

/** Email verification links and email-delivered second-factor codes. */
export const EmailTokenService = {
  async sendVerification(user: { _id: { toString(): string }; email: string; name?: string | null }) {
    const token = crypto.randomBytes(32).toString('base64url');
    await issue(user._id.toString(), 'VERIFY_EMAIL', token, LINK_TTL_MS);
    const url = `${appUrl()}/verify-email?uid=${user._id.toString()}&token=${token}`;
    await mailService.send({
      to: user.email,
      subject: 'Verify your AfeyFX email address',
      text: `Hi ${user.name ?? ''},\n\nConfirm your email address by opening this link (valid for 24 hours):\n${url}\n\nIf you did not create this account, ignore this email.`,
      html: emailHtml('Verify your email address', 'Confirm this address to unlock trading and admin actions. The link is valid for 24 hours.', { label: 'Verify email', url }),
    });
  },

  async verifyEmail(userId: string, token: string) {
    if (!/^[a-f0-9]{24}$/i.test(userId) || !(await consume(userId, 'VERIFY_EMAIL', token))) throw new AppError(400, 'Verification link is invalid or has expired', 'INVALID_VERIFICATION');
    const user = await User.findByIdAndUpdate(userId, { $set: { emailVerified: true, emailVerifiedAt: new Date() } }, { returnDocument: 'after' });
    if (!user) throw new AppError(400, 'Verification link is invalid or has expired', 'INVALID_VERIFICATION');
    return user;
  },

  /** Send a 6-digit code for login (LOGIN_2FA) or a protected action (ACTION_2FA). */
  async sendCode(user: { _id: { toString(): string }; email: string }, purpose: 'LOGIN_2FA' | 'ACTION_2FA', context = '') {
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    await issue(user._id.toString(), purpose, code, CODE_TTL_MS);
    const what = purpose === 'LOGIN_2FA' ? 'sign in' : `confirm a protected action${context ? ` (${context})` : ''}`;
    await mailService.send({
      to: user.email,
      subject: `Your AfeyFX security code: ${code}`,
      text: `Your code to ${what} is ${code}. It expires in 10 minutes and can be used once.\n\nIf you did not request it, change your password and review your account.`,
      html: emailHtml(`Security code: ${code}`, `Use this code to ${what}. It expires in 10 minutes and can be used once.`),
    });
  },

  verifyCode(userId: string, purpose: 'LOGIN_2FA' | 'ACTION_2FA', code: string) {
    if (!/^\d{6}$/.test(code)) return Promise.resolve(false);
    return consume(userId, purpose, code);
  },
};
