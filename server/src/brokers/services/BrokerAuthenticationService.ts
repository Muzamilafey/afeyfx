import crypto from 'crypto';
import { env } from '../../config/env';
import { BrokerConnectionModel, type BrokerConnectionDoc } from '../../models/BrokerConnection';
import { BrokerOAuthStateModel } from '../../models/BrokerRecords';
import { AppError } from '../../utils/errors';
import { decrypt, encrypt } from '../../utils/crypto';
import { errorMessage } from '../../utils/logger';
import { DerivRest, type DerivAccount } from '../deriv/DerivApi';
import { BrokerError, type BrokerSecrets } from '../core/types';

/**
 * Broker authorization:
 *  - Deriv: OAuth 2.0 authorization code + PKCE (preferred). The code exchange happens on the
 *    server; the PKCE verifier and state never reach the browser. Personal Access Token + App ID
 *    as a fallback when the admin allows it.
 *  - MT5: a per-connection terminal id + HMAC secret for the bridge EA (shown once).
 * Tokens are encrypted at rest and only decrypted in memory for API calls.
 */
const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();
const hashHex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
let fetchImpl: FetchFn = (url, init) => fetch(url, init) as never;
export function setBrokerAuthFetch(f: FetchFn | null) {
  fetchImpl = f ?? ((url, init) => fetch(url, init) as never);
}

const publicApiBase = () => (env.API_PUBLIC_URL || env.APP_URL || env.CLIENT_ORIGIN.split(',')[0]).replace(/\/+$/, '');
export const derivRedirectUri = () => `${publicApiBase()}/api/brokers/deriv/callback`;
export const appUrl = () => (env.APP_URL || env.CLIENT_ORIGIN.split(',')[0]).replace(/\/+$/, '');

export function derivScopes() {
  const scopes = env.DERIV_OAUTH_SCOPES.split(/[\s,]+/).filter(Boolean);
  // Trading-only access: never request payment / cashier scopes.
  const safe = scopes.filter((s) => !/payment|cashier|withdraw|transfer/i.test(s));
  return safe.length ? safe : ['trade'];
}

/** Scopes for the separate funding authorization (never used by trading code). */
export function fundingScopes() {
  const s = env.DERIV_FUNDING_SCOPES.split(/[\s,]+/).filter(Boolean);
  return s.length ? s : ['payments'];
}

export class BrokerAuthenticationService {
  secrets(c: BrokerConnectionDoc): BrokerSecrets {
    const dec = (v?: string | null) => {
      if (!v) return undefined;
      try {
        return decrypt(v);
      } catch {
        return undefined;
      }
    };
    return { accessToken: dec(c.accessTokenEnc), refreshToken: dec(c.refreshTokenEnc), tokenType: (c.tokenType === 'pat' ? 'pat' : 'oauth') as 'pat' | 'oauth', appId: c.appId ?? (env.DERIV_APP_ID || undefined), terminalSecret: dec(c.terminalSecretEnc) };
  }

  // ------------------------------------------------------------ Deriv OAuth

  derivOAuthConfigured() {
    return !!env.DERIV_CLIENT_ID;
  }

  /**
   * Start OAuth: returns the Deriv authorization URL and a browser-binding value for a cookie.
   * purpose 'funding' asks for the separate payments-scope authorization (opt-in, personal use).
   */
  async startDerivOAuth(userId: string, purpose: 'trading' | 'funding' = 'trading') {
    if (!this.derivOAuthConfigured()) throw new AppError(409, 'Deriv OAuth is not configured (DERIV_CLIENT_ID)', 'DERIV_NOT_CONFIGURED');
    if (purpose === 'funding' && !env.DERIV_FUNDING_ENABLED) throw new AppError(403, 'Funding is not enabled (DERIV_FUNDING_ENABLED)', 'FUNDING_DISABLED');
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const binding = b64url(crypto.randomBytes(24));
    await BrokerOAuthStateModel.create({ state, user: userId, provider: 'deriv', purpose, codeVerifierEnc: encrypt(verifier), browserBindingHash: hashHex(binding), expiresAt: new Date(Date.now() + 10 * 60_000) });
    const u = new URL(env.DERIV_AUTH_URL);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', env.DERIV_CLIENT_ID);
    u.searchParams.set('redirect_uri', derivRedirectUri());
    u.searchParams.set('scope', (purpose === 'funding' ? fundingScopes() : derivScopes()).join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', b64url(sha256(verifier)));
    u.searchParams.set('code_challenge_method', 'S256');
    return { authorizeUrl: u.toString(), binding };
  }

  /** Complete OAuth (callback): verifies state + browser binding, exchanges the code, returns tokens. */
  async completeDerivOAuth(state: string, code: string, binding: string | undefined) {
    const st = await BrokerOAuthStateModel.findOneAndDelete({ state, provider: 'deriv' }); // single use
    if (!st || st.expiresAt.getTime() < Date.now()) throw new AppError(400, 'This authorization link expired. Start again.', 'OAUTH_STATE_INVALID');
    const a = Buffer.from(hashHex(binding ?? ''));
    const b = Buffer.from(st.browserBindingHash);
    if (!binding || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AppError(400, 'Authorization was started in a different browser', 'OAUTH_STATE_INVALID');
    const purpose = (st.purpose === 'funding' ? 'funding' : 'trading') as 'trading' | 'funding';
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, client_id: env.DERIV_CLIENT_ID, redirect_uri: derivRedirectUri(), code_verifier: decrypt(st.codeVerifierEnc) }, purpose === 'funding');
    return { userId: st.user.toString(), tokens, purpose };
  }

