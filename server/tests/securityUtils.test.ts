import { describe, it, expect, vi } from 'vitest';
import { encrypt, decrypt, mask } from '../src/utils/crypto';
import { totp, verifyTotp, generateTotpSecret, base32Decode, base32Encode, hotp } from '../src/utils/totp';
import { redactSecrets } from '../src/utils/logger';
import { TelegramService } from '../src/notifications/TelegramService';

describe('encryption', () => {
  it('AES-256-GCM round-trips, uses random IVs and detects tampering', () => {
    const a = encrypt('super-secret');
    const b = encrypt('super-secret');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('super-secret');
    const parts = a.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(parts.join(':'))).toThrow();
  });
  it('masks keys', () => expect(mask('ABCDEFGH1234')).toBe('********1234'));
});

describe('TOTP (RFC 6238)', () => {
  it('matches RFC 4226 HOTP test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 1)).toBe('287082');
    expect(hotp(secret, 9)).toBe('520489');
  });
  it('verifies within the window and rejects others', () => {
    const s = generateTotpSecret();
    expect(base32Decode(s)).toHaveLength(20);
    const now = Date.now();
    expect(verifyTotp(s, totp(s, now), 1, now)).toBe(true);
    expect(verifyTotp(s, totp(s, now - 30_000), 1, now)).toBe(true);
    expect(verifyTotp(s, totp(s, now - 120_000), 1, now)).toBe(false);
    expect(verifyTotp(s, 'abcdef')).toBe(false);
  });
});

describe('secret redaction & Telegram', () => {
  it('redacts credentials from free text', () => {
    const out = redactSecrets('apiKey=AKIA123456 secret: "hunter2hunter2" https://api.telegram.org/bot123456789:AAbbccddeeffgghhiijjkkllmmnnoopp/sendMessage sk-ant-api03-xyz');
    expect(out).not.toMatch(/AKIA123456|hunter2|AAbbccdd|sk-ant-api03/);
  });

  it('never sends secrets and never leaks the bot token in errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED https://api.telegram.org/bot999999999:SECRETTOKENSECRETTOKENxx/sendMessage');
    });
    const tg = new TelegramService('999999999:SECRETTOKENSECRETTOKENxx', 'chat', fetchImpl as unknown as typeof fetch);
    const r = await tg.send('order failed: apiSecret=abcdefgh12345');
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('SECRETTOKEN');
    const ok = vi.fn(async () => new Response('{}', { status: 200 }));
    await new TelegramService('1:x', 'chat', ok as unknown as typeof fetch).send('apiSecret=abcdefgh12345 done');
    const body = JSON.parse(((ok.mock.calls[0] as unknown[])[1] as { body: string }).body);
    expect(body.text).not.toContain('abcdefgh12345');
  });
});
