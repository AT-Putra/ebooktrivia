// {sapaan}: the greeting a WhatsApp opener starts with (Owner decision 2026-11-24). Rendered at send time from the clock in Jakarta
// (WIB, UTC+7, no daylight saving): 04:00-10:59 "Selamat pagi", 11:00-14:59 "Selamat siang", 15:00-17:59 "Selamat sore", 18:00-03:59
// "Selamat malam". With probability 1/3 the time of day is ignored and a casual "Halo" or "Hai" (equally likely) is used instead, so a
// number does not open every chat with the same time-bound greeting. Capitalised as written: it starts a sentence in the wordings.
// Pure: the caller supplies the time and the random source (the worker passes its cryptographic one).

export const SAPAAN_TIME_VALUES = ["Selamat pagi", "Selamat siang", "Selamat sore", "Selamat malam"] as const;
export const SAPAAN_CASUAL_VALUES = ["Halo", "Hai"] as const;
/** Everything {sapaan} can render as: the only values the renderer accepts for it. */
export const SAPAAN_VALUES: readonly string[] = [...SAPAAN_TIME_VALUES, ...SAPAAN_CASUAL_VALUES];
/** The chance that a casual greeting replaces the time-bound one. */
export const SAPAAN_CASUAL_CHANCE = 1 / 3;

const WIB_OFFSET_HOURS = 7;

/** The greeting of the time of day in Jakarta. */
export function sapaanForTime(now: Date): (typeof SAPAAN_TIME_VALUES)[number] {
  const hour = (now.getUTCHours() + WIB_OFFSET_HOURS) % 24;
  if (hour >= 4 && hour < 11) return "Selamat pagi";
  if (hour >= 11 && hour < 15) return "Selamat siang";
  if (hour >= 15 && hour < 18) return "Selamat sore";
  return "Selamat malam";
}

/** The value of {sapaan} for one message. `random` is uniform in [0, 1). */
export function sapaan(now: Date, random: () => number): string {
  if (random() < SAPAAN_CASUAL_CHANCE) return SAPAAN_CASUAL_VALUES[random() < 0.5 ? 0 : 1];
  return sapaanForTime(now);
}
