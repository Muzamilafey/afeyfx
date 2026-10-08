import http from 'http';
import { env, symbolsFromEnv } from './config/env';
import { connectDb, disconnectDb } from './config/db';
import { createApp } from './app';
import { attachSocket } from './websocket/socket';
import { logger, errorMessage } from './utils/logger';
import { SettingsService } from './services/SettingsService';
import { seedStrategies } from './controllers/strategyController';
import { getMarketDataService } from './marketData/MarketDataService';
import { jobScheduler } from './jobs/scheduler';
import { exchangeRegistry } from './exchanges/registry';
import { circuitBreaker } from './risk/CircuitBreaker';
import { RiskEventModel } from './models/RiskEvent';
import { ExchangeCredential } from './models/ExchangeCredential';
import { notificationService } from './notifications/NotificationService';
import { adapterFromStoredCredential } from './controllers/exchangeController';
import { portfolioService } from './portfolio/PortfolioService';
import { tradingState } from './services/TradingState';

async function main() {
  await connectDb();
  await SettingsService.load(); // always boots in PAPER, live inactive
  await seedStrategies(symbolsFromEnv());
  await portfolioService.get('PAPER');

  // Load encrypted DB credentials (if any) into private adapters; env credentials are the fallback.
  for (const c of await ExchangeCredential.find({ active: true }).sort({ updatedAt: -1 })) {
    try {
      const { adapter } = await adapterFromStoredCredential(c._id.toString());
      exchangeRegistry.setPrivate(c.exchange, adapter);
    } catch (err) {
      logger.error({ exchange: c.exchange, err: errorMessage(err) }, 'Failed to load stored credential');
    }
  }

  circuitBreaker.onChange((event, trip) => {
    void RiskEventModel.create({ type: event === 'trip' ? 'CIRCUIT_BREAKER_TRIPPED' : 'CIRCUIT_BREAKER_RESET', severity: event === 'trip' ? 'CRITICAL' : 'INFO', message: `${trip.code}: ${trip.message}` }).catch(() => undefined);
    if (event === 'trip') {
      const type = trip.code === 'EXCHANGE_DISCONNECTED' ? 'EXCHANGE_DISCONNECTED' : trip.code === 'EXCHANGE_API_ERRORS' ? 'API_FAILURE' : 'CIRCUIT_BREAKER';
      void notificationService.notify(type, `Circuit breaker: ${trip.code}`, trip.message, { throttleKey: `cb:${trip.code}`, throttleMs: 600_000 });
    }
  });

  const app = createApp();
  const server = http.createServer(app);
  const socket = attachSocket(server);

  if (env.MARKET_DATA_ENABLED) await getMarketDataService().start();
  if (env.JOBS_ENABLED) jobScheduler.start();

  server.listen(env.PORT, '127.0.0.1', () => {
    logger.info({ port: env.PORT, mode: tradingState.get().mode, liveEnv: env.LIVE_TRADING_ENABLED }, 'AfeyFX server listening (PAPER mode)');
  });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'Shutting down');
    jobScheduler.stop();
    getMarketDataService().stop();
    socket.close();
    server.close();
    await exchangeRegistry.closeAll();
    await disconnectDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err: errorMessage(err) }, 'Unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err: errorMessage(err) }, 'Fatal startup error');
  process.exit(1);
});
