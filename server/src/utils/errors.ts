import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = 'ERROR',
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class LiveTradingDisabledError extends AppError {
  constructor(reason: string) {
    super(403, `Live trading blocked: ${reason}`, 'LIVE_TRADING_DISABLED');
    this.name = 'LiveTradingDisabledError';
  }
}

export class RiskRejectedError extends AppError {
  constructor(reasons: string[]) {
    super(422, `Risk engine rejected trade: ${reasons.join('; ')}`, 'RISK_REJECTED', reasons);
    this.name = 'RiskRejectedError';
  }
}

export class CircuitBreakerOpenError extends AppError {
  constructor(reasons: string[]) {
    super(423, `Circuit breaker open: ${reasons.join('; ')}`, 'CIRCUIT_BREAKER_OPEN', reasons);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class WithdrawalForbiddenError extends Error {
  constructor(what: string) {
    super(`Withdrawals/transfers are permanently disabled in this platform (attempted: ${what})`);
    this.name = 'WithdrawalForbiddenError';
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
