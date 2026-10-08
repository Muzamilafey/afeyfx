import crypto from 'crypto';
import { env } from '../config/env';

/**
 * AES-256-GCM encryption for exchange credentials at rest.
 * Format: v1:<iv b64>:<authTag b64>:<ciphertext b64>
 */
function key(): Buffer {
  const hex = env.ENCRYPTION_KEY;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  if (env.NODE_ENV === 'production') throw new Error('ENCRYPTION_KEY must be 64 hex chars');
  // Development/test fallback: derive a deterministic key. Never used in production.
  return crypto.createHash('sha256').update(hex || 'afeyfx-dev-only-key').digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const [v, ivB64, tagB64, ctB64] = payload.split(':');
  if (v !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('Invalid encrypted payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Mask a credential for display: only the last 4 chars are shown. */
export function mask(s: string): string {
  if (!s) return '';
  return `${'*'.repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
}
