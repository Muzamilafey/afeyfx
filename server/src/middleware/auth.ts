import type { NextFunction, Request, Response } from 'express';
import { AuthService } from '../services/AuthService';
import { AppError } from '../utils/errors';
import type { Role } from '../types';
import { audit } from '../services/AuditService';
import { env } from '../config/env';
import { User } from '../models/User';

/** Verifies the Bearer access token. Rejects 2FA-pending challenge tokens. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return next(new AppError(401, 'Authentication required', 'UNAUTHENTICATED'));
  try {
    const c = AuthService.verifyAccess(h.slice(7));
    if (c.typ !== 'access') return next(new AppError(401, 'Invalid token type', 'UNAUTHENTICATED'));
    req.user = { id: c.sub, email: c.email, role: c.role, twoFactorEnabled: c.tfa, emailVerified: c.ev === true };
    return next();
  } catch {
    return next(new AppError(401, 'Invalid or expired token', 'UNAUTHENTICATED'));
  }
}

const RANK: Record<Role, number> = { viewer: 1, trader: 2, admin: 3 };

/** RBAC: allow if the user's role is at least one of the given roles' rank (admin > trader > viewer). */
export function requireRole(...roles: Role[]) {
  const min = Math.min(...roles.map((r) => RANK[r]));
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(401, 'Authentication required', 'UNAUTHENTICATED'));
    if (RANK[req.user.role] < min) {
      void audit(req, { action: 'RBAC_DENIED', resource: req.originalUrl, success: false, details: { required: roles, role: req.user.role } });
      return next(new AppError(403, 'Insufficient permissions', 'FORBIDDEN'));
    }
    return next();
  };
}

/**
 * Trading and administrative actions require a verified email address (REQUIRE_EMAIL_VERIFICATION).
 * The access token carries the flag; if it says "unverified" the database is checked, because the
 * user may have verified after the token was issued (tokens live up to 15 minutes).
 */
export function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction) {
  if (!env.REQUIRE_EMAIL_VERIFICATION || req.user?.emailVerified) return next();
  if (!req.user) return next(new AppError(401, 'Authentication required', 'UNAUTHENTICATED'));
  User.exists({ _id: req.user.id, emailVerified: true, active: { $ne: false } })
    .then((ok) => {
      if (!ok) return next(new AppError(403, 'Verify your email address to use this feature', 'EMAIL_NOT_VERIFIED'));
      req.user!.emailVerified = true;
      return next();
    })
    .catch(next);
}

/**
 * Protected actions (live mode, emergency controls, credential changes) require the admin to have
 * a second factor enabled and to re-authenticate with a FRESH code in the request body: either an
 * authenticator code (`totp`) or a single-use emailed code (`emailCode`).
 */
export async function requireFreshSecondFactor(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
    if (!req.user.twoFactorEnabled) throw new AppError(403, 'Two-factor authentication must be enabled for this action', 'TWO_FACTOR_REQUIRED');
    if (!(await AuthService.verifySecondFactor(req.user.id, { totp: req.body?.totp, emailCode: req.body?.emailCode }))) {
      void audit(req, { action: 'PROTECTED_ACTION_2FA_FAILED', resource: req.originalUrl, success: false });
      throw new AppError(401, 'Valid 2FA code required for this action', 'INVALID_2FA');
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** @deprecated alias kept for readability in older code. */
export const requireFreshTotp = requireFreshSecondFactor;
