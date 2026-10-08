import { CcxtAdapter, type AdapterOptions } from './CcxtAdapter';
import type { PermissionReport } from './ExchangeAdapter';
import { errorMessage } from '../utils/logger';

/** Coinbase Advanced Trade adapter. Uses GET /api/v3/brokerage/key_permissions. No sandbox for spot. */
export class CoinbaseAdapter extends CcxtAdapter {
  constructor(opts: AdapterOptions) {
    super('coinbase', opts);
  }

  async verifyPermissions(): Promise<PermissionReport> {
    if (!this.hasCredentials) return { verified: false, canRead: false, canTrade: false, canWithdraw: true, notes: ['No credentials configured'] };
    const c = this.client as unknown as { v3PrivateGetBrokerageKeyPermissions: () => Promise<Record<string, unknown>> };
    try {
      const r = await c.v3PrivateGetBrokerageKeyPermissions();
      return {
        verified: true,
        canRead: r.can_view === true,
        canTrade: r.can_trade === true,
        canWithdraw: r.can_transfer === true,
        notes: [],
        raw: { ...r },
      };
    } catch (err) {
      return { verified: false, canRead: false, canTrade: false, canWithdraw: true, notes: [`Could not verify permissions: ${errorMessage(err)}`] };
    }
  }
}
