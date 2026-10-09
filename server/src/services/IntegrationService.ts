import { env, type Env } from '../config/env';
import { IntegrationSettingModel } from '../models/IntegrationSetting';
import { AppError } from '../utils/errors';
import { decrypt, encrypt, mask } from '../utils/crypto';
import { errorMessage, logger } from '../utils/logger';

/**
 * Admin-managed integrations. Every key below can be set either in .env or from the admin
 * console (Integrations page); a value saved in the console wins over .env. Saving is a protected
 * action (admin + fresh second factor) and secrets are encrypted at rest.
 *
 * Deliberately NOT editable here (bootstrap or safety settings that must stay in the server's
 * environment): MONGODB_URI, JWT secrets, ENCRYPTION_KEY (it protects these very secrets),
 * LIVE_TRADING_ENABLED (the hard live-trading kill switch), NODE_ENV, PORT, CLIENT_ORIGIN,
 * COOKIE_SECURE and MARKET_DATA_SOURCE. Exchange API keys are managed separately because they
 * must pass the withdrawal-permission check before they are accepted.
 */
type FieldType = 'string' | 'secret' | 'bool' | 'number' | 'url' | 'enum';
export interface IntegrationField {
  key: keyof Env & string;
  label: string;
  type: FieldType;
  options?: readonly string[];
  placeholder?: string;
  help?: string;
}
export interface IntegrationGroup {
  id: string;
  title: string;
  description: string;
  /** Feature that stays hidden until the required keys are set. */
  feature: string;
  required: (keyof Env & string)[];
  fields: IntegrationField[];
  docsUrl?: string;
}

