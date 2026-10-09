import type { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env, isLiveTradingEnabledByEnv } from '../config/env';
import { brokerService } from '../brokers/BrokerService';
import { forexAvailable } from '../marketData/instruments';
import { forexDataService } from '../marketData/ForexDataService';
import { OandaClient } from '../marketData/OandaClient';
import { notificationService } from '../notifications/NotificationService';
import { paymentService } from '../payments/PaymentService';
import { audit } from '../services/AuditService';
import { INTEGRATION_GROUPS, integrationService } from '../services/IntegrationService';
import { googleCallbackUrl } from '../services/GoogleAuthService';
import { githubCallbackUrl } from '../services/GitHubAuthService';
import { emailHtml, mailService } from '../services/MailService';
import { newsService } from '../services/news/NewsService';
import { AppError } from '../utils/errors';
import { errorMessage } from '../utils/logger';
import { eventBus } from '../utils/eventBus';

const keys = INTEGRATION_GROUPS.flatMap((g) => g.fields.map((f) => f.key)) as [string, ...string[]];

export const integrationSchemas = {
  update: z.object({
    values: z.partialRecord(z.enum(keys), z.union([z.string().max(2000), z.boolean(), z.number()])).default({}),
    reset: z.array(z.enum(keys)).max(50).default([]),
    totp: z.string().optional(),
    emailCode: z.string().optional(),
  }),
  deriv: z.object({
    appId: z.string().regex(/^\d{1,10}$/).optional(),
    accountId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
    token: z.string().max(200).optional(),
    currency: z.literal('USD').optional(),
    multipliers: z.object({ crypto: z.number().int().min(1).max(1000), forex: z.number().int().min(1).max(1000), metals: z.number().int().min(1).max(1000) }).partial().optional(),
    totp: z.string().optional(),
    emailCode: z.string().optional(),
  }),
  route: z.object({ category: z.enum(['crypto', 'forex', 'metals']), route: z.enum(['internal', 'deriv', 'oanda']), totp: z.string().optional(), emailCode: z.string().optional() }),
};

/** Bootstrap / safety settings that can only be set in the server environment. */
const ENV_ONLY = [
  { key: 'MONGODB_URI', why: 'Needed before the database (where console settings live) is reachable' },
  { key: 'JWT_SECRET / JWT_REFRESH_SECRET', why: 'Session signing keys' },
  { key: 'ENCRYPTION_KEY', why: 'Encrypts the secrets saved on this page' },
  { key: 'LIVE_TRADING_ENABLED', why: 'Hard kill switch for any real external order - never settable from the UI' },
  { key: 'MARKET_DATA_SOURCE', why: 'Simulated data must never be switched on in production' },
  { key: 'CLIENT_ORIGIN / PORT / NODE_ENV / COOKIE_SECURE', why: 'Server and security configuration' },
];

