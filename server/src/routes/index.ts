import { Router } from 'express';
import { asyncHandler as h } from '../utils/errors';
import { requireAuth, requireFreshTotp, requireRole } from '../middleware/auth';
import { validateBody as v } from '../middleware/validate';
import { authLimiter, protectedActionLimiter } from '../middleware/rateLimit';
import { authController, schemas as authSchemas } from '../controllers/authController';
import { userController, userSchemas } from '../controllers/userController';
import { exchangeController, exchangeSchemas } from '../controllers/exchangeController';
import { marketController, marketDataController, marketSchemas } from '../controllers/marketController';
import { strategyController, strategySchemas } from '../controllers/strategyController';
import { tradingController, tradingSchemas } from '../controllers/tradingController';
import { portfolioController } from '../controllers/portfolioController';
import { backtestController, backtestSchemas } from '../controllers/backtestController';
import { aiController, aiSchemas } from '../controllers/aiController';
import { riskController, riskSchemas } from '../controllers/riskController';
import { notificationController, settingsController, settingsSchemas } from '../controllers/settingsController';
import { systemController, systemSchemas } from '../controllers/systemController';

const admin = [requireRole('admin')];
const trader = [requireRole('trader')];
/** Protected actions: admin + 2FA enabled + fresh TOTP code + strict rate limit. */
const protectedAdmin = [protectedActionLimiter, requireRole('admin'), h(requireFreshTotp)];