export const INTEGRATION_GROUPS: IntegrationGroup[] = [
  {
    id: 'site',
    title: 'Site & sign-up',
    description: 'Public URLs used in emails and OAuth callbacks, and who may create an account.',
    feature: 'Email links, OAuth callbacks, public sign-up',
    required: [],
    fields: [
      { key: 'APP_URL', label: 'Public app URL', type: 'url', placeholder: 'https://trade.example.com' },
      { key: 'API_PUBLIC_URL', label: 'Public API URL (if different)', type: 'url', placeholder: 'https://trade.example.com' },
      { key: 'ALLOW_PUBLIC_SIGNUP', label: 'Allow public trader sign-up', type: 'bool' },
      { key: 'REQUIRE_EMAIL_VERIFICATION', label: 'Require verified email to trade', type: 'bool' },
    ],
  },
  {
    id: 'email',
    title: 'Email (SMTP)',
    description: 'Verification links, sign-in codes, deposit and withdrawal receipts.',
    feature: 'Email verification and email sign-in codes',
    required: ['SMTP_HOST'],
    fields: [
      { key: 'SMTP_HOST', label: 'SMTP host', type: 'string', placeholder: 'smtp.example.com' },
      { key: 'SMTP_PORT', label: 'Port', type: 'number', placeholder: '587' },
      { key: 'SMTP_SECURE', label: 'Implicit TLS (port 465)', type: 'bool' },
      { key: 'SMTP_USER', label: 'Username', type: 'string' },
      { key: 'SMTP_PASS', label: 'Password', type: 'secret' },
      { key: 'MAIL_FROM', label: 'From address', type: 'string', placeholder: 'AfeyFX <no-reply@example.com>' },
    ],
  },
  {
    id: 'google',
    title: 'Google sign-in',
    description: 'Shows "Continue with Google". Create an OAuth client (Web application) in Google Cloud Console.',
    feature: 'Continue with Google',
    required: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    fields: [
      { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', type: 'string', placeholder: '1234-abc.apps.googleusercontent.com' },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', type: 'secret' },
    ],
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    id: 'github',
    title: 'GitHub sign-in',
    description: 'Shows "Continue with GitHub". Create an OAuth App under GitHub Developer settings.',
    feature: 'Continue with GitHub',
    required: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    fields: [
      { key: 'GITHUB_CLIENT_ID', label: 'Client ID', type: 'string' },
      { key: 'GITHUB_CLIENT_SECRET', label: 'Client secret', type: 'secret' },
    ],
    docsUrl: 'https://github.com/settings/developers',
  },
  {
    id: 'anthropic',
    title: 'Claude AI analysis',
    description: 'Structured market analysis and strategy reviews. Claude can only veto trades; it never places orders.',
    feature: 'AI analysis, AI pages and AI veto',
    required: ['ANTHROPIC_API_KEY'],
    fields: [
      { key: 'ANTHROPIC_API_KEY', label: 'API key', type: 'secret', placeholder: 'sk-ant-…' },
      { key: 'AI_MODEL', label: 'Model', type: 'string', placeholder: 'claude-opus-5-5' },
      { key: 'AI_EFFORT', label: 'Effort', type: 'enum', options: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ],
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'telegram',
    title: 'Telegram alerts',
    description: 'Trade, risk, payment and emergency alerts to a Telegram chat.',
    feature: 'Telegram notifications',
    required: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
    fields: [
      { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot token', type: 'secret', placeholder: '123456:ABC…' },
      { key: 'TELEGRAM_CHAT_ID', label: 'Chat ID', type: 'string' },
    ],
  },
  {
    id: 'oanda',
    title: 'Forex & metals prices (OANDA)',
    description: 'Live EUR/USD, GBP/USD, USD/JPY and 40+ other pairs plus gold and silver. Read-only pricing: no orders are ever sent to OANDA.',
    feature: 'Forex and metals markets',
    required: ['OANDA_API_TOKEN', 'OANDA_ACCOUNT_ID'],
    fields: [
      { key: 'FOREX_ENABLED', label: 'Offer forex & metals', type: 'bool' },
      { key: 'OANDA_API_TOKEN', label: 'API token', type: 'secret' },
      { key: 'OANDA_ACCOUNT_ID', label: 'Account ID', type: 'string', placeholder: '101-004-1234567-001' },
      { key: 'OANDA_ENV', label: 'Environment', type: 'enum', options: ['practice', 'live'] },
    ],
    docsUrl: 'https://www.oanda.com/demo-account/tpa/personal_token',
  },
  {
    id: 'deriv',
    title: 'Deriv broker connections',
    description: 'Lets traders connect their own Deriv demo/real accounts. Register an OAuth app at developers.deriv.com with the redirect URL shown below; scope "trade" only (never "payment").',
    feature: 'Connect Deriv',
    required: ['DERIV_CLIENT_ID'],
    fields: [
      { key: 'DERIV_CLIENT_ID', label: 'OAuth client ID', type: 'string' },
      { key: 'DERIV_APP_ID', label: 'App ID (for Personal Access Tokens)', type: 'string' },
      { key: 'DERIV_OAUTH_SCOPES', label: 'Scopes', type: 'string', placeholder: 'trade' },
      { key: 'DERIV_ALLOW_PAT', label: 'Allow Personal Access Token connections', type: 'bool' },
      { key: 'DERIV_FUNDING_ENABLED', label: 'Enable funding (separate payments-scope authorization; personal use)', type: 'bool' },
      { key: 'DERIV_FUNDING_SCOPES', label: 'Funding scopes', type: 'string', placeholder: 'payments' },
    ],
    docsUrl: 'https://developers.deriv.com/docs/intro/oauth/',
  },
  {
    id: 'mt5',
    title: 'MetaTrader 5 bridge',
    description: 'Lets traders connect MT5 accounts through the AfeyFX Bridge Expert Advisor running in their own terminal.',
    feature: 'Connect MT5',
    required: [],
    fields: [
      { key: 'MT5_BRIDGE_ENABLED', label: 'Enable the MT5 bridge', type: 'bool' },
      { key: 'BROKER_USER_LIVE_ALLOWED', label: 'Allow traders to enable LIVE trading on their own broker accounts (also needs LIVE_TRADING_ENABLED=true)', type: 'bool' },
    ],
  },
  {
    id: 'news',
    title: 'News feeds',
    description: 'Recent headlines from RSS/Atom feeds, used as context for AI analysis.',
    feature: 'News context for AI',
    required: ['NEWS_RSS_URLS'],
    fields: [
      { key: 'NEWS_ENABLED', label: 'Use news', type: 'bool' },
      { key: 'NEWS_RSS_URLS', label: 'Feed URLs (comma separated, https)', type: 'string' },
    ],
  },
];

const FIELDS = new Map(INTEGRATION_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f] as const)));

type Hook = () => void | Promise<void>;

export class IntegrationService {
  /** Values from the process environment, before any admin overrides. */
  private baseline: Partial<Env> = {};
  private stored = new Set<string>();
  private hooks: Hook[] = [];

  /** Services register a hook to rebuild clients when integration settings change. */
  onChange(h: Hook) {
    this.hooks.push(h);
  }

  private coerce(f: IntegrationField, raw: string): unknown {
    if (f.type === 'bool') return raw === 'true';
    if (f.type === 'number') return Number(raw);
    return raw;
  }

  private validate(f: IntegrationField, v: unknown): string {
    const s = String(v ?? '').trim();
    if (f.type === 'bool') {
      if (typeof v !== 'boolean') throw new AppError(400, `${f.label} must be on or off`, 'VALIDATION_ERROR');
      return String(v);
    }
    if (f.type === 'number' && (!/^\d{1,6}$/.test(s) || Number(s) < 1)) throw new AppError(400, `${f.label} must be a positive number`, 'VALIDATION_ERROR');
    if (f.type === 'url' && s && !/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(s)) throw new AppError(400, `${f.label} must be a URL`, 'VALIDATION_ERROR');
    if (f.type === 'enum' && !f.options!.includes(s)) throw new AppError(400, `${f.label} must be one of ${f.options!.join(', ')}`, 'VALIDATION_ERROR');
    if (s.length > 2000) throw new AppError(400, `${f.label} is too long`, 'VALIDATION_ERROR');
    if (/[\r\n]/.test(s)) throw new AppError(400, `${f.label} must be a single line`, 'VALIDATION_ERROR');
    return f.type === 'url' ? s.replace(/\/+$/, '') : s;
  }

