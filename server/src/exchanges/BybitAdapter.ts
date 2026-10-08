import { CcxtAdapter, type AdapterOptions } from './CcxtAdapter';
import type { PermissionReport } from './ExchangeAdapter';
import { errorMessage } from '../utils/logger';

/** Bybit (v5) adapter. Uses GET /v5/user/query-api to verify key permissions. */
export class BybitAdapter extends CcxtAdapter {
  constructor(opts: AdapterOptions) {
    super('bybit', opts);
  }

  async verifyPermissions(): Promise<PermissionReport> {
    if (!this.hasCredentials) return { verified: false, canRead: false, canTrade: false, canWithdraw: true, notes: ['No credentials configured'] };
    const c = this.client as unknown as { privateGetV5UserQueryApi: () => Promise<{ result?: Record<string, unknown> }> };
    try {
      const res = (await c.privateGetV5UserQueryApi()).result ?? {};
      const perms = (res.permissions ?? {}) as Record<string, string[]>;
      const all = Object.values(perms).flat().map((p) => String(p).toLowerCase());
      const readOnly = String(res.readOnly) === '1' || res.readOnly === 1;
      return {
        verified: true,
        canRead: true,
        canTrade: !readOnly && ((perms.Spot ?? []).length > 0 || (perms.ContractTrade ?? []).length > 0),
        canWithdraw: all.some((p) => p.includes('withdraw') || p.includes('transfer')),
        ipRestricted: Array.isArray(res.ips) && !(res.ips as string[]).includes('*'),
        notes: [],
        raw: { permissions: perms, readOnly: res.readOnly },
      };
    } catch (err) {
      return { verified: false, canRead: false, canTrade: false, canWithdraw: true, notes: [`Could not verify permissions: ${errorMessage(err)}`] };
    }
  }
}
