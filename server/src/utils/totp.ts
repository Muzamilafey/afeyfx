import crypto from 'crypto';

/** RFC 6238 TOTP (SHA1, 6 digits, 30s) implemented with node:crypto. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = h[h.length - 1] & 0xf;
  const code =
    (((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3]) % 1_000_000;
  return code.toString().padStart(6, '0');
}

export function totp(secret: string, at = Date.now(), step = 30): string {
  return hotp(secret, Math.floor(at / 1000 / step));
}

/** Verify with +/- `window` steps of tolerance; constant-time comparison. */
export function verifyTotp(secret: string, token: string, window = 1, at = Date.now()): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const counter = Math.floor(at / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secret, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))) return true;
  }
  return false;
}

export function totpUri(secret: string, account: string, issuer = 'AfeyFX'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
