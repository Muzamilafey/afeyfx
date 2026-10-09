import { env } from '../../config/env';
import { BrokerConnectionModel, type BrokerConnectionDoc } from '../../models/BrokerConnection';
import { DerivFundingAuthModel, FundingTransactionModel } from '../../models/DerivFunding';
import { notificationService } from '../../notifications/NotificationService';
import { AppError } from '../../utils/errors';
import { decrypt, encrypt } from '../../utils/crypto';
import { errorMessage, logger } from '../../utils/logger';
import { BrokerError } from '../core/types';
import { brokerAuth } from '../services/BrokerAuthenticationService';
import { publishBroker } from '../services/BrokerDataServices';
import { DerivRest, DerivSocket, assertAllowedFundingRequest } from './DerivApi';

/**
 * Funding for the owner's OWN Deriv accounts, without AfeyFX ever holding money:
 *  - Deposit: Deriv's official hosted cashier (`cashier: deposit`, type `url`) when the funding
 *    authorization allows it, otherwise the official cashier page. The user pays on Deriv's site.
 *  - Withdraw: always on Deriv's official cashier page (Deriv requires its own email verification).
 *    AfeyFX never starts a withdrawal.
 *  - Transfers between the user's own accounts/wallets: `transfer_between_accounts`, confirmed with
 *    a fresh 2FA code, idempotent, and only marked COMPLETED once Deriv's statement shows it.
 *  - History: Deriv's statement (deposit / withdrawal / transfer rows), read with the trading
 *    (read) authorization.
 * The payments-scope token lives in DerivFundingAuth and is only used here, on sockets that can
 * only send the funding allow-list (no payment-agent, P2P or withdrawal calls).
 */

type Rpc = (accountId: string, msg: Record<string, unknown>) => Promise<Record<string, unknown>>;
let rpcOverride: Rpc | null = null;
/** Test hook: replace the funding transport. */
export function setDerivFundingRpc(r: Rpc | null) {
  rpcOverride = r;
}

const TYPE_OF: Record<string, 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER_IN' | 'TRANSFER_OUT'> = { deposit: 'DEPOSIT', withdrawal: 'WITHDRAWAL' };

export class DerivFundingService {
  get enabled() {
    return env.DERIV_FUNDING_ENABLED;
  }

  links() {
    return { deposit: env.DERIV_CASHIER_DEPOSIT_URL, withdraw: env.DERIV_CASHIER_WITHDRAW_URL, transfer: env.DERIV_CASHIER_TRANSFER_URL };
  }

  async status(userId: string) {
    const a = await DerivFundingAuthModel.findOne({ user: userId }).lean();
    return {
      enabled: this.enabled,
      authorized: !!a,
      scopes: a?.scopes ?? [],
      expiresAt: a?.tokenExpiresAt ?? null,
      authorizedAt: a?.createdAt ?? null,
      links: this.links(),
    };
  }

