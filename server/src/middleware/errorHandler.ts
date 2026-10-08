import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors';
import { errorMessage, logger } from '../utils/logger';
import { env } from '../config/env';

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, `Not found: ${req.method} ${req.path}`, 'NOT_FOUND'));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) logger.error({ err: errorMessage(err), path: req.path }, 'Request failed');
    return res.status(err.statusCode).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON' } });
  if (e?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' } });
  logger.error({ err: errorMessage(err), path: req.path }, 'Unhandled error');
  return res.status(500).json({ error: { code: 'INTERNAL', message: env.NODE_ENV === 'production' ? 'Internal server error' : errorMessage(err) } });
}
