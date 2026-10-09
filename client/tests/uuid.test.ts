import { describe, it, expect, afterEach } from 'vitest';
import { uuid } from '../src/utils/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const original = globalThis.crypto.randomUUID;

describe('uuid', () => {
  afterEach(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true, writable: true });
  });

  it('works on plain http (no crypto.randomUUID) and returns unique v4 ids', () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
    expect(typeof globalThis.crypto.randomUUID).toBe('undefined');
    const a = uuid();
    const b = uuid();
    expect(a).toMatch(V4);
    expect(b).toMatch(V4);
    expect(a).not.toBe(b);
  });

  it('uses crypto.randomUUID when available', () => {
    expect(uuid()).toMatch(V4);
  });
});
