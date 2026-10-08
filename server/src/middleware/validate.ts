import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../utils/errors';

/** Validate req.body against a zod schema; replaces body with the parsed (stripped) value. */
export const validateBody =
  (schema: ZodType) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const r = schema.safeParse(req.body);
    if (!r.success) return next(new AppError(400, 'Validation failed', 'VALIDATION_ERROR', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))));
    req.body = r.data;
    return next();
  };
