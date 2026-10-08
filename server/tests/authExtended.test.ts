import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { mailService, type MailMessage } from '../src/services/MailService';
import { googleAuthService } from '../src/services/GoogleAuthService';
import { githubAuthService } from '../src/services/GitHubAuthService';
import { User } from '../src/models/User';
import { EmailTokenModel } from '../src/models/EmailToken';
import { AppError } from '../src/utils/errors';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { reloadEnv } from '../src/config/env';
import { makeUser, PASSWORD } from './helpers/api';

const app = createApp();
let outbox: MailMessage[] = [];
const lastCode = () => outbox[outbox.length - 1].text.match(/\b(\d{6})\b/)![1];
const lastLink = () => new URL(outbox[outbox.length - 1].text.match(/https?:\/\/\S+/)![0]);

beforeAll(connectTestDb);
afterAll(async () => {
  mailService.setSender(null);
  googleAuthService.setVerifier(null);
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearDb();
  outbox = [];
  mailService.setSender(async (m) => void outbox.push(m));
  googleAuthService.setVerifier(null);
  tradingState.reset();
  circuitBreaker.resetAll();
});

/** Make the cooldown window pass so another code can be requested. */
const skipCooldown = () => EmailTokenModel.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 60_000) } });

describe('email verification', () => {
  it('registration sends a verification link; the link verifies the address once', async () => {
    const r = await request(app).post('/api/auth/register').send({ email: 'boss@x.io', name: 'Boss', password: PASSWORD });
    expect(r.body.user.emailVerified).toBe(false);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe('boss@x.io');
    const link = lastLink();
    expect(link.pathname).toBe('/verify-email');
    const body = { uid: link.searchParams.get('uid'), token: link.searchParams.get('token') };
    expect((await request(app).post('/api/auth/verify-email').send(body)).status).toBe(200);
    expect((await User.findOne({ email: 'boss@x.io' }))!.emailVerified).toBe(true);
    expect((await request(app).post('/api/auth/verify-email').send(body)).status).toBe(400); // single use
  });

  it('rejects forged or cross-user tokens', async () => {
    await request(app).post('/api/auth/register').send({ email: 'boss@x.io', name: 'Boss', password: PASSWORD });
    const link = lastLink();
    const other = await User.create({ email: 'o@x.io', name: 'o' });
    expect((await request(app).post('/api/auth/verify-email').send({ uid: other._id.toString(), token: link.searchParams.get('token') })).status).toBe(400);
    expect((await request(app).post('/api/auth/verify-email').send({ uid: link.searchParams.get('uid'), token: 'x'.repeat(43) })).status).toBe(400);
  });

  it('unverified users can read but cannot trade or administer; a refreshed token picks up verification', async () => {
    const { auth } = await makeUser(app, 't@x.io', 'trader', false, false);
    expect((await request(app).get('/api/account').set(auth)).status).toBe(200);
    const r = await request(app).post('/api/account/orders').set(auth).send({ symbol: 'BTC/USDT', direction: 'LONG', investment: 100 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    const login = await request(app).post('/api/auth/login').send({ email: 't@x.io', password: PASSWORD });
    const cookie = ([] as string[]).concat(login.headers['set-cookie']).find((c) => c.startsWith('afx_rt='))!;
    await request(app).post('/api/auth/resend-verification').set('Authorization', `Bearer ${login.body.accessToken}`);
    const link = lastLink();
    await request(app).post('/api/auth/verify-email').send({ uid: link.searchParams.get('uid'), token: link.searchParams.get('token') });
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(refreshed.body.user.emailVerified).toBe(true);
    const ok = await request(app).post('/api/account/orders').set('Authorization', `Bearer ${refreshed.body.accessToken}`).send({ symbol: 'BTC/USDT', direction: 'LONG', investment: 100 });
    expect(ok.status).toBe(409); // passes the verification gate; fails only because there is no market data in tests
    expect(ok.body.error.code).toBe('NO_MARKET_DATA');
  });

  it('enforces a resend cooldown', async () => {
    const { auth } = await makeUser(app, 'v@x.io', 'viewer', false, false);
    expect((await request(app).post('/api/auth/resend-verification').set(auth)).status).toBe(200);
    expect((await request(app).post('/api/auth/resend-verification').set(auth)).status).toBe(429);
  });
});

describe('email codes as a second factor', () => {
  async function enableEmail2fa(email: string, role: 'admin' | 'trader' = 'admin') {
    const { auth } = await makeUser(app, email, role);
    await request(app).post('/api/auth/2fa/email/send').set(auth).send({ context: 'enable email codes' });
    const r = await request(app).post('/api/auth/2fa/email/enable').set(auth).send({ code: lastCode() });
    expect(r.status).toBe(200);
    expect((await User.findOne({ email }))!.emailOtpEnabled).toBe(true);
  }

  it('cannot be enabled without a verified email', async () => {
    const { auth } = await makeUser(app, 'u@x.io', 'trader', false, false);
    expect((await request(app).post('/api/auth/2fa/email/send').set(auth).send({})).status).toBe(403);
  });

  it('login requires the emailed code; codes are single-use and wrong codes fail', async () => {
    await enableEmail2fa('a@x.io');
    const login = await request(app).post('/api/auth/login').send({ email: 'a@x.io', password: PASSWORD });
    expect(login.body.requires2fa).toBe(true);
    expect(login.body.methods).toEqual(['email']);
    await skipCooldown();
    expect((await request(app).post('/api/auth/2fa/email/send-login').send({ challengeToken: login.body.challengeToken })).status).toBe(200);
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await request(app).post('/api/auth/2fa/verify').send({ challengeToken: login.body.challengeToken, code: wrong, method: 'email' })).status).toBe(401);
    const ok = await request(app).post('/api/auth/2fa/verify').send({ challengeToken: login.body.challengeToken, code, method: 'email' });
    expect(ok.body.accessToken).toBeTruthy();
    expect((await request(app).post('/api/auth/2fa/verify').send({ challengeToken: login.body.challengeToken, code, method: 'email' })).status).toBe(401); // replay
  });

  it('locks a code after 5 wrong attempts', async () => {
    await enableEmail2fa('a@x.io');
    const login = await request(app).post('/api/auth/login').send({ email: 'a@x.io', password: PASSWORD });
    await skipCooldown();
    await request(app).post('/api/auth/2fa/email/send-login').send({ challengeToken: login.body.challengeToken });
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/2fa/verify').send({ challengeToken: login.body.challengeToken, code: wrong, method: 'email' });
    expect((await request(app).post('/api/auth/2fa/verify').send({ challengeToken: login.body.challengeToken, code, method: 'email' })).status).toBe(401);
  });

  it('protected actions accept a single-use emailed code', async () => {
    await enableEmail2fa('a@x.io');
    const login = await request(app).post('/api/auth/login').send({ email: 'a@x.io', password: PASSWORD });
    await skipCooldown();
    await request(app).post('/api/auth/2fa/email/send-login').send({ challengeToken: login.body.challengeToken });
    const session = await request(app).post('/api/auth/2fa/verify').send({ challengeToken: login.body.challengeToken, code: lastCode(), method: 'email' });
    const auth = { Authorization: `Bearer ${session.body.accessToken}` };
    expect((await request(app).post('/api/system/emergency/stop-new-trades').set(auth).send({ emailCode: '123456' })).status).toBe(401);
    await skipCooldown();
    await request(app).post('/api/auth/2fa/email/send').set(auth).send({ context: 'stop new trades' });
    const code = lastCode();
    expect(outbox[outbox.length - 1].text).toContain('stop new trades');
    expect((await request(app).post('/api/system/emergency/stop-new-trades').set(auth).send({ emailCode: code, reason: 'drill' })).status).toBe(200);
    expect(tradingState.get().tradingEnabled).toBe(false);
    expect((await request(app).post('/api/system/emergency/resume').set(auth).send({ emailCode: code })).status).toBe(401); // replay blocked
  });

  it('a login code cannot be used for a protected action (purpose-bound)', async () => {
    await enableEmail2fa('a@x.io');
    const login = await request(app).post('/api/auth/login').send({ email: 'a@x.io', password: PASSWORD });
    await skipCooldown();
    await request(app).post('/api/auth/2fa/email/send-login').send({ challengeToken: login.body.challengeToken });
    const loginCode = lastCode();
    const { auth } = await makeUser(app, 'b@x.io', 'admin', true);
    void auth;
    const u = await User.findOne({ email: 'a@x.io' });
    const { AuthService } = await import('../src/services/AuthService');
    expect(await AuthService.verifySecondFactor(u!._id.toString(), { emailCode: loginCode })).toBe(false);
  });

  it('authenticator re-enrolment cannot silently replace an active authenticator', async () => {
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const r = await request(app).post('/api/auth/2fa/setup').set(a.auth);
    expect(r.status).toBe(409);
    expect((await User.findOne({ email: 'a@x.io' }))!.twoFactorEnabled).toBe(true);
  });
});

