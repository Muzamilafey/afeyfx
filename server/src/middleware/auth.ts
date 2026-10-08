import type { NextFunction, Request, Response } from 'express';
import { AuthService } from '../services/AuthService';
import { AppError } from '../utils/errors';
import type { Role } from '../types';
import { audit } from '../services/AuditService';

/** Verifies the Bearer access token. Rejects 2FA-pending challenge tokens. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return next(new AppError(401, 'Authentication required', 'UNAUTHENTICATED'));
  try {
    const c = AuthService.verifyAccess(h.slice(7));
    if (c.typ !== 'access') return next(new AppError(401, 'Invalid token type', 'UNAUTHENTICATED'));
    req.user = { id: c.sub, email: c.email, role: c.role, twoFactorEnabled: c.tfa };
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
 * Protected actions (live mode, emergency controls, credential changes) require the admin to have
 * 2FA enabled and to re-authenticate with a fresh TOTP code in the request body (`totp`).
 */
export async function requireFreshTotp(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
    if (!req.user.twoFactorEnabled) throw new AppError(403, 'Two-factor authentication must be enabled for this action', 'TWO_FACTOR_REQUIRED');
    const code = String(req.body?.totp ?? '');
    if (!(await AuthService.verifyUserTotp(req.user.id, code))) {
      void audit(req, { action: 'PROTECTED_ACTION_2FA_FAILED', resource: req.originalUrl, success: false });
      throw new AppError(401, 'Valid 2FA code required for this action', 'INVALID_2FA');
    }
    next();
  } catch (err) {
    next(err);
  }
}
