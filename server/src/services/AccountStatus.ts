import { User } from '../models/User';
import { AppError } from '../utils/errors';

type StatusFields = { active?: boolean | null; suspendedUntil?: Date | null; deletedAt?: Date | null };

/** Why an account may not be used right now, or null when it is usable. */
export function accountBlock(u: StatusFields, now = Date.now()): { code: string; message: string } | null {
  if (u.deletedAt) return { code: 'ACCOUNT_DELETED', message: 'This account no longer exists' };
  if (u.active === false) return { code: 'ACCOUNT_DISABLED', message: 'This account has been disabled. Contact support.' };
  if (u.suspendedUntil && u.suspendedUntil.getTime() > now) return { code: 'ACCOUNT_SUSPENDED', message: `This account is suspended until ${u.suspendedUntil.toISOString().replace('T', ' ').slice(0, 16)} UTC` };
  return null;
}

export function assertAccountUsable(u: StatusFields) {
  const b = accountBlock(u);
  if (b) throw new AppError(403, b.message, b.code);
}

/**
 * Per-request status check for stateless access tokens, cached briefly. Admin actions call
 * `invalidate` so suspensions, disabling and deletion take effect on the very next request.
 */
const cache = new Map<string, { at: number; block: ReturnType<typeof accountBlock> }>();
const TTL_MS = 15_000;

export const accountStatus = {
  async check(userId: string) {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.block;
    const u = await User.findById(userId, { active: 1, suspendedUntil: 1, deletedAt: 1 }).lean();
    const block = u ? accountBlock(u) : { code: 'ACCOUNT_DELETED', message: 'This account no longer exists' };
    cache.set(userId, { at: Date.now(), block });
    if (cache.size > 50_000) cache.clear();
    return block;
  },
  invalidate(userId: string) {
    cache.delete(userId);
  },
};