  /** Load saved values and apply them over the environment. Call once at boot after the DB connects. */
  async load() {
    if (!Object.keys(this.baseline).length) for (const k of FIELDS.keys()) (this.baseline as Record<string, unknown>)[k] = env[k];
    const docs = await IntegrationSettingModel.find().lean();
    this.stored.clear();
    for (const d of docs) {
      const f = FIELDS.get(d.key as keyof Env & string);
      if (!f) continue;
      let raw: string;
      try {
        raw = f.type === 'secret' ? (d.valueEnc ? decrypt(d.valueEnc) : '') : (d.value ?? '');
      } catch (err) {
        logger.error({ key: d.key, err: errorMessage(err) }, 'Could not decrypt integration setting (ENCRYPTION_KEY changed?)');
        continue;
      }
      (env as Record<string, unknown>)[f.key] = this.coerce(f, raw);
      this.stored.add(f.key);
    }
  }

  private async runHooks() {
    for (const h of this.hooks) {
      try {
        await h();
      } catch (err) {
        logger.warn({ err: errorMessage(err) }, 'Integration reload hook failed');
      }
    }
  }

  isConfigured(group: IntegrationGroup) {
    return group.required.every((k) => {
      const v = env[k];
      return v !== undefined && v !== null && String(v) !== '';
    });
  }

  /** Admin view: values for plain fields, only masked hints for secrets, and where each value comes from. */
  view() {
    return INTEGRATION_GROUPS.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      feature: g.feature,
      docsUrl: g.docsUrl,
      configured: this.isConfigured(g),
      /** Some, but not all, required keys are set. */
      partial: !this.isConfigured(g) && g.required.some((k) => String(env[k] ?? '') !== ''),
      fields: g.fields.map((f) => {
        const v = env[f.key];
        const set = v !== undefined && v !== null && String(v) !== '';
        return {
          key: f.key,
          label: f.label,
          type: f.type,
          options: f.options,
          placeholder: f.placeholder,
          source: this.stored.has(f.key) ? 'admin' : set && String(this.baseline[f.key] ?? '') !== '' ? 'env' : 'unset',
          value: f.type === 'secret' ? undefined : v,
          hint: f.type === 'secret' && set ? mask(String(v)).slice(-8) : undefined,
          set,
        };
      }),
    }));
  }

  /**
   * Save values. A non-empty value is stored (secrets encrypted); for secrets an empty string keeps
   * the current value. `reset` removes the console override so the .env value applies again.
   */
  async update(values: Record<string, unknown>, reset: string[], adminId: string) {
    const changed: string[] = [];
    for (const [k, v] of Object.entries(values)) {
      const f = FIELDS.get(k as keyof Env & string);
      if (!f) throw new AppError(400, `Unknown setting: ${k}`, 'VALIDATION_ERROR');
      if (f.type === 'secret' && (v === '' || v === undefined || v === null)) continue;
      const clean = this.validate(f, v);
      await IntegrationSettingModel.updateOne({ key: k }, f.type === 'secret' ? { $set: { valueEnc: encrypt(clean), updatedBy: adminId }, $unset: { value: 1 } } : { $set: { value: clean, updatedBy: adminId }, $unset: { valueEnc: 1 } }, { upsert: true });
      (env as Record<string, unknown>)[f.key] = this.coerce(f, clean);
      this.stored.add(f.key);
      changed.push(k);
    }
    for (const k of reset) {
      const f = FIELDS.get(k as keyof Env & string);
      if (!f) throw new AppError(400, `Unknown setting: ${k}`, 'VALIDATION_ERROR');
      await IntegrationSettingModel.deleteOne({ key: k });
      (env as Record<string, unknown>)[f.key] = this.baseline[f.key];
      this.stored.delete(f.key);
      changed.push(`${k} (reset)`);
    }
    if (changed.length) await this.runHooks();
    return changed;
  }

  /** Feature switches for the UI: anything whose keys are missing is hidden. */
  features() {
    const g = (id: string) => this.isConfigured(INTEGRATION_GROUPS.find((x) => x.id === id)!);
    return {
      email: g('email'),
      googleSignIn: g('google'),
      githubSignIn: g('github'),
      ai: g('anthropic'),
      telegram: g('telegram'),
      news: g('news') && env.NEWS_ENABLED,
      derivConnect: g('deriv') || (env.DERIV_ALLOW_PAT && !!env.DERIV_APP_ID),
      mt5Connect: env.MT5_BRIDGE_ENABLED,
    };
  }
}

export const integrationService = new IntegrationService();