  async storeAuth(userId: string, t: { accessToken: string; refreshToken?: string; expiresAt?: Date; scopes?: string[] }) {
    await DerivFundingAuthModel.findOneAndUpdate(
      { user: userId },
      { $set: { accessTokenEnc: encrypt(t.accessToken), refreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken) : undefined, tokenExpiresAt: t.expiresAt, scopes: t.scopes ?? [], tokenType: 'oauth' } },
      { upsert: true },
    );
  }

  async revoke(userId: string) {
    await DerivFundingAuthModel.deleteOne({ user: userId });
  }

  private async token(userId: string) {
    if (!this.enabled) throw new AppError(403, 'Funding is not enabled on this server (DERIV_FUNDING_ENABLED)', 'FUNDING_DISABLED');
    const a = await DerivFundingAuthModel.findOne({ user: userId });
    if (!a) throw new AppError(409, 'Authorize funding with Deriv first', 'FUNDING_NOT_AUTHORIZED');
    if (a.tokenExpiresAt && a.tokenExpiresAt.getTime() - Date.now() < 60_000) {
      if (!a.refreshTokenEnc) throw new AppError(409, 'The funding authorization expired. Authorize again.', 'FUNDING_REAUTH');
      try {
        const t = await brokerAuth.tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(a.refreshTokenEnc), client_id: env.DERIV_CLIENT_ID }, true);
        a.accessTokenEnc = encrypt(t.accessToken);
        if (t.refreshToken) a.refreshTokenEnc = encrypt(t.refreshToken);
        a.tokenExpiresAt = t.expiresAt;
      } catch {
        throw new AppError(409, 'The funding authorization expired. Authorize again.', 'FUNDING_REAUTH');
      }
    }
    a.lastUsedAt = new Date();
    await a.save();
    return decrypt(a.accessTokenEnc);
  }

  /** One short-lived, funding-only socket per operation, authorized as `accountId`. */
  private async call(userId: string, accountId: string, msg: Record<string, unknown>) {
    assertAllowedFundingRequest(msg);
    if (rpcOverride) {
      const r = await rpcOverride(accountId, msg);
      const e = r.error as { code?: string; message?: string } | undefined;
      if (e) throw new BrokerError('rejected', e.message ?? e.code ?? 'Deriv error', { code: e.code });
      return r;
    }
    const token = await this.token(userId);
    const rest = new DerivRest(token, 'oauth', env.DERIV_APP_ID || undefined, env.DERIV_API_BASE);
    const sock = new DerivSocket(() => rest.otpUrl(accountId), () => undefined, () => undefined, undefined, assertAllowedFundingRequest);
    try {
      return await sock.request(msg);
    } finally {
      sock.close();
    }
  }

  private async owned(userId: string, connectionId: string) {
    const c = await BrokerConnectionModel.findOne({ _id: connectionId, user: userId, provider: 'deriv' });
    if (!c || c.status === 'REVOKED') throw new AppError(404, 'Deriv account not found');
    return c;
  }

  /** Accounts and wallets this account can transfer with, with balances (Deriv's own list). */
  async accounts(userId: string, connectionId: string) {
    const c = await this.owned(userId, connectionId);
    const r = await this.call(userId, c.accountId!, { transfer_between_accounts: 1, accounts: 'all' });
    return ((r.accounts ?? []) as Record<string, unknown>[]).map((a) => ({
      loginid: String(a.loginid ?? ''),
      category: String(a.account_category ?? 'trading'),
      type: String(a.account_type ?? ''),
      currency: String(a.currency ?? ''),
      balance: a.balance != null ? Number(a.balance) : null,
      demo: a.demo_account === 1,
      transfers: String(a.transfers ?? 'all'),
      isCurrent: String(a.loginid) === c.accountId,
    }));
  }

  /**
   * Transfer between the user's own Deriv accounts. Idempotent by key; never retried blindly; the
   * row only becomes COMPLETED when Deriv's statement shows the transaction.
   */
  async transfer(userId: string, i: { connectionId: string; to: string; amount: number; currency: string; idempotencyKey: string }) {
    const c = await this.owned(userId, i.connectionId);
    const existing = await FundingTransactionModel.findOne({ idempotencyKey: `tr:${userId}:${i.idempotencyKey}` });
    if (existing) return { transaction: existing, duplicate: true };
    if (!(i.amount > 0)) throw new AppError(400, 'Enter an amount');
    const accounts = await this.accounts(userId, i.connectionId);
    const target = accounts.find((a) => a.loginid === i.to);
    if (!target) throw new AppError(400, 'That account is not available for transfers from this account', 'TRANSFER_TARGET');
    if (target.transfers === 'none' || target.transfers === 'withdrawal') throw new AppError(400, 'Deriv does not allow transfers to that account from here', 'TRANSFER_NOT_ALLOWED');
    const tx = await FundingTransactionModel.create({ user: userId, connection: c._id, accountId: c.accountId, type: 'TRANSFER_OUT', status: 'PENDING', amount: i.amount, currency: i.currency, counterpartAccount: i.to, source: 'afeyfx-transfer', idempotencyKey: `tr:${userId}:${i.idempotencyKey}`, description: `Transfer to ${i.to}` });
    let r: Record<string, unknown>;
    try {
      r = await this.call(userId, c.accountId!, { transfer_between_accounts: 1, account_from: c.accountId, account_to: i.to, amount: Math.round(i.amount * 100) / 100, currency: i.currency });
    } catch (err) {
      const definite = err instanceof BrokerError ? err.definite : err instanceof AppError;
      tx.status = definite ? 'FAILED' : 'UNKNOWN';
      tx.message = definite ? errorMessage(err) : `No definite answer from Deriv (${errorMessage(err)}). Check your Deriv statement before trying again.`;
      await tx.save();
      this.notify(userId, tx);
      return { transaction: tx, duplicate: false };
    }
    if (r.transfer_between_accounts !== 1 && r.transfer_between_accounts !== true) {
      tx.status = 'FAILED';
      tx.message = 'Deriv did not confirm the transfer';
      await tx.save();
      return { transaction: tx, duplicate: false };
    }
    tx.reference = r.transaction_id != null ? String(r.transaction_id) : undefined;
    tx.message = 'Deriv accepted the transfer; confirming with your statement…';
    await tx.save();
    await this.verify(userId, tx._id.toString()).catch((err) => logger.warn({ err: errorMessage(err) }, 'Transfer verification deferred'));
    const fresh = (await FundingTransactionModel.findById(tx._id))!;
    this.notify(userId, fresh);
    return { transaction: fresh, duplicate: false };
  }

  /** Confirm a transfer against Deriv's statement (authoritative). */
  async verify(userId: string, id: string) {
    const tx = await FundingTransactionModel.findOne({ _id: id, user: userId });
    if (!tx || tx.status === 'COMPLETED' || tx.status === 'FAILED' || !tx.connection) return tx;
    const c = await BrokerConnectionModel.findById(tx.connection);
    if (!c) return tx;
    const rows = await this.statement(c, 'transfer', 50);
    const hit = rows.find((t) => (tx.reference && t.reference === tx.reference) || (!tx.reference && Math.abs(Math.abs(t.amount) - tx.amount) < 0.005 && t.time >= tx.createdAt!.getTime() - 60_000));
    tx.lastCheckedAt = new Date();
    if (hit) {
      tx.status = 'COMPLETED';
      tx.reference = hit.reference;
      tx.verifiedAt = new Date();
      tx.occurredAt = new Date(hit.time);
      tx.message = 'Confirmed in your Deriv statement';
    } else if (Date.now() - tx.createdAt!.getTime() > 30 * 60_000) {
      tx.status = 'UNKNOWN';
      tx.message = 'Not found in your Deriv statement after 30 minutes. Check Deriv before trying again.';
    }
    await tx.save();
    publishBroker(String(tx.user), String(tx.connection), 'funding', { id: tx._id.toString(), status: tx.status });
    return tx;
  }

  /** Deposit link: Deriv's hosted cashier URL when authorized, otherwise the official cashier page. */
  async depositLink(userId: string, connectionId: string) {
    const c = await this.owned(userId, connectionId);
    if (c.environment !== 'real') throw new AppError(400, 'Demo accounts are funded with virtual money; reset the balance on Deriv instead', 'DEMO_ACCOUNT');
    const st = await this.status(userId);
    if (st.enabled && st.authorized) {
      try {
        const r = await this.call(userId, c.accountId!, { cashier: 'deposit', provider: 'doughflow', type: 'url' });
        const url = typeof r.cashier === 'string' ? r.cashier : null;
        if (url && /^https:\/\//.test(url)) return { url, source: 'deriv-cashier' as const };
      } catch (err) {
        logger.warn({ err: errorMessage(err) }, 'Deriv cashier URL unavailable; using the official cashier page');
      }
    }
    return { url: env.DERIV_CASHIER_DEPOSIT_URL, source: 'official-page' as const };
  }

  withdrawLink() {
    return { url: env.DERIV_CASHIER_WITHDRAW_URL, source: 'official-page' as const, note: 'Withdrawals are made on Deriv\'s site, which verifies them by email. AfeyFX never starts a withdrawal.' };
  }

  /** Deriv statement rows of one kind for an account (read scope; trading authorization). */
  async statement(c: BrokerConnectionDoc, kind: 'deposit' | 'withdrawal' | 'transfer', limit = 50) {
    const { derivMarket } = await import('./DerivMarketService');
    const a = await derivMarket.adapter(c);
    const r = await a.query({ statement: 1, description: 1, action_type: kind, limit });
    return (((r.statement as { transactions?: Record<string, unknown>[] } | undefined)?.transactions) ?? []).map((t) => ({
      reference: String(t.transaction_id ?? ''),
      time: Number(t.transaction_time ?? 0) * 1000,
      amount: Number(t.amount ?? 0),
      balanceAfter: t.balance_after != null ? Number(t.balance_after) : null,
      description: String(t.longcode ?? t.shortcode ?? '').slice(0, 200),
      action: kind,
    }));
  }

  /** Pull deposits, withdrawals and transfers from Deriv's statement into the funding history. */
  async sync(userId: string, connectionId: string) {
    const c = await this.owned(userId, connectionId);
    let added = 0;
    for (const kind of ['deposit', 'withdrawal', 'transfer'] as const) {
      for (const row of await this.statement(c, kind, 100)) {
        if (!row.reference) continue;
        const type = TYPE_OF[kind] ?? (row.amount < 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN');
        const r = await FundingTransactionModel.updateOne(
          { provider: 'deriv', accountId: c.accountId, reference: row.reference },
          { $set: { status: 'COMPLETED', verifiedAt: new Date(), occurredAt: new Date(row.time), description: row.description }, $setOnInsert: { user: userId, connection: c._id, type, amount: Math.abs(row.amount), currency: c.currency, source: 'statement' } },
          { upsert: true },
        );
        added += r.upsertedCount;
      }
    }
    // Re-check transfers started here that are not confirmed yet.
    for (const p of await FundingTransactionModel.find({ user: userId, connection: c._id, status: { $in: ['PENDING', 'UNKNOWN'] } })) await this.verify(userId, p._id.toString()).catch(() => undefined);
    publishBroker(userId, connectionId, 'funding', { synced: true });
    return { added, syncedAt: new Date() };
  }

  async history(userId: string, connectionId?: string) {
    return FundingTransactionModel.find({ user: userId, ...(connectionId ? { connection: connectionId } : {}) }).sort({ occurredAt: -1, createdAt: -1 }).limit(200).lean();
  }

  private notify(userId: string, tx: { status: string; type: string; amount: number; currency?: string | null; counterpartAccount?: string | null }) {
    publishBroker(userId, '', 'funding', { status: tx.status });
    void notificationService.notify('PAYMENT', `Deriv transfer ${tx.status.toLowerCase()}`, `${tx.amount} ${tx.currency ?? ''} to ${tx.counterpartAccount ?? ''}: ${tx.status}`);
  }
}

export const derivFunding = new DerivFundingService();
