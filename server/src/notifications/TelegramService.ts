import { env } from '../config/env';
import { redactSecrets, errorMessage } from '../utils/logger';

/**
 * Minimal Telegram Bot API client (sendMessage). Every message is passed through secret
 * redaction before leaving the process, so API keys/tokens can never be sent.
 */
export class TelegramService {
  constructor(
    private token = env.TELEGRAM_BOT_TOKEN,
    private chatId = env.TELEGRAM_CHAT_ID,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get configured() {
    return !!this.token && !!this.chatId;
  }

  static sanitize(text: string) {
    return redactSecrets(text).slice(0, 4000);
  }

  async send(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured) return { ok: false, error: 'Telegram not configured' };
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text: TelegramService.sanitize(text), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      // Never include the request URL (contains the bot token) in errors.
      return { ok: false, error: errorMessage(err).replace(this.token, '[REDACTED]') };
    }
  }
}
