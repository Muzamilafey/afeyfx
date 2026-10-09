import { Router } from 'express';
import { asyncHandler as h } from '../utils/errors';
import { requireAuth, requireFreshSecondFactor, requireRole, requireVerifiedEmail } from '../middleware/auth';
import { validateBody as v } from '../middleware/validate';
import { authLimiter, bridgeLimiter, brokerOrderLimiter, callbackLimiter, demoOrderLimiter, paymentLimiter, protectedActionLimiter, sessionLimiter } from '../middleware/rateLimit';
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
import { accountController, accountSchemas } from '../controllers/accountController';
import { brokerConnectionController as bc, brokerSchemas, mt5BridgeHandler } from '../controllers/brokerConnectionController';
import { brokerController, featuresController, integrationController, integrationSchemas } from '../controllers/integrationController';
import { adminPaymentController, mpesaCallbackController, paymentController, paymentSchemas } from '../controllers/paymentController';

/** Read access to system-wide data (strategy book, risk, logs) is admin-only. */
const adminRead = [requireRole('admin')];
const admin = [requireRole('admin'), requireVerifiedEmail];
const trader = [requireRole('trader'), requireVerifiedEmail];
/** Protected actions: admin + verified email + second factor enabled + fresh code + strict rate limit. */
const protectedAdmin = [protectedActionLimiter, requireRole('admin'), requireVerifiedEmail, h(requireFreshSecondFactor)];

