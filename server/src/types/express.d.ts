import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; role: 'admin' | 'trader' | 'viewer'; twoFactorEnabled: boolean; emailVerified: boolean };
    }
  }
}

export {};
