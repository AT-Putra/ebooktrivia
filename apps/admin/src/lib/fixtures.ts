const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Small deterministic PRNG so fixtures (and screenshots) never change between runs. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PRICE_IDR = 49_000;

export interface DayPoint {
  label: string;
  visits: number;
  mo: number;
  mt: number;
  revenue: number;
}

const dayRand = mulberry32(2611);

/** 30 days, Oct 13 to Nov 11 2026 (WIB). */
export const DAYS: DayPoint[] = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 13 + i));
  const wave = 1 + 0.18 * Math.sin(i / 2.6);
  const visits = Math.round((2300 + i * 28) * wave + dayRand() * 160);
  const mo = Math.round(visits * (0.095 + dayRand() * 0.02));
  const mt = Math.round(mo * (0.58 + dayRand() * 0.08));
  return {
    label: `${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}`,
    visits,
    mo,
    mt,
    revenue: mt * PRICE_IDR,
  };
});

export interface ChannelRow {
  id: string;
  landing: string;
  adnet: string;
  visits: number;
  mo: number;
  mt: number;
  revenue: number;
}

const LANDINGS = ["lp-nusantara-juara", "lp-sains-ceria", "lp-juara-sekolah"] as const;
const ADNETS = ["Alpha Ads", "Beta Media", "Gamma Click", "Direct", "Delta Push"] as const;
const rowRand = mulberry32(98);

export const CHANNELS: ChannelRow[] = Array.from({ length: 14 }, (_, i) => {
  const visits = Math.round(900 + rowRand() * 5200);
  const mo = Math.round(visits * (0.045 + rowRand() * 0.1));
  const mt = Math.round(mo * (0.42 + rowRand() * 0.4));
  return {
    id: `row-${i + 1}`,
    landing: LANDINGS[i % LANDINGS.length] ?? "",
    adnet: ADNETS[i % ADNETS.length] ?? "",
    visits,
    mo,
    mt,
    revenue: mt * PRICE_IDR,
  };
});

export function conversion(mo: number, mt: number): number {
  return mo === 0 ? 0 : (mt / mo) * 100;
}

export function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0);
}
