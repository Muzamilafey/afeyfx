import type { ReactNode } from 'react';

/**
 * Market icons drawn inline (no external images): simplified circular currency flags for forex
 * pairs, metal coins, and coloured coin badges for crypto.
 */
const UK = (
  <g>
    <rect width="30" height="30" fill="#012169" />
    <path d="M0 0L30 30M30 0L0 30" stroke="#fff" strokeWidth="6" />
    <path d="M0 0L30 30M30 0L0 30" stroke="#C8102E" strokeWidth="2" />
    <path d="M15 0V30M0 15H30" stroke="#fff" strokeWidth="9" />
    <path d="M15 0V30M0 15H30" stroke="#C8102E" strokeWidth="5" />
  </g>
);
const stars = (cx: number, cy: number, r: number, n: number, fill: string, size = 1.3) => Array.from({ length: n }, (_, i) => <circle key={i} cx={cx + r * Math.cos((i / n) * 2 * Math.PI)} cy={cy + r * Math.sin((i / n) * 2 * Math.PI)} r={size} fill={fill} />);

const FLAGS: Record<string, ReactNode> = {
  USD: (
    <g>
      {Array.from({ length: 7 }, (_, i) => <rect key={i} y={i * 4.6} width="30" height="2.3" fill="#B22234" />)}
      <rect y="2.3" width="30" height="2.3" fill="#fff" />
      <rect width="14" height="15" fill="#3C3B6E" />
      {[3, 7, 11].flatMap((x) => [3, 7.5, 12].map((y) => <circle key={`${x}${y}`} cx={x} cy={y} r="1" fill="#fff" />))}
    </g>
  ),
  EUR: (
    <g>
      <rect width="30" height="30" fill="#003399" />
      {stars(15, 15, 8, 12, '#FFCC00')}
    </g>
  ),
  GBP: UK,
  JPY: (
    <g>
      <rect width="30" height="30" fill="#fff" />
      <circle cx="15" cy="15" r="7" fill="#BC002D" />
    </g>
  ),
  CHF: (
    <g>
      <rect width="30" height="30" fill="#D52B1E" />
      <path d="M15 7V23M7 15H23" stroke="#fff" strokeWidth="5" />
    </g>
  ),
  AUD: (
    <g>
      <rect width="30" height="30" fill="#012169" />
      <g transform="scale(0.5)">{UK}</g>
      <circle cx="22" cy="21" r="1.8" fill="#fff" />
      <circle cx="8" cy="23" r="1.8" fill="#fff" />
      <circle cx="24" cy="11" r="1.2" fill="#fff" />
    </g>
  ),
  NZD: (
    <g>
      <rect width="30" height="30" fill="#012169" />
      <g transform="scale(0.5)">{UK}</g>
      {[[22, 10], [25, 16], [20, 18], [22, 24]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.5" fill="#CC142B" stroke="#fff" strokeWidth=".6" />)}
    </g>
  ),
  CAD: (
    <g>
      <rect width="30" height="30" fill="#fff" />
      <rect width="8" height="30" fill="#D80621" />
      <rect x="22" width="8" height="30" fill="#D80621" />
      <path d="M15 8l2 4 3-1-1 5 2 1-6 4-6-4 2-1-1-5 3 1z" fill="#D80621" />
    </g>
  ),
  ZAR: (
    <g>
      <rect width="30" height="15" fill="#E03C31" />
      <rect y="15" width="30" height="15" fill="#001489" />
      <path d="M0 0L15 15L0 30" fill="#007749" stroke="#fff" strokeWidth="3" />
      <path d="M0 4L11 15L0 26z" fill="#000" stroke="#FFB81C" strokeWidth="1.5" />
    </g>
  ),
  MXN: (
    <g>
      <rect width="10" height="30" fill="#006847" />
      <rect x="10" width="10" height="30" fill="#fff" />
      <rect x="20" width="10" height="30" fill="#CE1126" />
      <circle cx="15" cy="15" r="2.5" fill="#8C6B2D" />
    </g>
  ),
  SGD: (
    <g>
      <rect width="30" height="15" fill="#EF3340" />
      <rect y="15" width="30" height="15" fill="#fff" />
      <circle cx="9" cy="8" r="4" fill="#fff" />
      <circle cx="10.5" cy="8" r="4" fill="#EF3340" />
    </g>
  ),
  HKD: (
    <g>
      <rect width="30" height="30" fill="#DE2910" />
      {stars(15, 15, 5, 5, '#fff', 2.2)}
    </g>
  ),
  NOK: (
    <g>
      <rect width="30" height="30" fill="#BA0C2F" />
      <path d="M11 0V30M0 15H30" stroke="#fff" strokeWidth="7" />
      <path d="M11 0V30M0 15H30" stroke="#00205B" strokeWidth="3.5" />
    </g>
  ),
  SEK: (
    <g>
      <rect width="30" height="30" fill="#006AA7" />
      <path d="M11 0V30M0 15H30" stroke="#FECC02" strokeWidth="5" />
    </g>
  ),
  TRY: (
    <g>
      <rect width="30" height="30" fill="#E30A17" />
      <circle cx="13" cy="15" r="6" fill="#fff" />
      <circle cx="14.6" cy="15" r="4.8" fill="#E30A17" />
      <circle cx="20" cy="15" r="1.8" fill="#fff" />
    </g>
  ),
  PLN: (
    <g>
      <rect width="30" height="15" fill="#fff" />
      <rect y="15" width="30" height="15" fill="#DC143C" />
    </g>
  ),
  CNH: (
    <g>
      <rect width="30" height="30" fill="#DE2910" />
      <circle cx="9" cy="9" r="3.5" fill="#FFDE00" />
      {[[15, 5], [18, 8], [18, 12], [15, 15]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="1" fill="#FFDE00" />)}
    </g>
  ),
};

const METALS: Record<string, [string, string, string]> = { XAU: ['#f7d774', '#b8860b', 'Au'], XAG: ['#f1f5f9', '#94a3b8', 'Ag'], XPT: ['#e5e7eb', '#6b7280', 'Pt'], XPD: ['#e7e5e4', '#78716c', 'Pd'] };
const COIN_COLORS: Record<string, string> = { BTC: '#f7931a', ETH: '#627eea', SOL: '#9945ff', BNB: '#f3ba2f', XRP: '#23292f', ADA: '#0033ad', DOGE: '#c2a633', LTC: '#345d9d', AVAX: '#e84142', DOT: '#e6007a', LINK: '#2a5ada', TRX: '#ef0027', BCH: '#8dc351', ATOM: '#2e3148', NEAR: '#00c08b', UNI: '#ff007a', XLM: '#14b6e7', TON: '#0098ea' };

function Disc({ code, size }: { code: string; size: number }) {
  const metal = METALS[code];
  const id = `clip-${code}`;
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" className="shrink-0 rounded-full ring-2 ring-slate-950" aria-hidden>
      <defs>
        <clipPath id={id}>
          <circle cx="15" cy="15" r="15" />
        </clipPath>
        {metal && (
          <radialGradient id={`g-${code}`} cx="35%" cy="30%">
            <stop offset="0%" stopColor={metal[0]} />
            <stop offset="100%" stopColor={metal[1]} />
          </radialGradient>
        )}
      </defs>
      <g clipPath={`url(#${id})`}>
        {metal ? (
          <>
            <rect width="30" height="30" fill={`url(#g-${code})`} />
            <text x="15" y="19.5" textAnchor="middle" fontSize="12" fontWeight="800" fill="#1f2937">
              {metal[2]}
            </text>
          </>
        ) : (
          (FLAGS[code] ?? (
            <>
              <rect width="30" height="30" fill="#0284c7" />
              <text x="15" y="19" textAnchor="middle" fontSize="9" fontWeight="800" fill="#fff">
                {code}
              </text>
            </>
          ))
        )}
      </g>
    </svg>
  );
}

/** Icon for any market: two overlapping flags for forex, a coin for metals, a badge for crypto. */
export function MarketIcon({ symbol, size = 30 }: { symbol: string; size?: number }) {
  const [base, quote] = symbol.split('/');
  if (METALS[base]) return <Disc code={base} size={size} />;
  if (FLAGS[base] || (FLAGS[quote] && /^[A-Z]{3}$/.test(base) && !COIN_COLORS[base])) {
    const s = Math.round(size * 0.72);
    return (
      <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
        <span className="absolute top-0 left-0">
          <Disc code={base} size={s} />
        </span>
        <span className="absolute right-0 bottom-0">
          <Disc code={quote} size={s} />
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-black text-white" style={{ width: size, height: size, background: COIN_COLORS[base] ?? '#0284c7' }}>
      {base.slice(0, 3)}
    </span>
  );
}
