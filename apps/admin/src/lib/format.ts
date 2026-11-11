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
