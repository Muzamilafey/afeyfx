import { emailHtml, mailService } from './MailService';
import { logger, errorMessage } from '../utils/logger';

/** Best-effort security notice to the account owner (never blocks the action itself). */
export async function notifyAccountEvent(user: { email: string; emailVerified?: boolean | null }, title: string, body: string) {
  if (!user.emailVerified || !mailService.configured) return;
  try {
    await mailService.send({ to: user.email, subject: `AfeyFX security notice: ${title}`, text: `${body}\n\nTime: ${new Date().toISOString()}\nIf this was not you, sign in, change your password and disable unknown sessions immediately.`, html: emailHtml(title, `${body} If this was not you, change your password immediately.`) });
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, 'Security notice email failed');
  }
}
