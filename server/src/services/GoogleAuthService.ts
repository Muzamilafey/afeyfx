import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';
import { AppError } from '../utils/errors';

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
  private override: Verifier | null = null;

  get enabled() {
    return !!env.GOOGLE_CLIENT_ID || !!this.override;
  }

  setVerifier(v: Verifier | null) {
    this.override = v;
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
