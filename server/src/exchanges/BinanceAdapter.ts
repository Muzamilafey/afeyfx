import { CcxtAdapter, type AdapterOptions } from './CcxtAdapter';
import type { PermissionReport } from './ExchangeAdapter';
import { errorMessage } from '../utils/logger';

/** Binance spot adapter. Uses GET /sapi/v1/account/apiRestrictions to verify key permissions. */
export class BinanceAdapter extends CcxtAdapter {
  constructor(opts: AdapterOptions) {
    super('binance', opts);
  }

  async verifyPermissions(): Promise<PermissionReport> {
    if (!this.hasCredentials) return { verified: false, canRead: false, canTrade: false, canWithdraw: true, notes: ['No credentials configured'] };
    const c = this.client as unknown as { sapiGetAccountApiRestrictions: () => Promise<Record<string, unknown>> };
    try {
      const r = await c.sapiGetAccountApiRestrictions();
      return {
        verified: true,
        canRead: r.enableReading === true,
        canTrade: r.enableSpotAndMarginTrading === true,
        canWithdraw: r.enableWithdrawals === true || r.enableInternalTransfer === true || r.permitsUniversalTransfer === true,
        ipRestricted: r.ipRestrict === true,
        notes: r.ipRestrict === true ? [] : ['Key is not IP-restricted; restricting to the VPS IP is strongly recommended'],
        raw: { ...r },
      };
    } catch (err) {
      if (this.testnet) {
        // The spot testnet has no /sapi endpoints. Testnet keys cannot move real funds.
        return { verified: true, canRead: true, canTrade: true, canWithdraw: false, notes: ['Testnet: withdrawal permissions not applicable (no real funds)'] };
      }
      return { verified: false, canRead: false, canTrade: false, canWithdraw: true, notes: [`Could not verify permissions: ${errorMessage(err)}`] };
    }
  }
}
