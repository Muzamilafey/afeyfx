import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { AppError } from '../utils/errors';

const apiBase = () => (env.API_PUBLIC_URL || env.APP_URL || env.CLIENT_ORIGIN.split(',')[0]).replace(/\/$/, '');
export const googleCallbackUrl = () => `${apiBase()}/api/auth/google/callback`;

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

type Verifier = (credential: string) => Promise<GoogleIdentity>;

/**
 * Verifies Google Identity Services ID tokens ("Continue with Google"): signature against Google's
 * keys, audience = GOOGLE_CLIENT_ID, issuer and expiry. Tests inject a verifier.
 */
class GoogleAuthService {
  private client: OAuth2Client | null = null;
  /** Drop the cached verifier (after the client id changes). */
  reset() {
    this.client = null;
  }
  private override: Verifier | null = null;

  get enabled() {
    return !!env.GOOGLE_CLIENT_ID || !!this.override;
  }

  setVerifier(v: Verifier | null) {
    this.override = v;
  }

  private fetchImpl: typeof fetch = fetch;
  setFetch(f: typeof fetch) {
    this.fetchImpl = f;
  }

  /** Redirect (authorization-code) flow is available when the client secret is configured. */
  get redirectEnabled() {
    return !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET;
  }

  authorizeUrl(state: string) {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    u.searchParams.set('redirect_uri', googleCallbackUrl());
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    u.searchParams.set('prompt', 'select_account');
    return u.toString();
  }

  /** Exchange the authorization code server-side and verify the returned ID token. */
  async identify(code: string): Promise<GoogleIdentity> {
    if (!this.redirectEnabled) throw new AppError(404, 'Google sign-in is not configured', 'GOOGLE_DISABLED');
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: googleCallbackUrl(), grant_type: 'authorization_code' }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string };
    if (!res.ok || !body.id_token) throw new AppError(401, 'Google sign-in failed', 'GOOGLE_INVALID');
    return this.verify(body.id_token);
  }

  async verify(credential: string): Promise<GoogleIdentity> {
    if (this.override) return this.override(credential);
    if (!env.GOOGLE_CLIENT_ID) throw new AppError(404, 'Google sign-in is not configured', 'GOOGLE_DISABLED');
    this.client ??= new OAuth2Client(env.GOOGLE_CLIENT_ID);
    try {
      const ticket = await this.client.verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      if (!p?.sub || !p.email) throw new Error('missing claims');
      if (!['accounts.google.com', 'https://accounts.google.com'].includes(String(p.iss))) throw new Error('bad issuer');
      return { sub: p.sub, email: p.email.toLowerCase(), emailVerified: p.email_verified === true, name: p.name };
    } catch {
      throw new AppError(401, 'Google sign-in failed', 'GOOGLE_INVALID');
    }
  }
}

export const googleAuthService = new GoogleAuthService();