  async tokenRequest(body: Record<string, string>, allowPayments = false) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    let r;
    try {
      r = await fetchImpl(env.DERIV_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body).toString(), signal: ctl.signal });
    } catch (err) {
      throw new AppError(502, `Deriv authorization server unreachable: ${errorMessage(err)}`, 'DERIV_UNREACHABLE');
    } finally {
      clearTimeout(t);
    }
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!r.ok || !j.access_token) throw new AppError(400, `Deriv authorization failed: ${j.error_description ?? j.error ?? `HTTP ${r.status}`}`, 'DERIV_AUTH_FAILED');
    // Trading tokens must never carry payment permissions; only the separate funding flow may.
    if (!allowPayments && /payment/i.test(j.scope ?? '')) throw new AppError(400, 'Deriv granted a payment scope; refusing (trading access only)', 'DERIV_SCOPE');
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : undefined, scopes: (j.scope ?? (allowPayments ? fundingScopes() : derivScopes()).join(' ')).split(/\s+/).filter(Boolean) };
  }

  /** Create/refresh one connection per Deriv account available to the authorization. */
  async upsertDerivConnections(userId: string, auth: { accessToken: string; refreshToken?: string; expiresAt?: Date; scopes?: string[]; tokenType: 'oauth' | 'pat'; appId?: string }) {
    const rest = new DerivRest(auth.accessToken, auth.tokenType, auth.appId, env.DERIV_API_BASE);
    let accounts: DerivAccount[];
    try {
      accounts = await rest.listAccounts();
    } catch (err) {
      throw new AppError(400, `Could not read your Deriv accounts: ${errorMessage(err)}`, 'DERIV_ACCOUNTS');
    }
    if (!accounts.length) throw new AppError(400, 'No Deriv accounts are available to this authorization', 'DERIV_ACCOUNTS');
    const out: BrokerConnectionDoc[] = [];
    // All accounts reached through one authorization share its tokens (refreshed together).
    const authGroup = crypto.randomUUID();
    const accessTokenEnc = encrypt(auth.accessToken);
    const refreshTokenEnc = auth.refreshToken ? encrypt(auth.refreshToken) : undefined;
    for (const a of accounts) {
      const environment = a.account_type === 'real' ? 'real' : 'demo';
      const set = {
        environment,
        currency: a.currency,
        balance: Number(a.balance),
        accessTokenEnc,
        refreshTokenEnc,
        authGroup,
        tokenType: auth.tokenType,
        tokenExpiresAt: auth.expiresAt,
        scopes: auth.scopes ?? [],
        appId: auth.appId,
        status: 'PENDING',
        lastError: undefined,
      };
      const doc = await BrokerConnectionModel.findOneAndUpdate(
        { user: userId, provider: 'deriv', accountId: String(a.account_id) },
        { $set: set, $setOnInsert: { user: userId, provider: 'deriv', accountId: String(a.account_id), label: `Deriv ${environment === 'demo' ? 'Demo' : 'Real'} ${a.currency}`, tradingEnabled: false, liveEnabled: false } },
        { upsert: true, returnDocument: 'after' },
      );
      // A connection's account type is fixed: if Deriv now says otherwise, trading stops.
      if (doc!.environment !== environment) {
        doc!.tradingEnabled = false;
        doc!.liveEnabled = false;
        doc!.status = 'ERROR';
        doc!.lastError = 'Account type changed at Deriv';
        await doc!.save();
      }
      out.push(doc!);
    }
    return out;
  }

  async connectDerivWithToken(userId: string, token: string, appId?: string) {
    if (!env.DERIV_ALLOW_PAT) throw new AppError(403, 'Token connections are disabled; use Connect with Deriv', 'PAT_DISABLED');
    const id = appId || env.DERIV_APP_ID;
    if (!id) throw new AppError(400, 'A Deriv App ID is required with a Personal Access Token', 'APP_ID_REQUIRED');
    return this.upsertDerivConnections(userId, { accessToken: token.trim(), tokenType: 'pat', appId: id });
  }

  /**
   * Make sure the stored token is usable: refresh it if expired and a refresh token exists,
   * otherwise mark the connection REAUTH_REQUIRED.
   */
  async ensureFreshToken(c: BrokerConnectionDoc) {
    if (c.provider !== 'deriv' || c.tokenType !== 'oauth' || !c.tokenExpiresAt) return;
    if (c.tokenExpiresAt.getTime() - Date.now() > 60_000) return;
    const s = this.secrets(c);
    if (!s.refreshToken) {
      c.status = 'REAUTH_REQUIRED';
      await c.save();
      throw new BrokerError('auth_expired', 'Deriv authorization expired; reconnect the account');
    }
    try {
      const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: env.DERIV_CLIENT_ID });
      const $set = { accessTokenEnc: encrypt(t.accessToken), refreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken) : c.refreshTokenEnc, tokenExpiresAt: t.expiresAt };
      await BrokerConnectionModel.updateMany({ user: c.user, provider: 'deriv', authGroup: c.authGroup }, { $set });
      c.set($set);
    } catch (err) {
      c.status = 'REAUTH_REQUIRED';
      c.lastError = errorMessage(err);
      await c.save();
      throw new BrokerError('auth_expired', 'Deriv token refresh failed; reconnect the account');
    }
  }

  // ------------------------------------------------------------ MT5 terminal credentials

  /** New terminal id + secret (the secret is returned ONCE and stored encrypted). */
  issueTerminalCredentials() {
    const terminalId = `afx_${crypto.randomBytes(9).toString('hex')}`;
    const terminalSecret = b64url(crypto.randomBytes(32));
    return { terminalId, terminalSecret, terminalSecretEnc: encrypt(terminalSecret) };
  }
}

export const brokerAuth = new BrokerAuthenticationService();
