import request from 'supertest';
import type { Express } from 'express';
import { User } from '../../src/models/User';
import { AuthService } from '../../src/services/AuthService';
import { encrypt } from '../../src/utils/crypto';
import { generateTotpSecret, totp } from '../../src/utils/totp';

export const PASSWORD = 'CorrectHorse9Battery';

export async function makeUser(app: Express, email: string, role: 'admin' | 'trader' | 'viewer', with2fa = false) {
  const secret = generateTotpSecret();
  await User.create({ email, name: email, passwordHash: await AuthService.hashPassword(PASSWORD), role, twoFactorEnabled: with2fa, twoFactorSecret: with2fa ? encrypt(secret) : undefined });
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  let token = login.body.accessToken as string;
  if (with2fa) {
    const v = await request(app).post('/api/auth/2fa/verify').send({ challengeToken: login.body.challengeToken, code: totp(secret) });
    token = v.body.accessToken;
  }
  return { token, secret, auth: { Authorization: `Bearer ${token}` }, code: () => totp(secret) };
}
