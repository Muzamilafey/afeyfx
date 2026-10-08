import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import '../src/models';
import { CandleModel } from '../src/models/Candle';
import { AuditLogModel } from '../src/models/AuditLog';
import { ExchangeCredential } from '../src/models/ExchangeCredential';
import { User } from '../src/models/User';
import { OrderModel } from '../src/models/Order';
import { CandleStore } from '../src/marketData/CandleStore';
import { encrypt, decrypt } from '../src/utils/crypto';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(clearDb);

describe('database', () => {
  it('unique index prevents duplicate candles', async () => {
    const c = { exchange: 'binance', symbol: 'BTC/USDT', timeframe: '1h', timestamp: 3_600_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
    await CandleModel.create(c);
    await expect(CandleModel.create(c)).rejects.toThrow(/duplicate key/);
  });

  it('CandleStore.upsertMany is idempotent', async () => {
    const candles = [0, 1, 2].map((i) => ({ timestamp: i * 3_600_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }));
    await CandleStore.upsertMany('binance', 'BTC/USDT', '1h', candles);
    await CandleStore.upsertMany('binance', 'BTC/USDT', '1h', candles);
    expect(await CandleModel.countDocuments()).toBe(3);
    const r = await CandleStore.range('binance', 'BTC/USDT', '1h');
    expect(r.map((x) => x.timestamp)).toEqual([0, 3_600_000, 7_200_000]);
  });

  it('audit log is append-only', async () => {
    const a = await AuditLogModel.create({ action: 'TEST' });
    await expect(AuditLogModel.updateOne({ _id: a._id }, { $set: { action: 'X' } })).rejects.toThrow(/append-only/);
    await expect(AuditLogModel.deleteOne({ _id: a._id })).rejects.toThrow(/append-only/);
  });

  it('exchange credentials are encrypted and never serialized', async () => {
    const u = await User.create({ email: 'a@b.co', name: 'a', passwordHash: 'x' });
    const c = await ExchangeCredential.create({ user: u._id, exchange: 'binance', encryptedKey: encrypt('KEY123456789'), encryptedSecret: encrypt('SECRET987654321'), keyHint: '6789' });
    const json = JSON.stringify(c.toJSON());
    expect(json).not.toContain('SECRET987654321');
    expect(json).not.toContain('encryptedSecret');
    const raw = await ExchangeCredential.findById(c._id).select('+encryptedSecret').lean();
    expect(raw!.encryptedSecret).not.toContain('SECRET');
    expect(decrypt(raw!.encryptedSecret!)).toBe('SECRET987654321');
    const plain = await ExchangeCredential.findById(c._id).lean();
    expect(plain).not.toHaveProperty('encryptedSecret');
  });

  it('user password hash and 2FA secret are not selected or serialized', async () => {
    await User.create({ email: 'x@y.co', name: 'x', passwordHash: 'hash', twoFactorSecret: 'sec' });
    const u = await User.findOne({ email: 'x@y.co' });
    expect(u!.toJSON()).not.toHaveProperty('passwordHash');
    expect(u!.toJSON()).not.toHaveProperty('twoFactorSecret');
  });

  it('order idempotency key is unique and mode is immutable', async () => {
    const base = { mode: 'PAPER' as const, idempotencyKey: 'k1', exchange: 'binance', symbol: 'BTC/USDT', side: 'buy' as const, type: 'market' as const, amount: 1 };
    const o = await OrderModel.create(base);
    await expect(OrderModel.create(base)).rejects.toThrow(/duplicate key/);
    o.mode = 'LIVE' as never;
    await o.save();
    expect((await OrderModel.findById(o._id))!.mode).toBe('PAPER');
  });
});
