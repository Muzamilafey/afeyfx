import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import mongoose from 'mongoose';
import { env } from './config/env';
import { logger } from './utils/logger';
import { apiLimiter } from './middleware/rateLimit';
import { buildApiRouter } from './routes';
import { errorHandler, notFound } from './middleware/errorHandler';
import { tradingState } from './services/TradingState';

export const redactCallbackToken = (url: string) => url.replace(/(\/payments\/mpesa\/(?:stk|b2c\/result|b2c\/timeout)\/)[^/?#]+/, '$1[REDACTED]');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Nginx

  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  const origins = env.CLIENT_ORIGIN.split(',').map((s) => s.trim());
  app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o)), credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));
  // Signed MT5 bridge requests are verified over the exact bytes received.
  app.use(express.json({ limit: '512kb', verify: (req, _res, buf) => void ((req as unknown as { rawBody?: Buffer }).rawBody = (req as { url?: string }).url?.startsWith('/api/bridge/') ? Buffer.from(buf) : undefined) }));
  app.use(cookieParser());
  if (env.NODE_ENV !== 'test')
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => req.url === '/health' },
        // The M-Pesa callback URLs carry a secret path token: never write it to the logs.
        serializers: { req: (r: { id?: unknown; method?: string; url?: string }) => ({ id: r.id, method: r.method, url: redactCallbackToken(String(r.url ?? '')) }) },
      }),
    );

  /** Minimal unauthenticated liveness endpoint (no internal details). */
  app.get('/health', (_req, res) => {
    const db = mongoose.connection.readyState === 1;
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', mode: tradingState.get().mode, time: new Date().toISOString() });
  });

  app.use('/api', apiLimiter, buildApiRouter());
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
