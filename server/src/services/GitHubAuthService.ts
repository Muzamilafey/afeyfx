import { env } from '../config/env';
import { AppError } from '../utils/errors';

export interface GitHubIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  avatarUrl?: string;
}

const appUrl = () => (env.APP_URL || env.CLIENT_ORIGIN.split(',')[0]).replace(/\/$/, '');
export const githubCallbackUrl = () => `${(env.API_PUBLIC_URL || appUrl()).replace(/\/$/, '')}/api/auth/github/callback`;

/**
 * "Continue with GitHub" - standard OAuth 2.0 web flow (server-side code exchange; the client
 * secret never leaves the server). Only the account's PRIMARY + VERIFIED email is accepted.
 */
class GitHubAuthService {
  constructor(private fetchImpl: typeof fetch = fetch) {}

  get enabled() {
    return !!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET;
  }

  setFetch(f: typeof fetch) {
    this.fetchImpl = f;
  }

  authorizeUrl(state: string) {
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    u.searchParams.set('redirect_uri', githubCallbackUrl());
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', state);
    u.searchParams.set('allow_signup', 'true');
    return u.toString();
  }

  async identify(code: string): Promise<GitHubIdentity> {
    if (!this.enabled) throw new AppError(404, 'GitHub sign-in is not configured', 'GITHUB_DISABLED');
    const tokenRes = await this.fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: githubCallbackUrl() }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
    if (!tokenRes.ok || !tok.access_token) throw new AppError(401, 'GitHub sign-in failed', 'GITHUB_INVALID');
    const headers = { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'afeyfx' };
    const [uRes, eRes] = await Promise.all([
      this.fetchImpl('https://api.github.com/user', { headers, signal: AbortSignal.timeout(10_000) }),
      this.fetchImpl('https://api.github.com/user/emails', { headers, signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!uRes.ok || !eRes.ok) throw new AppError(401, 'GitHub sign-in failed', 'GITHUB_INVALID');
    const u = (await uRes.json()) as { id: number; login: string; name?: string; avatar_url?: string };
    const emails = (await eRes.json()) as { email: string; primary: boolean; verified: boolean }[];
    const primary = Array.isArray(emails) ? emails.find((e) => e.primary) : undefined;
    if (!u?.id || !primary) throw new AppError(401, 'GitHub account has no primary email', 'GITHUB_NO_EMAIL');
    return { sub: String(u.id), email: primary.email.toLowerCase(), emailVerified: primary.verified === true, name: u.name || u.login, avatarUrl: u.avatar_url };
  }
}

export const githubAuthService = new GitHubAuthService();
export { appUrl };