describe('Continue with Google', () => {
  const asGoogle = (claims: Partial<{ sub: string; email: string; emailVerified: boolean; name: string }>) =>
    googleAuthService.setVerifier(async (cred) => {
      if (cred !== 'valid-google-id-token-xxxxxxxx') throw new AppError(401, 'Google sign-in failed', 'GOOGLE_INVALID');
      return { sub: 'g-123', email: 'g@x.io', emailVerified: true, name: 'G User', ...claims };
    });
  const google = () => request(app).post('/api/auth/google').send({ credential: 'valid-google-id-token-xxxxxxxx' });

  it('first-ever Google sign-in bootstraps a verified admin without a password', async () => {
    asGoogle({});
    const r = await google();
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('admin');
    expect(r.body.user.emailVerified).toBe(true);
    expect(r.body.user.passwordSet).toBe(false);
    // no password -> password login impossible
    expect((await request(app).post('/api/auth/login').send({ email: 'g@x.io', password: PASSWORD })).status).toBe(401);
  });

  it('rejects invalid tokens and unverified Google emails', async () => {
    asGoogle({ emailVerified: false });
    expect((await request(app).post('/api/auth/google').send({ credential: 'forged-token-xxxxxxxxxxxxxxx' })).status).toBe(401);
    const r = await google();
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('GOOGLE_EMAIL_UNVERIFIED');
  });

  it('links to an existing account by email and does NOT bypass 2FA', async () => {
    await makeUser(app, 'g@x.io', 'trader', true);
    asGoogle({});
    const r = await google();
    expect(r.body.requires2fa).toBe(true);
    expect(r.body.accessToken).toBeUndefined();
    expect((await User.findOne({ email: 'g@x.io' }))!.googleId).toBe('g-123');
  });

  it('new Google users become verified traders (with public sign-up on) and are refused when it is off', async () => {
    await makeUser(app, 'someone@x.io', 'admin');
    asGoogle({ email: 'new@x.io', sub: 'g-999' });
    const r = await google();
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('trader');
    expect(r.body.user.emailVerified).toBe(true);
    process.env.ALLOW_PUBLIC_SIGNUP = 'false';
    reloadEnv();
    try {
      asGoogle({ email: 'other@x.io', sub: 'g-777' });
      const closed = await google();
      expect(closed.status).toBe(403);
      expect(closed.body.error.code).toBe('SIGNUP_CLOSED');
    } finally {
      delete process.env.ALLOW_PUBLIC_SIGNUP;
      reloadEnv();
    }
  });

  it('refuses a different Google account for an already-linked user', async () => {
    await User.create({ email: 'g@x.io', name: 'g', googleId: 'g-other', emailVerified: true });
    asGoogle({});
    expect((await google()).status).toBe(409);
  });

  it('Google-only users can set a password; existing passwords need the current one', async () => {
    asGoogle({});
    const s = await google();
    const auth = { Authorization: `Bearer ${s.body.accessToken}` };
    expect((await request(app).post('/api/auth/password').set(auth).send({ newPassword: 'weak' })).status).toBe(400);
    expect((await request(app).post('/api/auth/password').set(auth).send({ newPassword: 'BrandNewPass123' })).status).toBe(200);
    expect((await request(app).post('/api/auth/password').set(auth).send({ newPassword: 'AnotherPass1234' })).status).toBe(401);
    expect((await request(app).post('/api/auth/password').set(auth).send({ currentPassword: 'BrandNewPass123', newPassword: 'AnotherPass1234' })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email: 'g@x.io', password: 'AnotherPass1234' })).status).toBe(200);
  });

  it('public auth config exposes no secrets', async () => {
    const r = await request(app).get('/api/auth/config');
    expect(Object.keys(r.body).sort()).toEqual(['emailEnabled', 'githubEnabled', 'googleClientId', 'googleEnabled', 'requireEmailVerification', 'signupEnabled']);
  });
});

