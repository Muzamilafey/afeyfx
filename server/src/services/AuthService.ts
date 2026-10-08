import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { User } from '../models/User';
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
  typ: 'access' | '2fa_pending';
}

const jwtSecret = () => env.JWT_SECRET || (env.NODE_ENV === 'production' ? '' : 'dev-only-jwt-secret-change-me-0123456789');
const refreshSecret = () => env.JWT_REFRESH_SECRET || (env.NODE_ENV === 'production' ? '' : 'dev-only-refresh-secret-change-me-012345');

export function validatePasswordStrength(pw: string) {
  if (pw.length < 12) throw new AppError(400, 'Password must be at least 12 characters', 'WEAK_PASSWORD');
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) throw new AppError(400, 'Password must include upper, lower case letters and a digit', 'WEAK_PASSWORD');
}

export const AuthService = {
  hashPassword: (pw: string) => bcrypt.hash(pw, BCRYPT_ROUNDS),

  signAccess(claims: Omit<AccessClaims, 'typ'>, typ: AccessClaims['typ'] = 'access') {
    return jwt.sign({ ...claims, typ }, jwtSecret(), { expiresIn: typ === 'access' ? (env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn']) : '5m', algorithm: 'HS256', issuer: 'afeyfx' });
  },

  verifyAccess(token: string): AccessClaims {
    return jwt.verify(token, jwtSecret(), { algorithms: ['HS256'], issuer: 'afeyfx' }) as AccessClaims;
  },

  async register(email: string, name: string, password: string, role: Role = 'viewer') {
    validatePasswordStrength(password);
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) throw new AppError(409, 'Email already registered', 'EMAIL_TAKEN');
    // The very first user becomes admin (bootstrap); everyone else gets the requested/default role.
    const count = await User.estimatedDocumentCount();
    const user = await User.create({ email, name, passwordHash: await this.hashPassword(password), role: count === 0 ? 'admin' : role });
    return user;
  },

  /** Step 1 of login. Returns either tokens or a short-lived 2FA challenge token. */
  async login(email: string, password: string) {
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    const generic = new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    if (!user || !user.active) {
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
    const claims = { sub: user._id.toString(), email: user.email, role: user.role as Role, tfa: user.twoFactorEnabled };
    if (user.twoFactorEnabled) return { requires2fa: true as const, challengeToken: this.signAccess(claims, '2fa_pending'), user };
    return { requires2fa: false as const, user };
  },

  async verify2faChallenge(challengeToken: string, code: string) {
    let claims: AccessClaims;
    try {
      claims = this.verifyAccess(challengeToken);
    } catch {
      throw new AppError(401, 'Invalid or expired 2FA challenge', 'INVALID_CHALLENGE');
    }
    if (claims.typ !== '2fa_pending') throw new AppError(401, 'Invalid 2FA challenge', 'INVALID_CHALLENGE');
    const user = await User.findById(claims.sub).select('+twoFactorSecret');
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) throw new AppError(401, 'Invalid 2FA challenge', 'INVALID_CHALLENGE');
    if (!verifyTotp(decrypt(user.twoFactorSecret), code)) throw new AppError(401, 'Invalid 2FA code', 'INVALID_2FA');
    return user;
  },

  async verifyUserTotp(userId: string, code: string) {
    const user = await User.findById(userId).select('+twoFactorSecret');
    if (!user?.twoFactorEnabled || !user.twoFactorSecret) return false;
    return verifyTotp(decrypt(user.twoFactorSecret), code);
  },

  async verifyPassword(userId: string, password: string) {
    const user = await User.findById(userId).select('+passwordHash');
    return !!user && bcrypt.compare(password, user.passwordHash);
  },

  async issueTokens(user: { _id: { toString(): string }; email: string; role: string; twoFactorEnabled: boolean }, meta: { ip?: string; userAgent?: string }, family: string = randomUUID()) {
    const accessToken = this.signAccess({ sub: user._id.toString(), email: user.email, role: user.role as Role, tfa: user.twoFactorEnabled });
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

  async begin2faSetup(userId: string) {
    const user = await User.findById(userId);
    if (!user) throw new AppError(404, 'User not found');
    const secret = generateTotpSecret();
    user.twoFactorSecret = encrypt(secret);
    user.twoFactorEnabled = false;
    await user.save();
    return { secret, otpauthUrl: totpUri(secret, user.email) };
  },

  async confirm2fa(userId: string, code: string) {
    const user = await User.findById(userId).select('+twoFactorSecret');
    if (!user?.twoFactorSecret) throw new AppError(400, 'Start 2FA setup first');
    if (!verifyTotp(decrypt(user.twoFactorSecret), code)) throw new AppError(400, 'Invalid 2FA code', 'INVALID_2FA');
    user.twoFactorEnabled = true;
    await user.save();
    await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return user;
  },

  async disable2fa(userId: string, password: string, code: string) {
    if (!(await this.verifyPassword(userId, password)) || !(await this.verifyUserTotp(userId, code))) throw new AppError(401, 'Invalid password or 2FA code', 'INVALID_CREDENTIALS');
    await User.updateOne({ _id: userId }, { $set: { twoFactorEnabled: false }, $unset: { twoFactorSecret: 1 } });
  },
};
