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

const WIB_DATE = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", weekday: "short", day: "numeric", month: "short" });

/** The WIB calendar date of an instant, e.g. "Sab, 22 Nov" (the unlock schedule runs on WIB days). */
export function formatWibDate(at: Date): string {
  return WIB_DATE.format(at);
}

/** Milliseconds of answer time as mm:ss, rounded down to whole seconds (the leaderboard's and profile's time). */
export const formatMs = (ms: number): string => formatMinSec(Math.floor(Math.max(0, ms) / 1000));

/** 11565 -> "03:12:45" (hh:mm:ss, hours may exceed 23). */
export function formatHms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const DAY_SECONDS = 86_400;

/** 7_702_102 -> { days: 89, hms: "04:18:22" }: whole days and the rest as hh:mm:ss (0 days under a day; negative counts as 0). */
export function splitDaysHms(totalSeconds: number): { readonly days: number; readonly hms: string } {
  const s = Math.max(0, Math.floor(totalSeconds));
  return { days: Math.floor(s / DAY_SECONDS), hms: formatHms(s % DAY_SECONDS) };
}

const WIB_DEADLINE = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const WIB_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * A DEADLINE instant as the WIB weekday, date and clock time a player reads: { date: "Senin, 22 Maret 2027", time: "00.00" }.
 * A deadline at exactly 00:00 WIB is the end of the day before, so it reads as that day at 23.59 ("Minggu, 21 Maret 2027" and
 * "23.59": the player has all of the 21st, and "00.00 on the 22nd" is easy to take for the start of the 22nd). WIB has no
 * daylight saving, so midnight is a fixed offset; any other instant shows as it is.
 */
export function formatWibDeadline(at: Date): { readonly date: string; readonly time: string } {
  const midnight = (at.getTime() + WIB_OFFSET_MS) % DAY_MS === 0;
  const parts = WIB_DEADLINE.formatToParts(midnight ? new Date(at.getTime() - 60_000) : at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}`, time: `${part("hour").padStart(2, "0")}.${part("minute").padStart(2, "0")}` };
}
