import { describe, it, expect } from 'vitest';
import { CHART_TFS, bucketStart } from '../src/hooks/useChartCandles';

const utc = (s: string) => Date.parse(`${s}Z`);
const iso = (ms: number) => new Date(ms).toISOString();

describe('chart timeframes', () => {
  it('offers 4h, 1 day, 1 week and 1 month', () => {
    expect(CHART_TFS.map((t) => t.label)).toEqual(['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M']);
  });

  it('buckets ticks exactly like the server (UTC; weeks from Monday, months from the 1st)', () => {
    const t = utc('2026-10-08T13:45:10'); // Thursday
    expect(iso(bucketStart(t, '4h'))).toBe('2026-10-08T12:00:00.000Z');
    expect(iso(bucketStart(t, '1d'))).toBe('2026-10-08T00:00:00.000Z');
    expect(iso(bucketStart(t, '1w'))).toBe('2026-10-05T00:00:00.000Z');
    expect(iso(bucketStart(utc('2026-10-11T23:59:59'), '1w'))).toBe('2026-10-05T00:00:00.000Z'); // Sunday
    expect(iso(bucketStart(utc('2026-10-12T00:00:00'), '1w'))).toBe('2026-10-12T00:00:00.000Z'); // next Monday
    expect(iso(bucketStart(t, '1M'))).toBe('2026-10-01T00:00:00.000Z');
    expect(iso(bucketStart(utc('2028-02-29T23:00:00'), '1M'))).toBe('2028-02-01T00:00:00.000Z');
  });
});
