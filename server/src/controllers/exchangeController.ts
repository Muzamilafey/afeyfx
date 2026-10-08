import type { Request, Response } from 'express';
import { z } from 'zod';
import { Exchange } from '../models/Exchange';
import { ExchangeCredential } from '../models/ExchangeCredential';
import { createAdapter, exchangeRegistry, SUPPORTED_EXCHANGES } from '../exchanges/registry';
import { decrypt, encrypt } from '../utils/crypto';
import { audit } from '../services/AuditService';
import { AppError } from '../utils/errors';
import { errorMessage } from '../utils/logger';

export const exchangeSchemas = {
  credential: z.object({
    exchange: z.enum(SUPPORTED_EXCHANGES),
    label: z.string().min(1).max(50).default('default'),
    apiKey: z.string().min(8).max(512),
    apiSecret: z.string().min(8).max(4096),
    passphrase: z.string().max(256).optional(),
    testnet: z.boolean().default(true),
    totp: z.string().optional(),
  }),
};

/** Build a private adapter from stored (encrypted) credentials. Secrets never leave the server. */
export async function adapterFromStoredCredential(id: string) {
  const c = await ExchangeCredential.findById(id).select('+encryptedKey +encryptedSecret +encryptedPassphrase');
  if (!c) throw new AppError(404, 'Credential not found');
  return {
    doc: c,
    adapter: createAdapter(c.exchange, {
      testnet: c.testnet,
      credentials: { apiKey: decrypt(c.encryptedKey), secret: decrypt(c.encryptedSecret), password: c.encryptedPassphrase ? decrypt(c.encryptedPassphrase) : undefined },
    }),
  };
}

export const exchangeController = {
  async list(_req: Request, res: Response) {
    const docs = await Exchange.find().lean();
    res.json({ supported: SUPPORTED_EXCHANGES, exchanges: docs });
  },

  async listCredentials(_req: Request, res: Response) {
    // toJSON strips encrypted fields; only keyHint (last 4 chars) is exposed.
    const creds = await ExchangeCredential.find();
    res.json({ credentials: creds.map((c) => c.toJSON()) });
  },

  async addCredential(req: Request, res: Response) {
    const b = req.body as z.infer<typeof exchangeSchemas.credential>;
    const adapter = createAdapter(b.exchange, { testnet: b.testnet, credentials: { apiKey: b.apiKey, secret: b.apiSecret, password: b.passphrase } });
    let perms;
    try {
      perms = await adapter.verifyPermissions();
    } catch (err) {
      throw new AppError(400, `Could not verify key: ${errorMessage(err)}`, 'KEY_VERIFY_FAILED');
    } finally {
      await adapter.close().catch(() => undefined);
    }
    if (perms.canWithdraw) {
      await audit(req, { action: 'EXCHANGE_KEY_REJECTED_WITHDRAW', success: false, details: { exchange: b.exchange, verified: perms.verified } });
      throw new AppError(400, perms.verified ? 'This API key has WITHDRAWAL/TRANSFER permission. Create a key with trading enabled and withdrawals disabled.' : `Could not verify that withdrawals are disabled: ${perms.notes.join('; ')}`, 'WITHDRAW_PERMISSION');
    }
    const doc = await ExchangeCredential.findOneAndUpdate(
      { user: req.user!.id, exchange: b.exchange, label: b.label },
      {
        $set: {
          encryptedKey: encrypt(b.apiKey),
          encryptedSecret: encrypt(b.apiSecret),
          encryptedPassphrase: b.passphrase ? encrypt(b.passphrase) : undefined,
          keyHint: b.apiKey.slice(-4),
          testnet: b.testnet,
          permissions: { verifiedAt: new Date(), canTrade: perms.canTrade, canWithdraw: perms.canWithdraw, raw: { notes: perms.notes, ipRestricted: perms.ipRestricted } },
          active: true,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    const { adapter: priv } = await adapterFromStoredCredential(doc._id.toString());
    exchangeRegistry.setPrivate(b.exchange, priv);
    await audit(req, { action: 'EXCHANGE_KEY_ADDED', resource: 'exchangeCredential', resourceId: doc._id.toString(), details: { exchange: b.exchange, testnet: b.testnet, keyHint: doc.keyHint } });
    res.status(201).json({ credential: doc.toJSON(), permissions: { canTrade: perms.canTrade, canWithdraw: perms.canWithdraw, notes: perms.notes } });
  },

  async deleteCredential(req: Request, res: Response) {
    const c = await ExchangeCredential.findByIdAndDelete(req.params.id);
    if (!c) throw new AppError(404, 'Credential not found');
    exchangeRegistry.clear();
    await audit(req, { action: 'EXCHANGE_KEY_DELETED', resource: 'exchangeCredential', resourceId: String(req.params.id), details: { exchange: c.exchange } });
    res.json({ ok: true });
  },

  async verify(req: Request, res: Response) {
    const name = String(req.params.name);
    if (!(SUPPORTED_EXCHANGES as readonly string[]).includes(name)) throw new AppError(400, 'Unsupported exchange');
    const a = exchangeRegistry.private(name);
    const [perms, status] = await Promise.all([a.verifyPermissions().catch((e) => ({ verified: false, notes: [errorMessage(e)] })), a.getStatus()]);
    res.json({ exchange: name, hasCredentials: a.hasCredentials, testnet: a.testnet, permissions: { ...perms, raw: undefined }, status });
  },
};
