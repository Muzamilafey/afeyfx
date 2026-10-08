import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { env, reloadEnv } from '../src/config/env';
import { integrationService } from '../src/services/IntegrationService';
import { IntegrationSettingModel } from '../src/models/IntegrationSetting';
import { decrypt } from '../src/utils/crypto';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser } from './helpers/api';

const app = createApp();

beforeAll(connectTestDb);
afterAll(async () => {
  reloadEnv();
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearDb();
  reloadEnv();
  await integrationService.load();
});

describe('admin integrations', () => {
  it('only admins can read; saving needs a fresh second factor; secrets are encrypted and never returned', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    expect((await request(app).get('/api/admin/integrations').set(t.auth)).status).toBe(403);
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const body = { values: { GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-supersecretvalue', ANTHROPIC_API_KEY: 'sk-ant-test-key-1234567890' } };
    expect((await request(app).put('/api/admin/integrations').set(a.auth).send(body)).status).toBe(401);
    const r = await request(app).put('/api/admin/integrations').set(a.auth).send({ ...body, totp: a.code() });
    expect(r.status).toBe(200);
    const json = JSON.stringify(r.body);
    expect(json).not.toContain('GOCSPX-supersecretvalue');
    expect(json).not.toContain('sk-ant-test-key-1234567890');
    const google = r.body.groups.find((g: { id: string }) => g.id === 'google');
    expect(google.configured).toBe(true);
    const secretField = google.fields.find((f: { key: string }) => f.key === 'GOOGLE_CLIENT_SECRET');
    expect(secretField).toMatchObject({ set: true, source: 'admin' });
    expect(secretField.value).toBeUndefined();
    const doc = await IntegrationSettingModel.findOne({ key: 'GOOGLE_CLIENT_SECRET' });
    expect(doc!.value).toBeUndefined();
    expect(decrypt(doc!.valueEnc!)).toBe('GOCSPX-supersecretvalue');
    // Applied at runtime: the sign-in button appears without a restart.
    expect(env.GOOGLE_CLIENT_ID).toBe('123-abc.apps.googleusercontent.com');
    expect((await request(app).get('/api/auth/config')).body.googleRedirectEnabled).toBe(true);
    expect((await request(app).get('/api/features').set(t.auth)).body).toMatchObject({ googleSignIn: true, ai: true, githubSignIn: false, telegram: false });
  });

  it('features stay hidden until their keys are set; reset returns to the .env value', async () => {
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const f0 = (await request(app).get('/api/features').set(a.auth)).body;
    expect(f0).toMatchObject({ googleSignIn: false, githubSignIn: false, ai: false, telegram: false, forex: false, deposits: false, payouts: false, realAccount: false });
    expect((await request(app).get('/api/auth/config')).body).toMatchObject({ githubEnabled: false, googleEnabled: false });
    await request(app).put('/api/admin/integrations').set(a.auth).send({ values: { GITHUB_CLIENT_ID: 'Iv1.abc', GITHUB_CLIENT_SECRET: 'shh-secret-123456' }, totp: a.code() });
    expect((await request(app).get('/api/auth/config')).body.githubEnabled).toBe(true);
    await request(app).put('/api/admin/integrations').set(a.auth).send({ reset: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'], totp: a.code() });
    expect((await request(app).get('/api/auth/config')).body.githubEnabled).toBe(false);
    // Settings survive a restart (reloaded from the database)
    await request(app).put('/api/admin/integrations').set(a.auth).send({ values: { TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', TELEGRAM_CHAT_ID: '42' }, totp: a.code() });
    reloadEnv();
    expect(env.TELEGRAM_CHAT_ID).toBe('');
    await integrationService.load();
    expect(env.TELEGRAM_CHAT_ID).toBe('42');
  });

  it('validates values and refuses bootstrap/safety keys such as the live-trading kill switch', async () => {
    const a = await makeUser(app, 'a@x.io', 'admin', true);
    const put = (values: Record<string, unknown>) => request(app).put('/api/admin/integrations').set(a.auth).send({ values, totp: a.code() });
    expect((await put({ LIVE_TRADING_ENABLED: 'true' })).status).toBe(400);
    expect((await put({ ENCRYPTION_KEY: 'x' })).status).toBe(400);
    expect((await put({ MARKET_DATA_SOURCE: 'simulated' })).status).toBe(400);
    expect((await put({ SMTP_PORT: 'abc' })).status).toBe(400);
    expect((await put({ APP_URL: 'not a url' })).status).toBe(400);
    expect((await put({ OANDA_ENV: 'prod' })).status).toBe(400);
    expect((await put({ SMTP_HOST: 'smtp.x.io\nBCC: evil' })).status).toBe(400);
    const g = (await request(app).get('/api/admin/integrations').set(a.auth)).body;
    expect(g.envOnly.map((e: { key: string }) => e.key)).toContain('LIVE_TRADING_ENABLED');
  });
});
