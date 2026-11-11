/** Indonesian thousands separator: 1240 -> "1.240". */
export function formatNumber(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function formatRupiah(n: number): string {
  return `Rp ${formatNumber(n)}`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** 3785 -> "63:05" (mm:ss, minutes may exceed 59). */
export function formatMinSec(totalSeconds: number): string {
  return `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`;
}

/** 11565 -> "03:12:45" (hh:mm:ss, hours may exceed 23). */
export function formatHms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
