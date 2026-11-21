/** 1234567 -> "1,234,567" (English UI). */
export function formatInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Revenue in IDR, Indonesian grouping as in the report spec: "Rp 1.250.000". */
export function formatRupiah(n: number): string {
  return `Rp ${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

export function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** A signed amount: "Rp 1.250.000", or "-Rp 1.250.000" for a loss (ROI net can be negative). */
export function formatRupiahSigned(n: number): string {
  return n < 0 ? `-${formatRupiah(-n)}` : formatRupiah(n);
}

/** Integer basis points as a percentage with up to two decimals ("12.5%", "0.05%"), "-" when there is no rate. */
export function formatBps(bps: number | null): string {
  if (bps === null) return "-";
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0$/, "");
  return `${String(whole)}${frac === "0" ? "" : `.${frac}`}%`;
}

const WIB_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const WIB_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short" });

/** "20 Nov, 14:05 WIB" */
export const formatWibTime = (at: Date): string => `${WIB_TIME.format(at)} WIB`;

/** "20 Nov" for a YYYY-MM-DD day. */
export const formatDay = (day: string): string => WIB_DAY.format(new Date(`${day}T12:00:00+07:00`));