export function buildApiRouter() {
  const api = Router();

  // ---- auth (public endpoints are rate limited) ----
  const auth = Router();
  auth.post('/register', authLimiter, v(authSchemas.register), h(authController.register));
  auth.post('/login', authLimiter, v(authSchemas.login), h(authController.login));
  auth.post('/2fa/verify', authLimiter, v(authSchemas.verify2fa), h(authController.verify2fa));
  auth.post('/refresh', authLimiter, h(authController.refresh));
  auth.post('/logout', h(authController.logout));
  auth.get('/me', requireAuth, h(authController.me));
  auth.post('/2fa/setup', requireAuth, h(authController.setup2fa));
  auth.post('/2fa/confirm', requireAuth, v(authSchemas.code), h(authController.confirm2fa));
  auth.post('/2fa/disable', requireAuth, v(authSchemas.disable2fa), h(authController.disable2fa));
  api.use('/auth', auth);

  // ---- everything below requires authentication ----
  api.use(requireAuth);

  const users = Router();
  users.get('/', ...admin, h(userController.list));
  users.post('/', ...admin, v(userSchemas.create), h(userController.create));
  users.patch('/:id', ...admin, v(userSchemas.update), h(userController.update));
  api.use('/users', users);

  const exchanges = Router();
  exchanges.get('/', h(exchangeController.list));
  exchanges.get('/credentials', ...admin, h(exchangeController.listCredentials));
  exchanges.post('/credentials', ...protectedAdmin, v(exchangeSchemas.credential), h(exchangeController.addCredential));
  exchanges.delete('/credentials/:id', ...protectedAdmin, h(exchangeController.deleteCredential));
  exchanges.post('/:name/verify', ...admin, h(exchangeController.verify));
  api.use('/exchanges', exchanges);

  const markets = Router();
  markets.get('/', h(marketController.list));
  markets.patch('/:id', ...admin, v(marketSchemas.update), h(marketController.update));
  api.use('/markets', markets);

  const md = Router();
  md.get('/summary', h(marketDataController.summary));
  md.get('/candles', h(marketDataController.candles));
  md.get('/orderbook', h(marketDataController.orderbook));
  md.get('/analysis', h(marketDataController.analysis));
  api.use('/market-data', md);

  const strategies = Router();
  strategies.get('/', h(strategyController.list));
  strategies.patch('/:key', ...admin, v(strategySchemas.update), h(strategyController.update));
  strategies.post('/:key/stage', ...protectedAdmin, v(strategySchemas.stage), h(strategyController.setStage));
  strategies.get('/:key/versions', h(strategyController.versions));
  strategies.post('/:key/versions/:id/review', ...protectedAdmin, v(strategySchemas.review), h(strategyController.reviewVersion));
  api.use('/strategies', strategies);

  api.get('/signals', h(tradingController.signals));

  const orders = Router();
  orders.get('/', h(tradingController.orders));
  orders.get('/:id', h(tradingController.order));
  orders.post('/', ...trader, v(tradingSchemas.manualOrder), h(tradingController.manualOrder));
  orders.post('/:id/cancel', ...trader, h(tradingController.cancelOrder));
  api.use('/orders', orders);

  const positions = Router();
  positions.get('/', h(tradingController.positions));
  positions.post('/:id/close', ...trader, h(tradingController.closePosition));
  api.use('/positions', positions);

  const trades = Router();
  trades.get('/', h(tradingController.trades));
  trades.get('/:id/trace', h(tradingController.tradeTrace));
  api.use('/trades', trades);

  const portfolio = Router();
  portfolio.get('/', h(portfolioController.get));
  portfolio.get('/performance', h(portfolioController.performance));
  portfolio.get('/snapshots', h(portfolioController.snapshots));
  portfolio.get('/report', h(portfolioController.report));
  api.use('/portfolio', portfolio);

  const backtests = Router();
  backtests.get('/', h(backtestController.list));
  backtests.get('/:id', h(backtestController.get));
  backtests.post('/', ...trader, v(backtestSchemas.create), h(backtestController.create));
  backtests.post('/import-candles', ...admin, v(backtestSchemas.importCandles), h(backtestController.importCandles));
  api.use('/backtests', backtests);

  const ai = Router();
  ai.get('/status', h(aiController.status));
  ai.get('/analyses', h(aiController.list));
  ai.get('/news', h(aiController.news));
  ai.post('/analyze', ...trader, v(aiSchemas.analyze), h(aiController.analyze));
  ai.post('/review/:key', ...admin, h(aiController.reviewStrategy));
  api.use('/ai', ai);

  const risk = Router();
  risk.get('/', h(riskController.status));
  risk.get('/events', h(riskController.events));
  risk.put('/config', ...protectedAdmin, v(riskSchemas.config), h(riskController.updateConfig));
  risk.post('/circuit-breaker/reset', ...protectedAdmin, v(riskSchemas.reset), h(riskController.resetBreaker));
  api.use('/risk', risk);

  const settings = Router();
  settings.get('/', h(settingsController.get));
  settings.put('/ai', ...admin, v(settingsSchemas.ai), h(settingsController.updateAi));
  api.use('/settings', settings);

  const notifications = Router();
  notifications.get('/', h(notificationController.list));
  notifications.post('/:id/read', h(notificationController.markRead));
  notifications.post('/test', ...admin, h(notificationController.test));
  api.use('/notifications', notifications);

  const system = Router();
  system.get('/health', h(systemController.health));
  system.get('/audit-logs', ...admin, h(systemController.auditLogs));
  system.get('/events', ...admin, h(systemController.events));
  // Emergency controls: four separate protected actions.
  system.post('/emergency/stop-new-trades', ...protectedAdmin, v(systemSchemas.protected), h(systemController.stopNewTrades));
  system.post('/emergency/resume', ...protectedAdmin, v(systemSchemas.protected), h(systemController.resume));
  system.post('/emergency/cancel-orders', ...protectedAdmin, v(systemSchemas.protected), h(systemController.cancelOrders));
  system.post('/emergency/close-positions', ...protectedAdmin, v(systemSchemas.protected), h(systemController.closePositions));
  system.post('/emergency/shutdown', ...protectedAdmin, v(systemSchemas.protected), h(systemController.shutdown));
  system.post('/emergency/clear-shutdown', ...protectedAdmin, v(systemSchemas.protected), h(systemController.clearShutdown));
  // Live mode
  system.get('/live', ...admin, h(systemController.liveStatus));
  system.post('/live/preflight', ...protectedAdmin, v(systemSchemas.protected), h(systemController.preflight));
  system.post('/live/enable', ...protectedAdmin, v(systemSchemas.enableLive), h(systemController.enableLive));
  system.post('/live/disable', ...admin, h(systemController.disableLive)); // disabling is always easy
  api.use('/system', system);

  return api;
}