export function buildApiRouter() {
  const api = Router();

  // ---- auth (public endpoints are rate limited) ----
  const auth = Router();
  auth.get('/config', h(authController.config));
  auth.post('/register', authLimiter, v(authSchemas.register), h(authController.register));
  auth.post('/google', authLimiter, v(authSchemas.google), h(authController.google));
  for (const provider of ['google', 'github'] as const) {
    auth.get(`/${provider}/start`, sessionLimiter, h(authController.oauthStart(provider)));
    auth.get(`/${provider}/callback`, sessionLimiter, h(authController.oauthCallback(provider)));
  }
  auth.post('/2fa/email/send-login', authLimiter, v(authSchemas.challenge), h(authController.sendLoginCode));
  auth.post('/verify-email', authLimiter, v(authSchemas.verifyEmail), h(authController.verifyEmail));
  auth.post('/login', authLimiter, v(authSchemas.login), h(authController.login));
  auth.post('/2fa/verify', authLimiter, v(authSchemas.verify2fa), h(authController.verify2fa));
  auth.post('/refresh', sessionLimiter, h(authController.refresh));
  auth.post('/logout', h(authController.logout));
  auth.get('/me', requireAuth, h(authController.me));
  auth.post('/2fa/setup', requireAuth, h(authController.setup2fa));
  auth.post('/2fa/confirm', requireAuth, v(authSchemas.code), h(authController.confirm2fa));
  auth.post('/2fa/disable', requireAuth, v(authSchemas.disable2fa), h(authController.disable2fa));
  auth.post('/resend-verification', authLimiter, requireAuth, h(authController.resendVerification));
  auth.post('/2fa/email/send', protectedActionLimiter, requireAuth, v(authSchemas.actionCode), h(authController.sendActionCode));
  auth.post('/2fa/email/enable', requireAuth, v(authSchemas.code), h(authController.enableEmail2fa));
  auth.post('/2fa/email/disable', requireAuth, v(authSchemas.secondFactor), h(authController.disableEmail2fa));
  auth.post('/password', authLimiter, requireAuth, v(authSchemas.password), h(authController.setPassword));
  api.use('/auth', auth);

  // ---- M-Pesa (Daraja) callbacks: public, authenticated by a secret path token (+ optional IP allow-list) ----
  const mpesa = Router();
  mpesa.post('/stk/:token', h(mpesaCallbackController.stk));
  mpesa.post('/b2c/result/:token', h(mpesaCallbackController.b2cResult));
  mpesa.post('/b2c/timeout/:token', h(mpesaCallbackController.b2cTimeout));
  api.use('/payments/mpesa', callbackLimiter, mpesa);

  // ---- MetaTrader 5 bridge: public, every request HMAC-signed by the user's terminal ----
  const bridge = Router();
  for (const kind of ['hello', 'heartbeat', 'symbols', 'quotes', 'reports', 'poll'] as const) bridge.post(`/${kind}`, h(mt5BridgeHandler(kind)));
  api.use('/bridge/mt5', bridgeLimiter, bridge);
  // ---- Deriv OAuth callback (public redirect; bound to the user by state + browser cookie) ----
  api.get('/brokers/deriv/callback', sessionLimiter, h(bc.derivCallback));

  // ---- everything below requires authentication ----
  api.use(requireAuth);

  // ---- real-money payments (M-Pesa): a trader's own deposits and withdrawals ----
  const payments = Router();
  payments.get('/config', h(paymentController.config));
  payments.get('/', h(paymentController.list));
  payments.get('/:id', h(paymentController.get));
  payments.post('/deposits', ...trader, paymentLimiter, v(paymentSchemas.deposit), h(paymentController.deposit));
  payments.post('/payouts', protectedActionLimiter, ...trader, v(paymentSchemas.payout), h(paymentController.payout));
  payments.post('/payouts/:id/cancel', ...trader, h(paymentController.cancel));
  api.use('/payments', payments);

  // ---- user broker connections (multi-account; every query scoped to the owner) ----
  const brokersR = Router();
  brokersR.use(...trader);
  brokersR.get('/', h(bc.providers));
  brokersR.get('/capabilities', h(bc.capabilities));
  brokersR.get('/connections', h(bc.list));
  brokersR.get('/assignments', h(bc.assignments));
  brokersR.put('/assignments', v(brokerSchemas.assignment), h(bc.assign));
  brokersR.delete('/assignments/:assignmentId', h(bc.unassign));
  brokersR.post('/:provider/connect', sessionLimiter, v(brokerSchemas.connect), h(bc.connect));
  const cx = Router({ mergeParams: true });
  cx.get('/', h(bc.get));
  cx.post('/test', h(bc.test));
  cx.post('/sync', h(bc.sync));
  cx.post('/disconnect', v(brokerSchemas.confirm), h(bc.disconnect));
  cx.post('/reauthorize', h(bc.reauthorize));
  cx.get('/account', h(bc.account));
  cx.get('/instruments', h(bc.instruments));
  cx.get('/quote', h(bc.quote));
  cx.get('/positions', h(bc.positions));
  cx.get('/orders', h(bc.orders));
  cx.get('/trades', h(bc.trades));
  cx.get('/health', h(bc.health));
  cx.get('/logs', h(bc.logs));
  cx.post('/orders/preview', v(brokerSchemas.order), h(bc.preview));
  cx.post('/orders', brokerOrderLimiter, v(brokerSchemas.order), h(bc.placeOrder));
  cx.post('/orders/:orderId/cancel', brokerOrderLimiter, h(bc.cancelOrder));
  cx.post('/positions/:positionId/close', brokerOrderLimiter, h(bc.closePosition));
  cx.post('/trading/disable', h(bc.disableTrading));
  cx.post('/trading/enable', v(brokerSchemas.confirm), h(bc.enableTrading));
  cx.post('/live/enable', protectedActionLimiter, h(requireFreshSecondFactor), v(brokerSchemas.live), h(bc.enableLive));
  cx.post('/default', h(bc.setDefault));
  cx.put('/limits', v(brokerSchemas.limits), h(bc.updateLimits));
  cx.post('/breaker/reset', h(bc.resetBreaker));
  cx.post('/emergency/cancel-orders', h(bc.emergencyCancel));
  cx.post('/emergency/close-positions', v(brokerSchemas.confirm), h(bc.emergencyClose));
  brokersR.use('/connections/:id', cx);
  api.use('/brokers', brokersR);

  // ---- admin payments console ----
  const adminPayments = Router();
  adminPayments.use(...admin);
  adminPayments.get('/config', h(adminPaymentController.getConfig));
  adminPayments.put('/config', ...protectedAdmin, v(paymentSchemas.config), h(adminPaymentController.updateConfig));
  adminPayments.post('/config/test', h(adminPaymentController.test));
  adminPayments.get('/stats', h(adminPaymentController.stats));
  adminPayments.get('/', h(adminPaymentController.list));
  adminPayments.post('/:id/approve', ...protectedAdmin, h(adminPaymentController.approve));
  adminPayments.post('/:id/reject', ...protectedAdmin, v(paymentSchemas.reject), h(adminPaymentController.reject));
  adminPayments.post('/:id/resolve', ...protectedAdmin, v(paymentSchemas.resolve), h(adminPaymentController.resolve));
  adminPayments.post('/:id/requery', h(adminPaymentController.requery));
  api.use('/admin/payments', adminPayments);

  // ---- feature availability (the UI hides features whose integration is not configured) ----
  api.get('/features', h(featuresController));

  // ---- admin integrations: every .env integration key, editable in the console ----
  const integrations = Router();
  integrations.use(...admin);
  integrations.get('/', h(integrationController.get));
  integrations.put('/', ...protectedAdmin, v(integrationSchemas.update), h(integrationController.update));
  integrations.post('/:id/test', protectedActionLimiter, h(integrationController.test));
  api.use('/admin/integrations', integrations);

  // ---- admin brokers: where REAL-account orders execute ----
  const brokers = Router();
  brokers.use(...admin);
  brokers.get('/', h(brokerController.get));
  brokers.put('/deriv', ...protectedAdmin, v(integrationSchemas.deriv), h(brokerController.updateDeriv));
  brokers.post('/:id/test', protectedActionLimiter, h(brokerController.test));
  brokers.put('/routes', ...protectedAdmin, v(integrationSchemas.route), h(brokerController.setRoute));
  brokers.post('/emergency/disable-all-user-accounts', ...protectedAdmin, h(bc.adminDisableAll));
  api.use('/admin/brokers', brokers);

  // ---- personal demo account (any signed-in user; trading needs a verified email) ----
  const account = Router();
  account.get('/', h(accountController.get));
  account.post('/demo/reset', requireVerifiedEmail, h(accountController.resetDemo));
  account.get('/positions', h(accountController.positions));
  account.post('/positions/:id/close', requireVerifiedEmail, h(accountController.closePosition));
  account.get('/history', h(accountController.history));
  account.get('/performance', h(accountController.performance));
  account.post('/orders', requireVerifiedEmail, demoOrderLimiter, v(accountSchemas.order), h(accountController.placeOrder));
  api.use('/account', account);

  const users = Router();
  users.get('/', ...admin, h(userController.list));
  users.post('/', ...admin, v(userSchemas.create), h(userController.create));
  users.patch('/:id', ...admin, v(userSchemas.update), h(userController.update));
  users.post('/:id/resend-verification', ...admin, h(userController.resendVerification));
  api.use('/users', users);

  const exchanges = Router();
  exchanges.get('/', ...adminRead, h(exchangeController.list));
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

  api.get('/signals', ...adminRead, h(tradingController.signals));

  const orders = Router();
  orders.get('/', ...adminRead, h(tradingController.orders));
  orders.get('/:id', ...adminRead, h(tradingController.order));
  orders.post('/', ...admin, v(tradingSchemas.manualOrder), h(tradingController.manualOrder));
  orders.post('/:id/cancel', ...admin, h(tradingController.cancelOrder));
  api.use('/orders', orders);

  const positions = Router();
  positions.get('/', ...adminRead, h(tradingController.positions));
  positions.post('/:id/close', ...admin, h(tradingController.closePosition));
  api.use('/positions', positions);

  const trades = Router();
  trades.get('/', ...adminRead, h(tradingController.trades));
  trades.get('/:id/trace', ...adminRead, h(tradingController.tradeTrace));
  api.use('/trades', trades);

  const portfolio = Router();
  portfolio.use(...adminRead);
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
  ai.use(...adminRead);
  ai.get('/status', h(aiController.status));
  ai.get('/analyses', h(aiController.list));
  ai.get('/news', h(aiController.news));
  ai.post('/analyze', ...admin, v(aiSchemas.analyze), h(aiController.analyze));
  ai.post('/review/:key', ...admin, h(aiController.reviewStrategy));
  api.use('/ai', ai);

  const risk = Router();
  risk.use(...adminRead);
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
  notifications.use(...adminRead);
  notifications.get('/', h(notificationController.list));
  notifications.post('/:id/read', h(notificationController.markRead));
  notifications.post('/test', ...admin, h(notificationController.test));
  api.use('/notifications', notifications);

  const system = Router();
  system.get('/health', ...adminRead, h(systemController.health));
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
