import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { User, hasSecondFactor } from '../models/User';
import { EmailTokenService } from './EmailTokenService';
import { googleAuthService } from './GoogleAuthService';
import { notifyAccountEvent } from './AccountNotices';
import { RefreshToken } from '../models/RefreshToken';
import { AppError } from '../utils/errors';
import { decrypt, encrypt, randomToken, sha256 } from '../utils/crypto';
import { generateTotpSecret, totpUri, verifyTotp } from '../utils/totp';
import type { Role } from '../types';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;

export interface AccessClaims {
  sub: string;
  email: string;
  role: Role;
  tfa: boolean;
  /** Email address verified. */
  ev?: boolean;
  /** Second-factor methods available (challenge tokens only). */
  m?: ('totp' | 'email')[];
  typ: 'access' | '2fa_pending';
}

const jwtSecret = () => env.JWT_SECRET || (env.NODE_ENV === 'production' ? '' : 'dev-only-jwt-secret-change-me-0123456789');
const refreshSecret = () => env.JWT_REFRESH_SECRET || (env.NODE_ENV === 'production' ? '' : 'dev-only-refresh-secret-change-me-012345');

export function validatePasswordStrength(pw: string) {
  if (pw.length < 12) throw new AppError(400, 'Password must be at least 12 characters', 'WEAK_PASSWORD');
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) throw new AppError(400, 'Password must include upper, lower case letters and a digit', 'WEAK_PASSWORD');
}

export type SecondFactorMethod = 'totp' | 'email';

type UserLike = { _id: { toString(): string }; email: string; role: string; twoFactorEnabled?: boolean | null; emailOtpEnabled?: boolean | null; emailVerified?: boolean | null };

const methodsOf = (u: { twoFactorEnabled?: boolean | null; emailOtpEnabled?: boolean | null }): SecondFactorMethod[] => [
  ...(u.twoFactorEnabled ? (['totp'] as const) : []),
  ...(u.emailOtpEnabled ? (['email'] as const) : []),
];

const claimsOf = (u: UserLike) => ({ sub: u._id.toString(), email: u.email, role: u.role as Role, tfa: hasSecondFactor(u), ev: !!u.emailVerified });