describe('Continue with GitHub', () => {
  const ghUser = { id: 4242, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.example/octo' };
  let emails: { email: string; primary: boolean; verified: boolean }[] = [];
  const fakeFetch = (async (url: string) => {
    if (url.includes('login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'gho_test' }), { status: 200 });
    if (url.endsWith('/user')) return new Response(JSON.stringify(ghUser), { status: 200 });
    if (url.endsWith('/user/emails')) return new Response(JSON.stringify(emails), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  beforeEach(() => {
    process.env.GITHUB_CLIENT_ID = 'gh-client';
    process.env.GITHUB_CLIENT_SECRET = 'gh-secret-value';
    reloadEnv();
    githubAuthService.setFetch(fakeFetch);
    emails = [{ email: 'octo@x.io', primary: true, verified: true }];
  });
  afterAll(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    reloadEnv();
  });

  const start = async () => {
    const r = await request(app).get('/api/auth/github/start');
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(loc.host).toBe('github.com');
    expect(loc.searchParams.get('scope')).toBe('read:user user:email');
    const cookie = ([] as string[]).concat(r.headers['set-cookie']).find((c) => c.startsWith('afx_gh_state='))!;
    expect(cookie).toMatch(/HttpOnly/);
    return { state: loc.searchParams.get('state')!, cookie };
  };

  it('rejects a callback whose state does not match the browser cookie (CSRF)', async () => {
    const { cookie } = await start();
    const r = await request(app).get('/api/auth/github/callback?code=abc&state=forged').set('Cookie', cookie);
    expect(r.headers.location).toMatch(/\/login#error=OAUTH_STATE$/);
    expect(await User.countDocuments()).toBe(0);
  });

  it('signs in (creating the first user as admin) and hands the session over via cookie, never the URL', async () => {
    const { state, cookie } = await start();
    const r = await request(app).get(`/api/auth/github/callback?code=abc&state=${state}`).set('Cookie', cookie);
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/\/auth\/callback$/);
    expect(r.headers.location).not.toMatch(/token/i);
    const rt = ([] as string[]).concat(r.headers['set-cookie']).find((c) => c.startsWith('afx_rt='))!;
    const session = await request(app).post('/api/auth/refresh').set('Cookie', rt);
    expect(session.body.user).toMatchObject({ email: 'octo@x.io', role: 'admin', emailVerified: true, passwordSet: false });
    expect((await User.findOne({ email: 'octo@x.io' }))!.githubId).toBe('4242');
  });

  it('refuses GitHub accounts whose primary email is unverified', async () => {
    emails = [{ email: 'octo@x.io', primary: true, verified: false }];
    const { state, cookie } = await start();
    const r = await request(app).get(`/api/auth/github/callback?code=abc&state=${state}`).set('Cookie', cookie);
    expect(r.headers.location).toMatch(/#error=GITHUB_EMAIL_UNVERIFIED$/);
  });

  it('still requires 2FA; the challenge is delivered in the URL fragment only', async () => {
    await makeUser(app, 'octo@x.io', 'trader', true);
    const { state, cookie } = await start();
    const r = await request(app).get(`/api/auth/github/callback?code=abc&state=${state}`).set('Cookie', cookie);
    const loc = new URL(r.headers.location);
    expect(loc.pathname).toBe('/auth/callback');
    expect(loc.search).toBe('');
    expect(loc.hash).toMatch(/^#challenge=.+&methods=totp$/);
    expect(([] as string[]).concat(r.headers['set-cookie'] ?? []).some((c) => c.startsWith('afx_rt='))).toBe(false);
  });
});

