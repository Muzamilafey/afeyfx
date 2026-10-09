import { env } from '../../config/env';
import { BrokerConnectionModel, type BrokerConnectionDoc } from '../../models/BrokerConnection';
import { BrokerEventModel } from '../../models/BrokerRecords';
import { errorMessage, logger } from '../../utils/logger';
import type { BrokerAdapter, BrokerProvider, BrokerStreamEvent } from '../core/types';
import { BrokerError } from '../core/types';
import { DerivConnectionAdapter } from '../deriv/DerivConnectionAdapter';
import { Mt5BridgeAdapter } from '../mt5/Mt5BridgeAdapter';
import { brokerAuth } from './BrokerAuthenticationService';

type Factory = (conn: BrokerConnectionDoc) => BrokerAdapter;
type Listener = (conn: { id: string; user: string; provider: BrokerProvider }, e: BrokerStreamEvent) => void;

/**
 * Creates and caches one live adapter per broker connection, and fans adapter stream events
 * (quotes, settlements, account updates, connection status) out to the broker services.
 */
export class BrokerRegistry {
  private adapters = new Map<string, { adapter: BrokerAdapter; off: () => void }>();
  private factories = new Map<BrokerProvider, Factory>();
  private listeners: Listener[] = [];

  /** Test hook: replace how adapters are built for a provider. */
  setFactory(provider: BrokerProvider, f: Factory | null) {
    if (f) this.factories.set(provider, f);
    else this.factories.delete(provider);
  }

  onEvent(l: Listener) {
    this.listeners.push(l);
  }

  private build(conn: BrokerConnectionDoc): BrokerAdapter {
    const custom = this.factories.get(conn.provider as BrokerProvider);
    if (custom) return custom(conn);
    if (conn.provider === 'deriv') {
      const s = brokerAuth.secrets(conn);
      if (!s.accessToken) throw new BrokerError('auth', 'No Deriv authorization stored; reconnect the account');
      return new DerivConnectionAdapter({ accountId: conn.accountId, environment: conn.environment as 'demo' | 'real', token: s.accessToken, tokenType: s.tokenType === 'pat' ? 'pat' : 'oauth', appId: s.appId, apiBase: env.DERIV_API_BASE });
    }
    return new Mt5BridgeAdapter(conn._id.toString(), conn.environment as 'demo' | 'real');
  }

  /** Live adapter for a connection (built, authorized and connected on first use). */
  async get(conn: BrokerConnectionDoc): Promise<BrokerAdapter> {
    const id = conn._id.toString();
    const hit = this.adapters.get(id);
    if (hit) return hit.adapter;
    await brokerAuth.ensureFreshToken(conn);
    const adapter = this.build(conn);
    const meta = { id, user: conn.user.toString(), provider: conn.provider as BrokerProvider };
    const off = adapter.onEvent((e) => {
      for (const l of this.listeners) {
        try {
          l(meta, e);
        } catch (err) {
          logger.warn({ err: errorMessage(err) }, 'Broker event listener failed');
        }
      }
    });
    this.adapters.set(id, { adapter, off });
    try {
      await adapter.connect();
    } catch (err) {
      off();
      this.adapters.delete(id);
      throw err;
    }
    return adapter;
  }

  peek(connectionId: string) {
    return this.adapters.get(connectionId)?.adapter;
  }

  async drop(connectionId: string) {
    const hit = this.adapters.get(connectionId);
    this.adapters.delete(connectionId);
    if (!hit) return;
    hit.off();
    await hit.adapter.disconnect().catch(() => undefined);
  }

  async dropAll() {
    for (const id of [...this.adapters.keys()]) await this.drop(id);
  }

  ids() {
    return [...this.adapters.keys()];
  }
}

export const brokerRegistry = new BrokerRegistry();

/** Append to a connection's user-visible log (never includes secrets). */
export async function logBrokerEvent(conn: { _id: unknown; user: unknown }, type: string, message: string, data?: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') {
  await BrokerEventModel.create({ connection: conn._id as never, user: conn.user as never, type, level, message: message.slice(0, 500), data, at: new Date() }).catch(() => undefined);
}

/** Record a failure on a connection (and the error the user should see). */
export async function recordConnectionError(conn: BrokerConnectionDoc, err: unknown) {
  const kind = err instanceof BrokerError ? err.kind : 'error';
  const status = kind === 'auth_expired' ? 'REAUTH_REQUIRED' : kind === 'auth' ? 'ERROR' : kind === 'disconnected' ? 'DISCONNECTED' : conn.status;
  await BrokerConnectionModel.updateOne({ _id: conn._id }, { $set: { lastError: errorMessage(err).slice(0, 300), lastErrorAt: new Date(), status } });
}
