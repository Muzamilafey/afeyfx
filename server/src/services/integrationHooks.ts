import { env } from '../config/env';
import { setClaudeService } from '../ai/ClaudeService';
import { brokerService } from '../brokers/BrokerService';
import { forexDataService } from '../marketData/ForexDataService';
import { resetInstruments } from '../marketData/instruments';
import { notificationService } from '../notifications/NotificationService';
import { TelegramService } from '../notifications/TelegramService';
import { googleAuthService } from './GoogleAuthService';
import { integrationService } from './IntegrationService';
import { mailService } from './MailService';
import { newsService } from './news/NewsService';

/** Rebuild every client that captured an integration setting, after an admin changes one. */
export function registerIntegrationHooks() {
  integrationService.onChange(() => {
    mailService.reset();
    googleAuthService.reset();
    setClaudeService(null);
    notificationService.telegram = new TelegramService();
    newsService.reconfigure();
    brokerService.invalidate();
    resetInstruments();
  });
  integrationService.onChange(async () => {
    if (env.MARKET_DATA_ENABLED) await forexDataService.restart();
  });
}
