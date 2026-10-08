export const round = (v: number, dp = 8) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};
export const floorTo = (v: number, dp = 8) => {
  const f = 10 ** dp;
  return Math.floor(v * f + 1e-9) / f;
};
export const pct = (a: number, b: number) => (b === 0 ? 0 : (a - b) / b);
export const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
export const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
