import { describe, it, expect, vi, afterEach } from 'vitest';
import { uuid } from '../src/utils/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuid', () => {
  afterEach(() => vi.restoreAllMocks());
  it('works on plain http (no crypto.randomUUID) and returns unique v4 ids', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID', 'get' as never).mockReturnValue(undefined as never);
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