export const integrationController = {
  async get(_req: Request, res: Response) {
    res.json({
      groups: integrationService.view(),
      envOnly: ENV_ONLY.map((e) => ({ ...e, set: e.key.split(' / ').every((k) => !!(env as Record<string, unknown>)[k]) })),
      callbacks: { google: googleCallbackUrl(), github: githubCallbackUrl() },
      liveTradingEnabledByEnv: isLiveTradingEnabledByEnv(),
    });
  },

  async update(req: Request, res: Response) {
    const b = req.body as z.infer<typeof integrationSchemas.update>;
    const changed = await integrationService.update(b.values, b.reset, req.user!.id);
    eventBus.publish('system', { kind: 'features' });
    await audit(req, { action: 'INTEGRATIONS_UPDATED', details: { changed } });
    res.json({ changed, groups: integrationService.view() });
  },

  /** Live connectivity checks; nothing secret is returned. */
  async test(req: Request, res: Response) {
    const id = String(req.params.id);
    let r: { ok: boolean; message: string };
    try {
      if (id === 'email') {
        if (!mailService.configured) throw new Error('SMTP host is not set');
        await mailService.send({ to: req.user!.email, subject: 'AfeyFX: test email', text: 'SMTP is working.', html: emailHtml('Test email', 'SMTP is working.') });
        r = { ok: true, message: `Test email sent to ${req.user!.email}` };
      } else if (id === 'anthropic') {
        if (!env.ANTHROPIC_API_KEY) throw new Error('API key is not set');
        await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 15_000 }).models.list({ limit: 1 });
        r = { ok: true, message: 'Anthropic API key is valid' };
      } else if (id === 'telegram') {
        const t = await notificationService.telegram.send('AfeyFX: Telegram alerts are working.');
        r = { ok: t.ok, message: t.ok ? 'Test message sent' : (t.error ?? 'Failed') };
      } else if (id === 'oanda') {
        if (!env.OANDA_API_TOKEN || !env.OANDA_ACCOUNT_ID) throw new Error('API token and account ID are required');
        const p = await new OandaClient(env.OANDA_API_TOKEN, env.OANDA_ACCOUNT_ID, env.OANDA_ENV).pricing(['EUR_USD']);
        r = { ok: p.length > 0, message: p.length ? `EUR/USD ${p[0].bid} / ${p[0].ask}` : 'No prices returned' };
      } else if (id === 'news') {
        newsService.reconfigure();
        r = { ok: newsService.configured, message: newsService.configured ? 'Feeds configured' : 'Add at least one https feed URL and enable news' };
      } else if (id === 'google' || id === 'github') {
        const g = INTEGRATION_GROUPS.find((x) => x.id === id)!;
        r = { ok: integrationService.isConfigured(g), message: integrationService.isConfigured(g) ? 'Credentials set. Make sure the callback URL below is registered with the provider.' : 'Client ID and secret are required' };
      } else throw new AppError(404, 'Unknown integration');
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) throw err;
      r = { ok: false, message: errorMessage(err) };
    }
    await audit(req, { action: 'INTEGRATION_TESTED', resource: id, success: r.ok });
    res.json(r);
  },
};

/** Which features are available. The UI hides anything whose integration is not configured. */
export async function featuresController(_req: Request, res: Response) {
  const pay = await paymentService.publicConfig();
  res.json({
    ...integrationService.features(),
    forex: forexAvailable() && forexDataService.symbols.length > 0,
    deposits: pay.deposits.enabled,
    payouts: pay.payouts.enabled,
    realTrading: pay.realTradingEnabled,
    realAccount: pay.deposits.enabled || pay.payouts.enabled || pay.realTradingEnabled,
  });
}

export const brokerController = {
  async get(_req: Request, res: Response) {
    res.json(await brokerService.view());
  },
  async updateDeriv(req: Request, res: Response) {
    const { totp: _t, emailCode: _e, ...b } = req.body as z.infer<typeof integrationSchemas.deriv>;
    const v = await brokerService.updateDeriv(b, req.user!.id);
    await audit(req, { action: 'BROKER_CONFIG_UPDATED', resource: 'deriv', details: { appId: b.appId, tokenChanged: !!b.token, multipliers: b.multipliers } });
    res.json(v);
  },
  async test(req: Request, res: Response) {
    const id = String(req.params.id);
    if (id !== 'deriv' && id !== 'oanda') throw new AppError(404, 'Unknown broker');
    const r = await brokerService.test(id);
    await audit(req, { action: 'BROKER_TESTED', resource: id, success: r.ok });
    res.json(r);
  },
  async setRoute(req: Request, res: Response) {
    const b = req.body as z.infer<typeof integrationSchemas.route>;
    const v = await brokerService.setRoute(b.category, b.route, req.user!.id);
    await audit(req, { action: 'BROKER_ROUTE_CHANGED', details: { category: b.category, route: b.route } });
    res.json(v);
  },
};
