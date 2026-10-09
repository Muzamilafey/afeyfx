import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { User } from '../src/models/User';
import { RefreshToken } from '../src/models/RefreshToken';
import { AuditLogModel as AuditLog } from '../src/models/AuditLog';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser, PASSWORD } from './helpers/api';

const app = createApp();

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(clearDb);

describe('admin email verification', () => {
  it('an unverified admin can verify their own email with their password (and stays signed in)', async () => {
    const a = await makeUser(app, 'boss@x.io', 'admin', false, false);
    // Admin pages are blocked until verified...
    expect((await request(app).get('/api/users').set(a.auth)).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    // ...but self-verification is reachable, and needs the password.
    expect((await request(app).post('/api/users/me/verify-email').set(a.auth).send({ password: 'wrong-password-123' })).status).toBe(401);
    expect((await User.findOne({ email: 'boss@x.io' }))!.emailVerified).toBe(false);
    const r = await request(app).post('/api/users/me/verify-email').set(a.auth).send({ password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.user.emailVerified).toBe(true);
    expect(await RefreshToken.countDocuments({ revokedAt: { $ne: null } })).toBe(0); // not logged out
    expect((await request(app).get('/api/users').set(a.auth)).status).toBe(200); // same token now works
    expect(await AuditLog.countDocuments({ action: 'EMAIL_SELF_VERIFIED_BY_ADMIN' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'EMAIL_SELF_VERIFY_FAILED' })).toBe(1);
  });

  it('traders and viewers cannot self-verify', async () => {
    const t = await makeUser(app, 't@x.io', 'trader', false, false);
    expect((await request(app).post('/api/users/me/verify-email').set(t.auth).send({ password: PASSWORD })).status).toBe(403);
    expect((await User.findOne({ email: 't@x.io' }))!.emailVerified).toBe(false);
  });

  it('a verified admin can verify and un-verify other users; un-verifying ends their sessions; never their own', async () => {
    const a = await makeUser(app, 'boss@x.io', 'admin');
    const t = await makeUser(app, 't@x.io', 'trader', false, false);
    const id = (await User.findOne({ email: 't@x.io' }))!._id.toString();
    expect((await request(app).post('/api/account/orders').set(t.auth).send({ symbol: 'BTC/USDT', direction: 'LONG', investment: 50 })).body.error.code).toBe('EMAIL_NOT_VERIFIED');
    const v = await request(app).post(`/api/users/${id}/verify-email`).set(a.auth).send({ verified: true });
    expect(v.body.user).toMatchObject({ emailVerified: true });
    expect((await User.findById(id))!.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await RefreshToken.countDocuments({ user: id, revokedAt: { $ne: null } })).toBe(0);

    const off = await request(app).post(`/api/users/${id}/verify-email`).set(a.auth).send({ verified: false });
    expect(off.body.user.emailVerified).toBe(false);
    expect(await RefreshToken.countDocuments({ user: id, revokedAt: null })).toBe(0); // sessions revoked

    const me = (await User.findOne({ email: 'boss@x.io' }))!._id.toString();
    expect((await request(app).post(`/api/users/${me}/verify-email`).set(a.auth).send({ verified: false })).status).toBe(400);
    // Only admins
    const t2 = await makeUser(app, 't2@x.io', 'trader');
    expect((await request(app).post(`/api/users/${id}/verify-email`).set(t2.auth).send({ verified: true })).status).toBe(403);
  });
});
