import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger, errorMessage } from '../utils/logger';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

type Sender = (m: MailMessage) => Promise<void>;

/**
 * Outbound email (verification links, second-factor codes, security notices) over SMTP.
 * In development without SMTP, messages are written to the server log so you can still test the
 * flows. In production without SMTP, sending fails (callers surface a clear error).
 */
class MailService {
  private transporter: Transporter | null = null;
  private override: Sender | null = null;

  get configured() {
    return !!this.override || !!env.SMTP_HOST;
  }

  /** Drop the cached SMTP transport (after SMTP settings change in the admin console). */
  reset() {
    this.transporter?.close();
    this.transporter = null;
  }

  /** Tests inject a capturing sender. */
  setSender(s: Sender | null) {
    this.override = s;
  }

  private transport() {
    this.transporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      requireTLS: !env.SMTP_SECURE && env.NODE_ENV === 'production',
    });
    return this.transporter;
  }

  async send(m: MailMessage) {
    if (this.override) return this.override(m);
    if (!env.SMTP_HOST) {
      if (env.NODE_ENV === 'production') throw new Error('Email is not configured (SMTP_HOST)');
      logger.warn({ to: m.to, subject: m.subject, body: m.text }, 'SMTP not configured - development email written to log');
      return;
    }
    try {
      await this.transport().sendMail({ from: env.MAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html });
    } catch (err) {
      logger.error({ err: errorMessage(err), to: m.to }, 'Email send failed');
      throw new Error('Could not send email');
    }
  }
}

export const mailService = new MailService();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const emailHtml = (title: string, body: string, cta?: { label: string; url: string }) =>
  `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0f172a">
  <h2 style="margin:0 0 12px">${esc(title)}</h2><p style="line-height:1.5">${esc(body)}</p>
  ${cta ? `<p><a href="${esc(cta.url)}" style="display:inline-block;background:#0284c7;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${esc(cta.label)}</a></p>` : ''}
  <p style="color:#64748b;font-size:12px">If you did not request this, ignore this email and consider changing your password.</p></div>`;
