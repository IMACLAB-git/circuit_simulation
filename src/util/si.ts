/** SI-prefixed number formatting and parsing ("4.7k", "10u", "2meg"). */

const PREFIX: Record<string, number> = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, μ: 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, meg: 1e6, MEG: 1e6, g: 1e9, G: 1e9, t: 1e12, T: 1e12,
};

export function parseSI(text: string, fallback = 0): number {
  const s = String(text).trim().replace(/\s+/g, '');
  if (s === '') return fallback;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(meg|MEG|[fpnuµμmkKMgGtT])?/.exec(s);
  if (!m) return fallback;
  const base = parseFloat(m[1]);
  if (!isFinite(base)) return fallback;
  return m[2] ? base * PREFIX[m[2]] : base;
}

const UNITS = [
  { e: 1e12, p: 'T' }, { e: 1e9, p: 'G' }, { e: 1e6, p: 'M' }, { e: 1e3, p: 'k' },
  { e: 1, p: '' }, { e: 1e-3, p: 'm' }, { e: 1e-6, p: 'µ' }, { e: 1e-9, p: 'n' },
  { e: 1e-12, p: 'p' }, { e: 1e-15, p: 'f' },
];

/** Compact engineering notation, e.g. 4700 -> "4.7k", 1e-5 -> "10µ". */
export function formatSI(v: number, digits = 3): string {
  if (!isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const u = UNITS.find((x) => a >= x.e) ?? UNITS[UNITS.length - 1];
  const scaled = v / u.e;
  let s = scaled.toPrecision(digits);
  if (s.includes('.') && !s.includes('e')) s = s.replace(/\.?0+$/, '');
  return s + u.p;
}

/** Value + unit, e.g. formatUnit(4700, 'Ω') -> "4.7kΩ". */
export function formatUnit(v: number, unit: string, digits = 3): string {
  return formatSI(v, digits) + unit;
}
