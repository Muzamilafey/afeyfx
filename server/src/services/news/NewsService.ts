import { env } from '../../config/env';
import { errorMessage, logger } from '../../utils/logger';

export interface NewsItem {
  title: string;
  source: string;
  publishedAt: string;
  url?: string;
}

const ALIASES: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc'],
  ETH: ['ethereum', 'ether', 'eth'],
  SOL: ['solana', 'sol'],
  XRP: ['xrp', 'ripple'],
  BNB: ['bnb', 'binance coin'],
  ADA: ['cardano', 'ada'],
  DOGE: ['dogecoin', 'doge'],
};
const MARKET_WIDE = ['crypto', 'cryptocurrency', 'sec ', 'etf', 'stablecoin', 'federal reserve', 'interest rate', 'exchange hack', 'regulation'];

const decodeEntities = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * News text is untrusted input: strip markup and control characters, collapse whitespace, cap length.
 * It is passed to Claude as data (the system prompt says so), never as instructions.
 */
export function sanitizeHeadline(s: string, max = 200) {
  return decodeEntities(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : undefined;
};

/** Minimal RSS 2.0 / Atom parser (titles, dates, links only). */
export function parseFeed(xml: string, source: string): NewsItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: NewsItem[] = [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    const date = tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date');
    const link = tag(b, 'link') ?? b.match(/<link[^>]*href="([^"]+)"/i)?.[1];
    const t = date ? Date.parse(decodeEntities(date).trim()) : NaN;
    if (!title || !Number.isFinite(t)) continue; // undated news is unreliable for trading context
    out.push({ title: sanitizeHeadline(title), source, publishedAt: new Date(t).toISOString(), url: link ? sanitizeHeadline(link, 500) : undefined });
  }
  return out;
}

export function relevantTo(symbol: string, item: NewsItem) {
  const base = symbol.split('/')[0].toUpperCase();
  const words = ALIASES[base] ?? [base.toLowerCase()];
  const t = ` ${item.title.toLowerCase()} `;
  return words.some((w) => new RegExp(`\\b${w.trim()}\\b`).test(t)) || MARKET_WIDE.some((w) => t.includes(w));
}

/**
 * Optional news context for AI analysis, from operator-configured RSS/Atom feeds (NEWS_RSS_URLS).
 * Disabled by default. Only recent, dated, symbol-relevant headlines are used; failures yield an
 * empty list (analysis proceeds without news, never with stale or guessed news).
 */
export class NewsService {
  private cache: { at: number; items: NewsItem[] } | null = null;

  constructor(
    private urls = env.NEWS_RSS_URLS.split(',').map((s) => s.trim()).filter((s) => /^https:\/\//.test(s)),
    private enabled = env.NEWS_ENABLED,
    private maxAgeHours = env.NEWS_MAX_AGE_HOURS,
    private fetchImpl: typeof fetch = fetch,
    private ttlMs = 5 * 60_000,
  ) {}

  get configured() {
    return this.enabled && this.urls.length > 0;
  }

  /** Re-read the feed settings (after they change in the admin console). */
  reconfigure() {
    this.urls = env.NEWS_RSS_URLS.split(',').map((s) => s.trim()).filter((s) => /^https:\/\//.test(s));
    this.enabled = env.NEWS_ENABLED;
    this.cache = null;
  }

  private async loadAll(): Promise<NewsItem[]> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.items;
    const results = await Promise.allSettled(
      this.urls.map(async (u) => {
        const res = await this.fetchImpl(u, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/rss+xml, application/atom+xml, text/xml' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = (await res.text()).slice(0, 2_000_000);
        return parseFeed(text, new URL(u).hostname);
      }),
    );
    const items: NewsItem[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') items.push(...r.value);
      else logger.warn({ feed: this.urls[i], err: errorMessage(r.reason) }, 'News feed failed');
    });
    this.cache = { at: Date.now(), items };
    return items;
  }

  async headlines(symbol: string, limit = 10): Promise<NewsItem[]> {
    if (!this.configured) return [];
    try {
      const cutoff = Date.now() - this.maxAgeHours * 3_600_000;
      const seen = new Set<string>();
      return (await this.loadAll())
        .filter((n) => Date.parse(n.publishedAt) >= cutoff && Date.parse(n.publishedAt) <= Date.now() + 300_000)
        .filter((n) => relevantTo(symbol, n))
        .filter((n) => (seen.has(n.title.toLowerCase()) ? false : (seen.add(n.title.toLowerCase()), true)))
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .slice(0, limit);
    } catch (err) {
      logger.warn({ err: errorMessage(err) }, 'News lookup failed');
      return [];
    }
  }
}

export const newsService = new NewsService();