export const AuthService = {
  hashPassword: (pw: string) => bcrypt.hash(pw, BCRYPT_ROUNDS),

  signAccess(claims: Omit<AccessClaims, 'typ'>, typ: AccessClaims['typ'] = 'access') {
    return jwt.sign({ ...claims, typ }, jwtSecret(), { expiresIn: typ === 'access' ? (env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn']) : '5m', algorithm: 'HS256', issuer: 'afeyfx' });
  },

  verifyAccess(token: string): AccessClaims {
    return jwt.verify(token, jwtSecret(), { algorithms: ['HS256'], issuer: 'afeyfx' }) as AccessClaims;
  },

  async register(email: string, name: string, password: string, role: Role = 'viewer', opts: { emailVerified?: boolean; sendVerification?: boolean; publicSignup?: boolean } = {}) {
    validatePasswordStrength(password);
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) throw new AppError(409, 'Email already registered', 'EMAIL_TAKEN');
    // The very first user becomes admin (bootstrap); everyone else gets the requested/default role.
    const count = await User.estimatedDocumentCount();
    if (count > 0 && opts.publicSignup && !env.ALLOW_PUBLIC_SIGNUP) throw new AppError(403, 'Sign-up is closed. Ask an admin to create your account.', 'SIGNUP_CLOSED');
    const user = await User.create({ email, name, passwordHash: await this.hashPassword(password), passwordSet: true, role: count === 0 ? 'admin' : role, emailVerified: !!opts.emailVerified, emailVerifiedAt: opts.emailVerified ? new Date() : undefined });
    if (!user.emailVerified && opts.sendVerification !== false) await this.sendVerificationSafe(user);
    return user;
  },

  /** Send a verification email; failures are reported but never block account creation. */
  async sendVerificationSafe(user: Parameters<typeof EmailTokenService.sendVerification>[0]) {
    try {
      await EmailTokenService.sendVerification(user);
      return true;
    } catch {
      return false;
    }
  },

  /** Either a session (no 2FA) or a short-lived challenge listing the available second factors. */
  completeFirstFactor(user: UserLike) {
    if (hasSecondFactor(user)) return { requires2fa: true as const, challengeToken: this.signAccess({ ...claimsOf(user), m: methodsOf(user) }, '2fa_pending'), methods: methodsOf(user), user };
    return { requires2fa: false as const, user };
  },

  /** Step 1 of password login. `portal: 'admin'` (admin console) only accepts admin accounts. */
  async login(email: string, password: string, portal: 'trader' | 'admin' = 'trader') {
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    const generic = new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    if (!user || !user.active || !user.passwordHash) {
      await bcrypt.compare(password, '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7Q2nV5Yb1aGq7r6WkT3v9hFz1Sx1i9u'); // timing equalization
      throw generic;
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) throw new AppError(423, 'Account temporarily locked due to failed logins', 'ACCOUNT_LOCKED');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      user.failedLoginAttempts = (user.failedLoginAttempts ?? 0) + 1;
      if (user.failedLoginAttempts >= MAX_FAILED) {
        user.lockedUntil = new Date(Date.now() + LOCK_MS);
        user.failedLoginAttempts = 0;
      }
      await user.save();
      throw generic;
    }
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;
    await user.save();
    if (portal === 'admin' && user.role !== 'admin') throw generic;
    return this.completeFirstFactor(user);
  },

  /**
   * Social sign-in ("Continue with Google" / "Continue with GitHub"). The provider proves control of
   * the email address, but never bypasses 2FA. Matching order: provider id -> existing account with
   * the same (provider-verified) email -> first-ever user becomes admin -> new trader account when
   * ALLOW_PUBLIC_SIGNUP=true.
   */
  async oauthLogin(provider: 'google' | 'github', id: { sub: string; email: string; emailVerified: boolean; name?: string; avatarUrl?: string }) {
    const field = provider === 'google' ? 'googleId' : 'githubId';
    const label = provider === 'google' ? 'Google' : 'GitHub';
    if (!id.emailVerified) throw new AppError(401, `Your ${label} account email is not verified`, `${provider.toUpperCase()}_EMAIL_UNVERIFIED`);
    const email = id.email.toLowerCase();
    let user = await User.findOne({ [field]: id.sub });
    let linked = false;
    let created = false;
    if (!user) {
      user = await User.findOne({ email });
      if (user) {
        if (user[field] && user[field] !== id.sub) throw new AppError(409, `This account is linked to a different ${label} account`, `${provider.toUpperCase()}_MISMATCH`);
        user[field] = id.sub;
        linked = true;
      } else {
        const count = await User.estimatedDocumentCount();
        if (count > 0 && !env.ALLOW_PUBLIC_SIGNUP) throw new AppError(403, `No account exists for this ${label} email. Ask an administrator to create one.`, 'SIGNUP_CLOSED');
        user = new User({ email, name: id.name || email.split('@')[0], [field]: id.sub, role: count === 0 ? 'admin' : 'trader', passwordSet: false, avatarUrl: id.avatarUrl });
        created = true;
      }
    }
    if (!user.active) throw new AppError(401, 'Account disabled', 'INVALID_CREDENTIALS');
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) throw new AppError(423, 'Account temporarily locked', 'ACCOUNT_LOCKED');
    if (!user.emailVerified) {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
    }
    if (id.avatarUrl && !user.avatarUrl) user.avatarUrl = id.avatarUrl;
    await user.save();
    if (linked) void notifyAccountEvent(user, `${label} sign-in linked`, `Your ${label} account was linked to your AfeyFX account.`);
    return { ...this.completeFirstFactor(user), linked, created };
  },

  async googleLogin(credential: string) {
    return this.oauthLogin('google', await googleAuthService.verify(credential));
  },

  async challengeUser(challengeToken: string) {
    let claims: AccessClaims;
    try {
      claims = this.verifyAccess(challengeToken);
    } catch {
      throw new AppError(401, 'Invalid or expired 2FA challenge', 'INVALID_CHALLENGE');
    }
    if (claims.typ !== '2fa_pending') throw new AppError(401, 'Invalid 2FA challenge', 'INVALID_CHALLENGE');
    const user = await User.findById(claims.sub).select('+twoFactorSecret');
    if (!user || !user.active || !hasSecondFactor(user)) throw new AppError(401, 'Invalid 2FA challenge', 'INVALID_CHALLENGE');
    return user;
  },

  /** Send an emailed login code for a pending 2FA challenge. */
  async sendLoginEmailCode(challengeToken: string) {
    const user = await this.challengeUser(challengeToken);
    if (!user.emailOtpEnabled) throw new AppError(400, 'Email codes are not enabled for this account', 'METHOD_UNAVAILABLE');
    await EmailTokenService.sendCode(user, 'LOGIN_2FA');
  },

  async verify2faChallenge(challengeToken: string, code: string, method: SecondFactorMethod = 'totp') {
    const user = await this.challengeUser(challengeToken);
    let ok = false;
    if (method === 'email') ok = !!user.emailOtpEnabled && (await EmailTokenService.verifyCode(user._id.toString(), 'LOGIN_2FA', code));
    else ok = !!user.twoFactorEnabled && !!user.twoFactorSecret && verifyTotp(decrypt(user.twoFactorSecret), code);
    if (!ok) throw new AppError(401, 'Invalid 2FA code', 'INVALID_2FA');
    return user;
  },

  async verifyUserTotp(userId: string, code: string) {
    const user = await User.findById(userId).select('+twoFactorSecret');
    if (!user?.twoFactorEnabled || !user.twoFactorSecret) return false;
    return verifyTotp(decrypt(user.twoFactorSecret), code);
  },

  /** Fresh second factor for a protected action: authenticator code (`totp`) or single-use emailed code (`emailCode`). */
  async verifySecondFactor(userId: string, input: { totp?: unknown; emailCode?: unknown }) {
    if (input.emailCode !== undefined && input.emailCode !== '') {
      const u = await User.findById(userId);
      return !!u?.emailOtpEnabled && EmailTokenService.verifyCode(userId, 'ACTION_2FA', String(input.emailCode));
    }
    return this.verifyUserTotp(userId, String(input.totp ?? ''));
  },

  async sendActionEmailCode(userId: string, context = '') {
    // Codes only go to a verified address; they are accepted only where email 2FA applies
    // (protected actions when email 2FA is enabled, or to prove inbox access when enabling it).
    const user = await User.findById(userId);
    if (!user) throw new AppError(404, 'User not found');
    if (!user.emailVerified) throw new AppError(403, 'Verify your email address first', 'EMAIL_NOT_VERIFIED');
    await EmailTokenService.sendCode(user, 'ACTION_2FA', context);
  },

  async verifyPassword(userId: string, password: string) {
    const user = await User.findById(userId).select('+passwordHash');
    return !!user?.passwordHash && bcrypt.compare(password, user.passwordHash);
  },

  /** Set (Google-only accounts) or change the password. */
  async setPassword(userId: string, newPassword: string, currentPassword?: string) {
    validatePasswordStrength(newPassword);
    const user = await User.findById(userId).select('+passwordHash');
    if (!user) throw new AppError(404, 'User not found');
    if (user.passwordHash && !(currentPassword && (await bcrypt.compare(currentPassword, user.passwordHash)))) throw new AppError(401, 'Current password is incorrect', 'INVALID_CREDENTIALS');
    user.passwordHash = await this.hashPassword(newPassword);
    user.passwordSet = true;
    await user.save();
    void notifyAccountEvent(user, 'Password changed', 'The password for your AfeyFX account was set or changed.');
  },

  async issueTokens(user: UserLike, meta: { ip?: string; userAgent?: string }, family: string = randomUUID()) {
    const accessToken = this.signAccess(claimsOf(user));
    const refreshToken = `${randomToken(48)}.${jwt.sign({ f: family }, refreshSecret(), { expiresIn: `${env.JWT_REFRESH_TTL_DAYS}d` as jwt.SignOptions['expiresIn'] })}`;
    await RefreshToken.create({ user: user._id.toString(), tokenHash: sha256(refreshToken), family, expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000), ip: meta.ip, userAgent: meta.userAgent });
    return { accessToken, refreshToken };
  },

  /** Refresh-token rotation with reuse detection: re-use of a rotated token revokes the whole family. */
  async refresh(token: string, meta: { ip?: string; userAgent?: string }) {
    const doc = await RefreshToken.findOne({ tokenHash: sha256(token) });
    if (!doc) throw new AppError(401, 'Invalid refresh token', 'INVALID_REFRESH');
    if (doc.revokedAt) {
      await RefreshToken.updateMany({ family: doc.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
      throw new AppError(401, 'Refresh token reuse detected; session revoked', 'REFRESH_REUSE');
    }
    if (doc.expiresAt.getTime() < Date.now()) throw new AppError(401, 'Refresh token expired', 'INVALID_REFRESH');
    const user = await User.findById(doc.user);
    if (!user || !user.active) throw new AppError(401, 'User inactive', 'INVALID_REFRESH');
    const tokens = await this.issueTokens(user, meta, doc.family);
    doc.revokedAt = new Date();
    doc.replacedBy = sha256(tokens.refreshToken);
    await doc.save();
    return { ...tokens, user };
  },

  async logout(token?: string) {
    if (!token) return;
    const doc = await RefreshToken.findOne({ tokenHash: sha256(token) });
    if (doc) await RefreshToken.updateMany({ family: doc.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
  },

  revokeSessions: (userId: string) => RefreshToken.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } }),

  async begin2faSetup(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError(404, 'User not found');
    // Never silently replace an active authenticator - it must be disabled (with a code) first.
    if (user.twoFactorEnabled) throw new AppError(409, 'Authenticator 2FA is already enabled. Disable it first to re-enrol.', 'ALREADY_ENABLED');
    const secret = generateTotpSecret();
    user.twoFactorSecret = encrypt(secret);
    await user.save();
    return { secret, otpauthUrl: totpUri(secret, user.email) };
  },

  async confirm2fa(userId: string, code: string) {
    const user = await User.findById(userId).select('+twoFactorSecret');
    if (!user?.twoFactorSecret) throw new AppError(400, 'Start 2FA setup first');
    if (user.twoFactorEnabled) throw new AppError(409, 'Authenticator 2FA is already enabled', 'ALREADY_ENABLED');
    if (!verifyTotp(decrypt(user.twoFactorSecret), code)) throw new AppError(400, 'Invalid 2FA code', 'INVALID_2FA');
    user.twoFactorEnabled = true;
    await user.save();
    await this.revokeSessions(user._id.toString());
    void notifyAccountEvent(user, 'Authenticator 2FA enabled', 'Two-factor authentication with an authenticator app was enabled.');
    return user;
  },

  /** Disabling needs the password (if the account has one) and a valid authenticator code. */
  async disable2fa(userId: string, password: string | undefined, code: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError(404, 'User not found');
    const pwOk = user.passwordSet ? await this.verifyPassword(userId, password ?? '') : true;
    if (!pwOk || !(await this.verifyUserTotp(userId, code))) throw new AppError(401, 'Invalid password or 2FA code', 'INVALID_CREDENTIALS');
    await User.updateOne({ _id: userId }, { $set: { twoFactorEnabled: false }, $unset: { twoFactorSecret: 1 } });
    await this.revokeSessions(userId);
    void notifyAccountEvent(user, 'Authenticator 2FA disabled', 'Two-factor authentication with an authenticator app was disabled.');
  },

  /** Email codes as a second factor: requires a verified email and proof of inbox access (a code). */
  async enableEmail2fa(userId: string, code: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError(404, 'User not found');
    if (!user.emailVerified) throw new AppError(403, 'Verify your email address first', 'EMAIL_NOT_VERIFIED');
    if (!(await EmailTokenService.verifyCode(userId, 'ACTION_2FA', code))) throw new AppError(400, 'Invalid or expired email code', 'INVALID_2FA');
    user.emailOtpEnabled = true;
    await user.save();
    await this.revokeSessions(userId);
    void notifyAccountEvent(user, 'Email 2FA enabled', 'Security codes sent to this address can now be used as a second factor.');
    return user;
  },

  /** Disabling email codes needs a valid second factor (authenticator code or a fresh email code). */
  async disableEmail2fa(userId: string, input: { totp?: unknown; emailCode?: unknown }) {
    const user = await User.findById(userId);
    if (!user?.emailOtpEnabled) throw new AppError(400, 'Email 2FA is not enabled');
    if (!(await this.verifySecondFactor(userId, input))) throw new AppError(401, 'Valid 2FA code required', 'INVALID_2FA');
    user.emailOtpEnabled = false;
    await user.save();
    await this.revokeSessions(userId);
    void notifyAccountEvent(user, 'Email 2FA disabled', 'Email security codes were disabled as a second factor.');
  },
};
