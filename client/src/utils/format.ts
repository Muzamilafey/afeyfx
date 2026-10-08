const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const fmtNum = (v: unknown, dp = 2) => (isNum(v) ? v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—');
export const fmtPrice = (v: unknown) => {
  if (!isNum(v)) return '—';
  const dp = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
  return fmtNum(v, dp);
};
/** Price with an explicit number of decimals (instrument precision, e.g. 5 for EUR/USD). */
export const fmtPriceDp = (v: unknown, dp?: number) => (dp === undefined ? fmtPrice(v) : isNum(v) ? fmtNum(v, dp) : '—');
export const fmtUsd = (v: unknown, dp = 2) => (isNum(v) ? `${v < 0 ? '-' : ''}$${fmtNum(Math.abs(v), dp)}` : '—');
export const fmtPct = (v: unknown, dp = 2) => (isNum(v) ? `${(v * 100).toFixed(dp)}%` : '—');
export const fmtSigned = (v: unknown, dp = 2) => (isNum(v) ? `${v >= 0 ? '+' : ''}${fmtNum(v, dp)}` : '—');
export const fmtRatio = (v: unknown) => (isNum(v) ? v.toFixed(2) : 'n/a');
export const fmtTime = (v: unknown) => (v ? new Date(v as string | number).toLocaleString() : '—');
export const pnlClass = (v: unknown) => (isNum(v) ? (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-300') : 'text-slate-500');
